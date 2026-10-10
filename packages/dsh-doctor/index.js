/**
 * dsh-doctor — harness diagnostics, inside dsh.
 *
 * Ported from DSHDesktop's diagnostics page. Two log sources, best effort: the
 * desktop shell's unified `events.log` when this dsh runs under DSHDesktop, and
 * otherwise this plugin's own ring.
 *
 * @module dsh-doctor/index
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectDiagnostics, createLogRing, readLogs } from "./lib/diagnostics.js";
import { guard, sendJson, sendText } from "./lib/http.js";
import { resolveLayout } from "./lib/layout.js";

const name = "doctor";
const inject = ["commands"];
/** Shown in the panel and /api/diagnostics; bump alongside package.json. */
const VERSION = "0.1.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-doctor";
const SCRIPT_PATH = `${ROUTE_PREFIX}/panel.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/panel.css`;

/** Bundled assets served to the page. */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

/**
 * Create the plugin state: layout resolution (lazy — the config-editor service
 * may not be mounted yet when `apply` runs) plus this plugin's log ring.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	const ring = createLogRing();
	return {
		ring,
		layout() {
			const configEditor = ctx.get("configEditor");
			if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
			return resolveLayout(configEditor);
		},
		webServer: () => ctx.get("webServer"),
		sessions: () => ctx.get("sessions"),
		log(message) {
			ring.add(message);
			ctx.logger.info(`[dsh-doctor] ${message}`);
		}
	};
}

/** Collect the status document both the command and the route return. */
async function status(state) {
	return collectDiagnostics({
		webServer: state.webServer(),
		sessions: state.sessions(),
		layout: state.layout()
	});
}

/** The multi-line text `/doctor` answers with. */
function renderStatus(document, logs) {
	const lines = [
		`dsh ${document.version} on node ${document.node}`,
		`state=${document.state} port=${document.port} pid=${document.pid} uptime=${document.uptimeSeconds}s rss=${document.memoryMb}MB`,
		`profile=${document.profile} sessions=${document.sessions ?? "?"}`,
		`dsh home: ${document.dshHome}`,
		`patch: ${document.patchPath}`
	];
	const tail = logs.lines.slice(-10);
	if (tail.length > 0) lines.push("", `recent log (${logs.source}):`, ...tail);
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
			return { kind: "error", text: `dsh-doctor: ${String(error?.message ?? error)}` };
		}
	};
}

/**
 * Register `/doctor`. Guarded: command names are first-come, first-served, so a
 * clash with another plugin must degrade to a warning — an exception here would
 * take the whole plugin tree (i.e. dsh itself) down during `apply`.
 */
function registerCommands(ctx, state) {
	try {
		ctx.commands.register({
			name: "doctor",
			description: "Show harness diagnostics: version, port, pid, profile and log tail",
			handler: command(async () => {
				const [document, logs] = await Promise.all([status(state), readLogs(state.layout(), state.ring)]);
				return { kind: "success", text: renderStatus(document, logs) };
			})
		});
	} catch (error) {
		const reason = String(error?.message ?? error);
		ctx.logger.warn(`[dsh-doctor] command /doctor not registered: ${reason}`);
	}
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
			sendText(res, 200, await readFile(join(ASSETS_DIR, file), "utf8"), type);
		} catch (error) {
			sendText(res, 500, `dsh-doctor: asset ${file} unavailable — ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, path) => {
		const method = req.method ?? "GET";
		if (path === "/api/diagnostics" && method === "GET") {
			const document = await status(state);
			const logs = await readLogs(state.layout(), state.ring);
			return sendJson(res, 200, { ok: true, status: document, logs: { source: logs.source, path: logs.path }, plugin: { name, version: VERSION } });
		}
		if (path === "/api/logs" && method === "GET") {
			const logs = await readLogs(state.layout(), state.ring);
			return sendJson(res, 200, { ok: true, ...logs });
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-doctor route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === SCRIPT_PATH) return asset(res, "panel.js", "text/javascript; charset=utf-8");
			if (path === STYLE_PATH) return asset(res, "panel.css", "text/css; charset=utf-8");
			if (path.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, path.slice(ROUTE_PREFIX.length));
			return sendJson(res, 404, { ok: false, error: `no dsh-doctor route for ${path}` });
		})
	}), "dsh-doctor http routes");

	ready.effect(() => ready.on("webserver/index-inject", (table) => {
		table.push({ kind: "html", html: `<link rel="stylesheet" href="${STYLE_PATH}">`, placement: "head" });
		table.push({ kind: "script-src", src: SCRIPT_PATH, placement: "body" });
	}), "dsh-doctor index injection");

	state.log(`panel served at ${SCRIPT_PATH}`);
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
	state.log("host half wired");
}

export { apply, inject, name };
