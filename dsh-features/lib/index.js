/**
 * dsh-features — 功能管理: the shared home for this repository's feature plugins.
 *
 * This package is not a feature itself. It registers one sidebar entry
 * (功能管理, between the official 插件 and 自动化任务) whose page mounts every
 * installed feature plugin inline, under one skin. The page, the sidebar glyph
 * and the stylesheet live in the browser half (assets/client.js), which dsh's
 * own client module system serves — see `dsh.client` in package.json, and note
 * that the host row in cordis.patch.yml is what makes that bundle discoverable.
 *
 * The host half owns the two things a browser bundle cannot do:
 *
 *   `GET /dsh-features/api/status`
 *     The probe a feature panel uses to decide whether to dock its own corner
 *     button. Installed hub ⇒ the feature's UI is reachable from the hub page,
 *     so the floating button would be clutter; absent hub (this route 404s) ⇒
 *     standalone, which is also the case in a bare dsh with no hub at all.
 *
 *   `GET /dsh-features/api/features`
 *     The inventory: installed packages declaring the `dsh.ui.feature` marker.
 *     A feature the browser never registered can then be named on the page
 *     ("installed, but its panel did not load") instead of silently vanishing.
 *
 * @module dsh-features/index
 */
import { guard, sendJson } from "./http.js";
import { readInventory } from "./inventory.js";
import { resolveLayout } from "./layout.js";

const name = "features";
const inject = [];
/** Shown by /api/status; bump alongside package.json. */
const VERSION = "0.1.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-features";
const STATUS_PATH = `${ROUTE_PREFIX}/api/status`;
const FEATURES_PATH = `${ROUTE_PREFIX}/api/features`;

/**
 * Create the plugin state. Layout resolution is lazy: the config-editor service
 * may not be mounted yet when `apply` runs, and a profile without it degrades to
 * an empty inventory rather than a failed plugin.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	return {
		webServer: () => ctx.get("webServer"),
		log(message) {
			ctx.logger.info(`[dsh-features] ${message}`);
		}
	};
}

/**
 * Best-effort inventory. Any failure (no config-editor service, an unreadable
 * directory) yields an empty list plus the reason, never a 500: the page works
 * from the browser-side registry alone, so a missing inventory only costs the
 * "installed but not loaded" hint.
 * @param ctx - plugin context.
 * @returns the inventory document.
 */
async function inventory(ctx) {
	const configEditor = ctx.get("configEditor");
	if (configEditor === undefined) return { features: [], source: "unavailable: no config-editor service" };
	try {
		const layout = resolveLayout(configEditor);
		return { features: await readInventory(layout), source: layout.pluginsDir };
	} catch (error) {
		return { features: [], source: `unavailable: ${String(error?.message ?? error)}` };
	}
}

/**
 * Mount the HTTP surface.
 * @param ready - a context where `webServer` is available.
 * @param state - plugin state.
 * @param ctx - plugin context (for the lazy config-editor lookup).
 */
function mount(ready, state, ctx) {
	ready.effect(() => ready.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const method = req.method ?? "GET";
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === STATUS_PATH && method === "GET") {
				return sendJson(res, 200, { ok: true, hub: "dsh-features", route: ROUTE_PREFIX, version: VERSION });
			}
			if (path === FEATURES_PATH && method === "GET") {
				return sendJson(res, 200, { ok: true, ...(await inventory(ctx)) });
			}
			return sendJson(res, 404, { ok: false, error: `no dsh-features route for ${method} ${path}` });
		})
	}), "dsh-features http routes");

	state.log(`hub routes served: ${STATUS_PATH}, ${FEATURES_PATH}`);
}

/**
 * Plugin entry point.
 * @param ctx - plugin context.
 */
function apply(ctx) {
	const state = createState(ctx);
	ctx.inject(["webServer"], (ready) => mount(ready, state, ctx));
	state.log("host half wired");
}

export { apply, inject, name };
