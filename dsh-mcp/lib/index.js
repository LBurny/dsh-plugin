/**
 * dsh-mcp — manage MCP servers in the active profile's patch layer.
 *
 * Ported from DSHDesktop's MCP page. The desktop shell edited the same
 * `cordis.patch.yml` from a Tauri command; here the edit happens inside the dsh
 * process, through the `yaml` document API, so the harness's own loader
 * hot-reloads the new server without a restart.
 *
 * @module dsh-mcp/index
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { guard, readJson, sendJson, sendText } from "./http.js";
import { resolveLayout } from "./layout.js";
import {
	deleteMcpServer,
	importMcpServers,
	listMcpImportable,
	listMcpServers,
	mcpStats,
	setMcpEnabled,
	upsertMcpServer
} from "./mcp.js";

const name = "mcp";
const inject = ["commands"];
/** Shown in the panel and /api/mcp; bump alongside package.json. */
const VERSION = "0.1.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-mcp";
const SCRIPT_PATH = `${ROUTE_PREFIX}/client.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/client.css`;

/** The browser half (client.js/client.css) is served from this directory. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Create the plugin state. Layout resolution is lazy: the config-editor service
 * may not be mounted yet when `apply` runs.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	const layout = () => {
		const configEditor = ctx.get("configEditor");
		if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
		return resolveLayout(configEditor);
	};
	return {
		layout,
		log(message) {
			ctx.logger.info(`[dsh-mcp] ${message}`);
		}
	};
}

/** Render servers as the one-line-per-item text a command returns. */
function renderRows(rows, empty) {
	if (rows.length === 0) return empty;
	return rows
		.map((row) => `${row.enabled ? "[x]" : "[ ]"} ${row.serverName}${row.summary ? ` — ${row.summary}` : ""}`)
		.join("\n");
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
			return { kind: "error", text: `dsh-mcp: ${String(error?.message ?? error)}` };
		}
	};
}

/**
 * Register `/mcp`. Guarded: command names are first-come, first-served, so a
 * clash with another plugin must degrade to a warning — an exception here would
 * take the whole plugin tree (i.e. dsh itself) down during `apply`.
 */
function registerCommands(ctx, state) {
	try {
		ctx.commands.register({
			name: "mcp",
			description: "List MCP servers from the active profile's patch layer",
			handler: command(async () => {
				const servers = await listMcpServers(state.layout());
				const enabled = servers.filter((server) => server.enabled).length;
				return { kind: "success", text: `${servers.length} MCP server(s), ${enabled} enabled\n${renderRows(servers, "(no MCP servers configured)")}` };
			})
		});
	} catch (error) {
		const reason = String(error?.message ?? error);
		ctx.logger.warn(`[dsh-mcp] command /mcp not registered: ${reason}`);
	}
}

/** Apply an MCP management action coming from the panel. */
async function handleAction(state, body) {
	if (body === undefined) throw new Error("expected a JSON body");
	const layout = state.layout();
	switch (body.action) {
		case "upsert": {
			const result = await upsertMcpServer(layout, body.server, body.currentId);
			state.log(`mcp ${result.id} ${result.created ? "added" : "updated"}`);
			return { ok: true, ...result };
		}
		case "toggle": {
			const result = await setMcpEnabled(layout, body.id, body.enabled === true);
			state.log(`mcp ${result.id} ${result.enabled ? "enabled" : "disabled"}`);
			return { ok: true, ...result };
		}
		case "delete": {
			const result = await deleteMcpServer(layout, body.id);
			state.log(`mcp ${result.id} deleted`);
			return { ok: true, ...result };
		}
		case "import": {
			const result = await importMcpServers(layout, body.source, body.names, body.onConflict);
			state.log(`mcp servers imported from ${body.source}: ${result.imported.length}`);
			return { ok: true, ...result };
		}
		default:
			throw new Error(`unknown mcp action: ${JSON.stringify(body.action)}`);
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
			sendText(res, 200, await readFile(join(LIB_DIR, file), "utf8"), type);
		} catch (error) {
			sendText(res, 500, `dsh-mcp: asset ${file} unavailable: ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, path) => {
		const method = req.method ?? "GET";
		if (path === "/api/mcp" && method === "GET") {
			const layout = state.layout();
			const [servers, sources] = await Promise.all([listMcpServers(layout), listMcpImportable(layout)]);
			return sendJson(res, 200, {
				ok: true,
				servers,
				sources,
				counts: await mcpStats(layout),
				patchPath: layout.patchPath,
				plugin: { name, version: VERSION }
			});
		}
		if (path === "/api/mcp" && method === "POST") {
			return sendJson(res, 200, await handleAction(state, await readJson(req)));
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-mcp route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === SCRIPT_PATH) return asset(res, "client.js", "text/javascript; charset=utf-8");
			if (path === STYLE_PATH) return asset(res, "client.css", "text/css; charset=utf-8");
			if (path.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, path.slice(ROUTE_PREFIX.length));
			return sendJson(res, 404, { ok: false, error: `no dsh-mcp route for ${path}` });
		})
	}), "dsh-mcp http routes");

	ready.effect(() => ready.on("webserver/index-inject", (table) => {
		table.push({ kind: "html", html: `<link rel="stylesheet" href="${STYLE_PATH}">`, placement: "head" });
		table.push({ kind: "script-src", src: SCRIPT_PATH, placement: "body" });
	}), "dsh-mcp index injection");

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
