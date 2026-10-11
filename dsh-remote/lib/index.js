/**
 * dsh-remote — phone remote access.
 *
 * dsh binds the loopback address only, and its browser session cookie is bound
 * to the authority it was issued for, so a remote authority (a LAN address, a
 * tunnel hostname) can never present a valid cookie. This plugin therefore runs
 * a small authenticated reverse proxy inside the dsh process: the phone talks to
 * the proxy, the proxy re-issues the request to dsh's own loopback address with a
 * cookie it holds. The cookie comes from the public API — a launch token from
 * `ctx.connection`, exchanged exactly the way the desktop shell does it.
 *
 * Ported from DSHDesktop's remote page, including its response-side work: the
 * mobile UI injection, the phone-side project browser, gzip, and the idle
 * keepalives that survive Cloudflare's ~100 s idle kill.
 *
 * @module dsh-remote/index
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCloudflaredInstaller } from "./cloudflared.js";
import { guard, readJson, sendJson, sendText } from "./http.js";
import { resolveLayout } from "./layout.js";
import { createQrRenderer } from "./qr.js";
import { createRemoteManager } from "./remote.js";
import { loadConfig, mergeDeep, normalizeConfig, saveConfig } from "./settings.js";

const name = "remote";
const inject = ["commands"];
/** Shown in the panel and /api/remote; bump alongside package.json. */
const VERSION = "0.2.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-remote";
const SCRIPT_PATH = `${ROUTE_PREFIX}/client.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/client.css`;
const QR_PATH = `${ROUTE_PREFIX}/qr.svg`;

/** The browser half (client.js/client.css) is served from this directory. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Create the plugin state: layout resolution (lazy — the config-editor service
 * may not be mounted yet when `apply` runs), the settings cache, the remote
 * manager and the QR renderer.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	/** Cached settings, invalidated by every write. */
	let cache;
	/** Saves serialize on this chain: two overlapping patches must merge onto each
	 * other, never onto the same stale base (the later write would drop the earlier). */
	let saving = Promise.resolve();
	const layout = () => {
		const configEditor = ctx.get("configEditor");
		if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
		return resolveLayout(configEditor);
	};
	const state = {
		layout,
		/** Load settings, memoized until the next save. */
		async config() {
			if (cache === undefined) cache = await loadConfig(layout().configPath);
			return cache;
		},
		/** Persist a settings patch and refresh the memo. */
		save(patch) {
			const run = saving.then(async () => {
				const current = await this.config();
				cache = await saveConfig(layout().configPath, normalizeConfig(patch === undefined ? current : mergeDeep(current, patch)));
				return cache;
			});
			// The chain itself must survive a failure, or every later save would reject.
			saving = run.catch(() => {});
			return run;
		},
		log(message) {
			ctx.logger.info(`[dsh-remote] ${message}`);
		}
	};
	// The manager resolves webServer/connection lazily, so it can be built here
	// and only fails (loudly, per request) if this profile lacks them.
	state.remote = createRemoteManager({
		ctx,
		layout,
		config: () => state.config(),
		save: (patch) => state.save(patch),
		log: (message) => state.log(message)
	});
	// Provisioning is its own object rather than part of the proxy manager: it answers
	// one question (is there a cloudflared binary, and if not, get one) and nothing else.
	state.cloudflared = createCloudflaredInstaller({
		layout,
		config: () => state.config(),
		save: (patch) => state.save(patch),
		log: (message) => state.log(message)
	});
	state.qr = createQrRenderer(layout);
	return state;
}

/** The status without the credential: the link is the credential, so it never leaves the panel. */
function publicStatus(status) {
	return {
		state: status.state,
		enabled: status.enabled,
		mode: status.mode,
		proxyPort: status.proxyPort,
		tunnel: status.tunnel?.state,
		resumed: status.resumed === true,
		error: status.error
	};
}

/** The multi-line text `/remote` answers with. */
function renderStatus(state_, status) {
	const lines = [
		`remote access: ${status.state}${status.enabled ? "" : " (off)"}`,
		`mode=${status.mode}${status.proxyPort === undefined ? "" : ` proxy port=${String(status.proxyPort)}`}${status.tunnel === undefined ? "" : ` tunnel=${status.tunnel.state}`}`
	];
	if (status.error !== undefined) lines.push(`error: ${status.error}`);
	if (status.enabled && status.link !== undefined) {
		// Deliberate: this is the one place the link is printed, and it is the
		// command the operator asked for. Do not log it anywhere.
		lines.push("", "link (treat it as a credential, do not share):", status.link);
	}
	lines.push(
		"",
		`cloudflared: ${state_.remote.cloudflared() ?? "not found"}${state_.cloudflared.status().source === undefined ? "" : ` (${state_.cloudflared.status().source})`}`,
		// Optional on purpose: the tailnet channel reads its address off the network
		// interfaces, so a missing CLI costs the MagicDNS name, not the channel.
		`tailscale: ${state_.remote.tailscale() ?? "the CLI was not found (not required)"}`,
		`settings: ${state_.layout().configPath}`
	);
	return lines.join("\n");
}

/**
 * Wrap a command handler so a failure (most often a service this profile does
 * not mount) becomes an error result instead of an exception.
 */
function command(fn) {
	return async (invocation) => {
		try {
			return await fn(invocation);
		} catch (error) {
			return { kind: "error", text: `dsh-remote: ${String(error?.message ?? error)}` };
		}
	};
}

/**
 * Register `/remote`. Guarded: command names are first-come, first-served, so a
 * clash with another plugin must degrade to a warning — an exception here would
 * take the whole plugin tree (i.e. dsh itself) down during `apply`.
 */
function registerCommands(ctx, state) {
	try {
		ctx.commands.register({
			name: "remote",
			description: "Show phone remote-access state, and the link when it is on",
			handler: command(async () => {
				await state.remote.sync();
				return { kind: "success", text: renderStatus(state, state.remote.snapshot()) };
			})
		});
	} catch (error) {
		const reason = String(error?.message ?? error);
		ctx.logger.warn(`[dsh-remote] command /remote not registered: ${reason}`);
	}
}

/** Apply a remote-access action coming from the panel. */
async function handleAction(state, body) {
	if (body === undefined) throw new Error("expected a JSON body");
	switch (body.action) {
		case "enable": {
			// The manager validates the mode name; passing it through unchanged is what
			// lets `tailnet` reach it (coercing here would fold it back to `tunnel`).
			const status = await state.remote.enable(body.mode);
			state.log(`remote access enabled (${status.mode})`);
			return { ok: true, remote: status };
		}
		case "disable": {
			const status = await state.remote.disable();
			return { ok: true, remote: status };
		}
		case "mode": {
			const status = await state.remote.setMode(body.mode);
			state.log(`remote mode set to ${status.mode}`);
			return { ok: true, remote: status };
		}
		case "reset-token": {
			const status = await state.remote.resetToken();
			return { ok: true, remote: status };
		}
		case "cloudflared": {
			// The tunnel needs a binary neither app ships; let the panel point at one
			// instead of sending the reader into a YAML file.
			const status = await state.remote.setCloudflaredPath(body.path);
			state.log("cloudflared path updated");
			return { ok: true, remote: status, cloudflared: state.remote.cloudflared() ?? null };
		}
		case "cloudflared-install": {
			// Started, not awaited: the download runs for seconds to minutes on a slow
			// link, and the panel polls the status it already reads.
			void provisionCloudflared(state);
			return { ok: true, remote: state.remote.snapshot(), cloudflaredSetup: state.cloudflared.status() };
		}
		case "cloudflared-proxy": {
			await state.cloudflared.setProxy(body.proxy);
			state.log("cloudflared proxy updated");
			// The manager memoizes its own settings snapshot, so without this the answer
			// would carry the value this very request just replaced.
			await state.remote.sync();
			return { ok: true, remote: state.remote.snapshot(), cloudflaredSetup: state.cloudflared.status() };
		}
		default:
			throw new Error(`unknown remote action: ${JSON.stringify(body.action)}`);
	}
}

/**
 * Provision cloudflared, then bring up a tunnel that was asked for before the binary
 * existed. The download runs in the background, so a reader can turn tunnel mode on
 * while it is still in flight and be told the binary is missing seconds before it lands;
 * asking the manager again once provisioning settles is what makes the channel work by
 * itself instead of waiting to be toggled. Floating and non-fatal on purpose: a machine
 * with no network still boots a working plugin.
 * @param state - plugin state.
 */
function provisionCloudflared(state) {
	return state.cloudflared
		.ensure()
		.then(() => state.remote.startTunnel())
		.catch((error) => state.log(`cloudflared setup failed: ${String(error?.message ?? error)}`));
}

/**
 * Mount the HTTP surface and the panel injection.
 * @param ready - a context where `webServer` and `configEditor` are both available.
 * @param state - plugin state.
 */
function mount(ready, state) {
	const { webServer } = ready;

	const asset = async (res, file, type) => {
		try {
			sendText(res, 200, await readFile(join(LIB_DIR, file), "utf8"), type);
		} catch (error) {
			sendText(res, 500, `dsh-remote: asset ${file} unavailable: ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, path) => {
		const method = req.method ?? "GET";
		if (path === "/api/remote" && method === "GET") {
			await state.remote.sync();
			return sendJson(res, 200, {
				ok: true,
				remote: state.remote.snapshot(),
				qrAvailable: state.qr.available(),
				qrPath: QR_PATH,
				configPath: state.layout().configPath,
				cloudflared: state.remote.cloudflared() ?? null,
				cloudflaredSetup: state.cloudflared.status(),
				plugin: { name, version: VERSION }
			});
		}
		if (path === "/api/remote" && method === "POST") {
			return sendJson(res, 200, await handleAction(state, await readJson(req)));
		}
		// A summarized status for the diagnostics-minded; no link, no token.
		if (path === "/api/status" && method === "GET") {
			await state.remote.sync();
			return sendJson(res, 200, { ok: true, status: publicStatus(state.remote.snapshot()) });
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-remote route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === SCRIPT_PATH) return asset(res, "client.js", "text/javascript; charset=utf-8");
			if (path === STYLE_PATH) return asset(res, "client.css", "text/css; charset=utf-8");
			if (path === QR_PATH) {
				const snapshot = state.remote.snapshot();
				const payload = snapshot.link ?? snapshot.lanUrls?.[0];
				if (payload === undefined) return sendJson(res, 409, { ok: false, error: "remote access is not enabled yet" });
				const svg = await state.qr.svg(payload);
				if (svg === undefined) return sendJson(res, 501, { ok: false, error: "the qrcode package is not installed; run: dsh plugin --profile web add dsh-remote" });
				return sendText(res, 200, svg, "image/svg+xml; charset=utf-8");
			}
			if (path.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, path.slice(ROUTE_PREFIX.length));
			return sendJson(res, 404, { ok: false, error: `no dsh-remote route for ${path}` });
		})
	}), "dsh-remote http routes");

	ready.effect(() => ready.on("webserver/index-inject", (table) => {
		table.push({ kind: "html", html: `<link rel="stylesheet" href="${STYLE_PATH}">`, placement: "head" });
		table.push({ kind: "script-src", src: SCRIPT_PATH, placement: "body" });
	}), "dsh-remote index injection");

	// On unload, stop supervising the tunnel but leave it running: its hostname is the
	// phone's link, and a fresh quick tunnel would hand out a different one.
	ready.effect(() => () => state.remote.suspend(), "dsh-remote keep the tunnel alive");

	state.log(`panel served at ${SCRIPT_PATH}`);

	// Install cloudflared when this machine has none, so the tunnel channel works the
	// moment the plugin is installed instead of asking the reader for a path.
	void provisionCloudflared(state);
}

/**
 * Bring remote access back up after a restart, when it was enabled before. The
 * token is persisted, so the link a phone already saved keeps working.
 */
async function resume(state) {
	const config = await state.config();
	if (config.enabled !== true) return;
	try {
		const status = await state.remote.enable(config.mode);
		state.log(`remote access resumed (${config.mode}, state ${status.state})`);
	} catch (error) {
		state.log(`remote resume failed: ${String(error?.message ?? error)}`);
	}
}

/**
 * Plugin entry point.
 * @param ctx - plugin context (declares `commands`).
 */
function apply(ctx) {
	const state = createState(ctx);
	registerCommands(ctx, state);
	ctx.inject(["webServer", "configEditor"], (ready) => {
		mount(ready, state);
	});
	// Resume separately, and only once `connection` is mounted: at first boot it
	// is not there yet, and a missing remote must never take the rest of the
	// plugin down with it.
	ctx.inject(["connection", "webServer"], () => {
		void resume(state).catch((error) => state.log(`remote resume error: ${String(error?.message ?? error)}`));
	});
}

export { apply, inject, name };
