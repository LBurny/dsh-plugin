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
 * The host half owns the things a browser bundle cannot do:
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
 *     The last update check rides along, so a reloaded page keeps its badges
 *     without a new round trip.
 *
 *   `GET /dsh-features/api/updates`
 *     Ask every install source whether it has moved past the commit the profile
 *     pinned (see lib/updates.js). Read-only, and the one route that talks to the
 *     network: which is why the page asks for it on a refresh, never on load.
 *
 *   `POST /dsh-features/api/update`
 *     Apply that for the named packages, through the plugin manager's own pnpm
 *     runner. The new code is on disk afterwards, and a restart is what loads it.
 *     The answer carries `updatedSelf` when the hub itself was among them, because
 *     the page that receives it is then still the old build.
 *
 * @module dsh-features/index
 */
import { readFileSync } from "node:fs";
import { guard, readJson, sendJson } from "./http.js";
import { readInventory } from "./inventory.js";
import { resolveLayout } from "./layout.js";
import { loadNavOrder, saveNavOrder } from "./order.js";
import { applyUpdates, checkUpdates, readSources } from "./updates.js";

const name = "features";
const inject = [];
/** Shown by /api/status; bump alongside package.json. */
const VERSION = "0.1.0";

/**
 * This package's own name and version, read from its manifest. The hub is not a
 * feature, so it has no row on its own page, but it is installed from a source
 * like everything else and the Plugins page cannot update it: the update check
 * covers it by name. The version is what a `file:` install is compared by, since
 * that source carries no commit; an unreadable manifest costs the name's fallback
 * and leaves the version undefined, which the check reports as unknown.
 */
const { HUB_PACKAGE, HUB_VERSION } = (() => {
	try {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return { HUB_PACKAGE: manifest.name ?? "dsh-features", HUB_VERSION: typeof manifest.version === "string" ? manifest.version : undefined };
	} catch {
		return { HUB_PACKAGE: "dsh-features", HUB_VERSION: undefined };
	}
})();

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-features";
const STATUS_PATH = `${ROUTE_PREFIX}/api/status`;
const FEATURES_PATH = `${ROUTE_PREFIX}/api/features`;
const ORDER_PATH = `${ROUTE_PREFIX}/api/order`;
const UPDATES_PATH = `${ROUTE_PREFIX}/api/updates`;
const UPDATE_PATH = `${ROUTE_PREFIX}/api/update`;

/**
 * Create the plugin state. Layout resolution is lazy: the config-editor service
 * may not be mounted yet when `apply` runs, and a profile without it degrades to
 * an empty inventory rather than a failed plugin.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	return {
		/** The last update check, so a reloaded page keeps the badges it saw. */
		lastCheck: undefined,
		webServer: () => ctx.get("webServer"),
		log(message) {
			ctx.logger.info(`[dsh-features] ${message}`);
		}
	};
}

/** Drop the packages an update just brought up to date from a cached check. */
function withoutPackages(report, packages) {
	if (report === undefined) return undefined;
	const updated = new Set(packages);
	return {
		...report,
		packages: report.packages.filter((row) => !updated.has(row.package)),
		updatable: report.updatable.filter((packageName) => !updated.has(packageName))
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
	if (configEditor === undefined) return { features: [], navOrder: [], source: "unavailable: no config-editor service" };
	try {
		const layout = resolveLayout(configEditor);
		// The order rides along with the inventory: the page already asks once at boot, and
		// a second round trip would only add a frame where the list is in the wrong order.
		const [features, navOrder] = await Promise.all([readInventory(layout), loadNavOrder(layout.orderPath)]);
		return { features, navOrder, source: layout.pluginsDir };
	} catch (error) {
		return { features: [], navOrder: [], source: `unavailable: ${String(error?.message ?? error)}` };
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
				return sendJson(res, 200, { ok: true, ...(await inventory(ctx)), updates: state.lastCheck });
			}
			if (path === UPDATES_PATH && method === "GET") {
				// The one route that reaches the network: one `git ls-remote` per distinct
				// source repository, so a shared monorepo costs one round trip, not seven.
				const configEditor = ctx.get("configEditor");
				if (configEditor === undefined) return sendJson(res, 400, { ok: false, error: "no config-editor service" });
				const report = await checkUpdates((await inventory(ctx)).features, {
					layout: resolveLayout(configEditor),
					self: HUB_PACKAGE,
					selfVersion: HUB_VERSION
				});
				state.lastCheck = report;
				state.log(`update check: ${report.updatable.length} of ${report.packages.length} behind`);
				return sendJson(res, 200, { ok: true, ...report });
			}
			if (path === UPDATE_PATH && method === "POST") {
				const body = await readJson(req);
				if (body === undefined) return sendJson(res, 400, { ok: false, error: "expected a JSON body" });
				// Only packages this profile installs can be updated here. The features come
				// from the inventory; the hub's own name is accepted when the profile
				// declares it, because it is installed from a source like everything else.
				const configEditor = ctx.get("configEditor");
				if (configEditor === undefined) return sendJson(res, 400, { ok: false, error: "no config-editor service" });
				const installed = new Set((await inventory(ctx)).features.map((feature) => feature.package));
				if ((await readSources(resolveLayout(configEditor))).sources.has(HUB_PACKAGE)) installed.add(HUB_PACKAGE);
				const wanted = (Array.isArray(body.packages) ? body.packages : []).filter((packageName) => installed.has(packageName));
				if (wanted.length === 0) return sendJson(res, 400, { ok: false, error: "no installed package names the request" });
				const outcome = await applyUpdates(wanted, { manager: ctx.get("pluginManager") });
				if (outcome.ok !== true) {
					state.log(`update of ${wanted.join(", ")} failed: ${outcome.reason ?? ""} ${outcome.error ?? ""}`.trim());
					return sendJson(res, 502, { ok: false, ...outcome, updates: state.lastCheck });
				}
				state.lastCheck = withoutPackages(state.lastCheck, outcome.packages);
				state.log(`updated ${outcome.packages.join(", ")}; restart required`);
				// When the hub updated itself the page running this answer is the old
				// build, so the client says so instead of the generic restart message.
				return sendJson(res, 200, { ok: true, ...outcome, updatedSelf: outcome.packages.includes(HUB_PACKAGE), updates: state.lastCheck });
			}
			if (path === ORDER_PATH && method === "POST") {
				// The reader's arrangement, shared by every browser that reaches this dsh:
				// the desktop shell and the phone are different origins, so this cannot live
				// in one browser's storage.
				const configEditor = ctx.get("configEditor");
				if (configEditor === undefined) return sendJson(res, 400, { ok: false, error: "no config-editor service" });
				const body = await readJson(req);
				if (body === undefined) return sendJson(res, 400, { ok: false, error: "expected a JSON body" });
				const navOrder = await saveNavOrder(resolveLayout(configEditor).orderPath, body.keys);
				return sendJson(res, 200, { ok: true, navOrder });
			}
			return sendJson(res, 404, { ok: false, error: `no dsh-features route for ${method} ${path}` });
		})
	}), "dsh-features http routes");

	state.log(`hub routes served: ${STATUS_PATH}, ${FEATURES_PATH}, ${UPDATES_PATH}, ${UPDATE_PATH}, ${ORDER_PATH}`);
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
