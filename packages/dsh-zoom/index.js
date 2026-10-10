/**
 * dsh-zoom — page zoom with rebindable shortcuts.
 *
 * Ported from DSHDesktop, where zoom was a native WebView2 call plus a global
 * keyboard hook. Inside dsh there is no native window, so the zoom is CSS `zoom`
 * on the page's document element and the shortcuts are a capture-phase keydown
 * listener installed by the browser half.
 *
 * @module dsh-zoom/index
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { guard, readJson, sendJson, sendText } from "./lib/http.js";
import { resolveLayout } from "./lib/layout.js";
import { loadConfig, mergeDeep, normalizeConfig, saveConfig } from "./lib/settings.js";

const name = "zoom";
const inject = ["commands"];
/** Shown in the panel and /api/settings; bump alongside package.json. */
const VERSION = "0.1.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-zoom";
const SCRIPT_PATH = `${ROUTE_PREFIX}/panel.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/panel.css`;

/** Bundled assets served to the page. */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

/**
 * Create the plugin state: layout resolution (lazy — the config-editor service
 * may not be mounted yet when `apply` runs) and a cached settings document.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	/** Cached settings, invalidated by every write. */
	let cache;
	const layout = () => {
		const configEditor = ctx.get("configEditor");
		if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
		return resolveLayout(configEditor);
	};
	return {
		layout,
		/** Load settings, memoized until the next save. */
		async config() {
			if (cache === undefined) cache = await loadConfig(layout().configPath);
			return cache;
		},
		/** Persist a settings patch and refresh the memo. Deep-merged: a patch
		 * carrying one field must not drop the others. */
		async save(patch) {
			const current = await this.config();
			cache = await saveConfig(layout().configPath, normalizeConfig(patch === undefined ? current : mergeDeep(current, patch)));
			return cache;
		},
		log(message) {
			ctx.logger.info(`[dsh-zoom] ${message}`);
		}
	};
}

/** Describe one shortcut for a command's text output. */
function describeShortcut(shortcut) {
	const parts = [];
	if (shortcut.ctrl) parts.push("Ctrl");
	if (shortcut.shift) parts.push("Shift");
	if (shortcut.alt) parts.push("Alt");
	parts.push(shortcut.key === "" ? shortcut.code : shortcut.key);
	return parts.join("+");
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
			return { kind: "error", text: `dsh-zoom: ${String(error?.message ?? error)}` };
		}
	};
}

/**
 * Register `/zoom`. Guarded: command names are first-come, first-served, so a
 * clash with another plugin must degrade to a warning — an exception here would
 * take the whole plugin tree (i.e. dsh itself) down during `apply`.
 */
function registerCommands(ctx, state) {
	try {
		ctx.commands.register({
			name: "zoom",
			description: "Show the current page zoom level and shortcuts",
			handler: command(async () => {
				const config = await state.config();
				return {
					kind: "success",
					text: [
						`page zoom ${Math.round(config.level * 100)}% (step ${Math.round(config.step * 100)}%, range ${Math.round(config.min * 100)}–${Math.round(config.max * 100)}%)`,
						`zoom in: ${describeShortcut(config.in)}   zoom out: ${describeShortcut(config.out)}`,
						`settings: ${state.layout().configPath}`
					].join("\n")
				};
			})
		});
	} catch (error) {
		const reason = String(error?.message ?? error);
		ctx.logger.warn(`[dsh-zoom] command /zoom not registered: ${reason}`);
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
			sendText(res, 500, `dsh-zoom: asset ${file} unavailable — ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, path) => {
		const method = req.method ?? "GET";
		if (path === "/api/settings" && method === "GET") {
			return sendJson(res, 200, { ok: true, config: await state.config(), configPath: state.layout().configPath, plugin: { name, version: VERSION } });
		}
		if (path === "/api/settings" && method === "POST") {
			const body = await readJson(req);
			if (body === undefined) return sendJson(res, 400, { ok: false, error: "expected a JSON body" });
			const config = await state.save(body);
			state.log(`settings updated (level ${String(config.level)})`);
			return sendJson(res, 200, { ok: true, config });
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-zoom route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === SCRIPT_PATH) return asset(res, "panel.js", "text/javascript; charset=utf-8");
			if (path === STYLE_PATH) return asset(res, "panel.css", "text/css; charset=utf-8");
			if (path.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, path.slice(ROUTE_PREFIX.length));
			return sendJson(res, 404, { ok: false, error: `no dsh-zoom route for ${path}` });
		})
	}), "dsh-zoom http routes");

	ready.effect(() => ready.on("webserver/index-inject", (table) => {
		table.push({ kind: "html", html: `<link rel="stylesheet" href="${STYLE_PATH}">`, placement: "head" });
		table.push({ kind: "script-src", src: SCRIPT_PATH, placement: "body" });
	}), "dsh-zoom index injection");

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
}

export { apply, inject, name };
