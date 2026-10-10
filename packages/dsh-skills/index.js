/**
 * dsh-skills — manage the harness's skill directories: list, enable, disable,
 * delete, and import (from other agent tool roots, or from a local ZIP).
 *
 * Ported from DSHDesktop's skills page. The desktop shell drove `skills/` and
 * `skills-disabled/` moves from a Tauri command; here the same two directories
 * are moved inside the dsh process, so the harness's own file watcher picks the
 * change up without a restart.
 *
 * @module dsh-skills/index
 */
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { guard, readJson, readRaw, sendJson, sendText } from "./lib/http.js";
import { resolveLayout } from "./lib/layout.js";
import {
	deleteSkill,
	importSkills,
	importZipSkills,
	inspectZipSkills,
	listImportable,
	listSkills,
	setSkillEnabled,
	skillStats
} from "./lib/skills.js";

const name = "skills";
const inject = ["commands"];
/** Shown in the panel and /api/skills; bump alongside package.json. */
const VERSION = "0.1.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-skills";
const SCRIPT_PATH = `${ROUTE_PREFIX}/panel.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/panel.css`;
/** ZIP uploads may be at most this large (skill packs are a few MB at most). */
const ZIP_UPLOAD_LIMIT = 64 * 1024 * 1024;
/** Uploaded archives are held in memory for this long between inspect and import. */
const ZIP_STASH_TTL_MS = 10 * 60 * 1000;
/** At most this many uploaded archives are stashed at once. */
const ZIP_STASH_MAX = 4;

/** Bundled assets served to the page. */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

/**
 * Create the plugin state: layout resolution (lazy — the config-editor service
 * may not be mounted yet when `apply` runs) plus the ZIP upload stash.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	/** Uploaded ZIPs awaiting an import decision: id → {buffer, name, at}. */
	const zipStash = new Map();
	const layout = () => {
		const configEditor = ctx.get("configEditor");
		if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
		return resolveLayout(configEditor);
	};
	return {
		layout,
		/** Remember an uploaded archive for the subsequent import call. */
		stashZip(buffer, archiveName) {
			const now = Date.now();
			for (const [id, entry] of zipStash) {
				if (now - entry.at > ZIP_STASH_TTL_MS) zipStash.delete(id);
			}
			while (zipStash.size >= ZIP_STASH_MAX) zipStash.delete(zipStash.keys().next().value);
			const id = randomBytes(8).toString("hex");
			zipStash.set(id, { buffer, name: archiveName, at: now });
			return id;
		},
		/** Take a stashed archive out (one-shot: it is consumed by the import). */
		takeZip(id) {
			const entry = zipStash.get(id);
			if (entry === undefined) return undefined;
			zipStash.delete(id);
			return entry;
		},
		log(message) {
			ctx.logger.info(`[dsh-skills] ${message}`);
		}
	};
}

/** Render skills as the one-line-per-item text a command returns. */
function renderRows(rows, empty) {
	if (rows.length === 0) return empty;
	return rows
		.map((row) => `${row.enabled ? "[x]" : "[ ]"} ${row.name}${row.description ? ` — ${row.description}` : ""}`)
		.join("\n");
}

/**
 * Wrap a command handler so a failure (most often a service this profile does
 * not mount) becomes an error result instead of an exception. A management
 * command should report why it could not run, not break the invocation.
 */
function command(fn) {
	return async (invocation) => {
		try {
			return await fn(invocation);
		} catch (error) {
			return { kind: "error", text: `dsh-skills: ${String(error?.message ?? error)}` };
		}
	};
}

/**
 * Register `/skills`. Guarded: command names are first-come, first-served, so a
 * clash with another plugin must degrade to a warning — an exception here would
 * take the whole plugin tree (i.e. dsh itself) down during `apply`.
 */
function registerCommands(ctx, state) {
	try {
		ctx.commands.register({
			name: "skills",
			description: "List skills and whether each is enabled (manage them in the dsh-skills panel)",
			handler: command(async () => {
				const skills = await listSkills(state.layout());
				const enabled = skills.filter((skill) => skill.enabled).length;
				return { kind: "success", text: `${skills.length} skill(s), ${enabled} enabled\n${renderRows(skills, "(no skills found)")}` };
			})
		});
	} catch (error) {
		const reason = String(error?.message ?? error);
		ctx.logger.warn(`[dsh-skills] command /skills not registered: ${reason}`);
	}
}

/** Apply a skill management action coming from the panel. */
async function handleAction(state, body) {
	if (body === undefined) throw new Error("expected a JSON body");
	const layout = state.layout();
	switch (body.action) {
		case "toggle": {
			const result = await setSkillEnabled(layout, body.name, body.enabled === true);
			state.log(`skill ${result.name} ${result.enabled ? "enabled" : "disabled"}`);
			return { ok: true, ...result };
		}
		case "delete": {
			const result = await deleteSkill(layout, body.name);
			state.log(`skill ${result.name} deleted`);
			return { ok: true, ...result };
		}
		case "import": {
			const result = await importSkills(layout, body.source, body.names, body.onConflict);
			state.log(`skills imported from ${body.source}: ${result.imported.length}`);
			return { ok: true, ...result };
		}
		case "import-zip": {
			const stash = state.takeZip(body.uploadId);
			if (stash === undefined) throw new Error("the uploaded archive expired — pick the file again");
			const result = await importZipSkills(layout, stash.buffer, stash.name, body.names, body.onConflict);
			state.log(`skills imported from zip ${stash.name}: ${result.imported.length}`);
			return { ok: true, ...result };
		}
		default:
			throw new Error(`unknown skills action: ${JSON.stringify(body.action)}`);
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
			sendText(res, 500, `dsh-skills: asset ${file} unavailable — ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, path) => {
		const method = req.method ?? "GET";
		if (path === "/api/skills" && method === "GET") {
			const layout = state.layout();
			const [skills, sources] = await Promise.all([listSkills(layout), listImportable(layout)]);
			return sendJson(res, 200, { ok: true, skills, sources, counts: await skillStats(layout), plugin: { name, version: VERSION } });
		}
		if (path === "/api/skills" && method === "POST") {
			return sendJson(res, 200, await handleAction(state, await readJson(req)));
		}
		if (path === "/api/skills/zip" && method === "POST") {
			// Step one of the ZIP import: the page uploads the archive, gets back
			// the discovered skills; step two is the "import-zip" action.
			const buffer = await readRaw(req, ZIP_UPLOAD_LIMIT);
			if (buffer === undefined) return sendJson(res, 413, { ok: false, error: `expected a ZIP body of at most ${String(ZIP_UPLOAD_LIMIT >> 20)} MiB` });
			const archiveName = new URL(req.url ?? "/", "http://x").searchParams.get("name") ?? "skills.zip";
			try {
				const skills = await inspectZipSkills(state.layout(), buffer, archiveName);
				return sendJson(res, 200, { ok: true, uploadId: state.stashZip(buffer, archiveName), skills });
			} catch (error) {
				return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
			}
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-skills route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === SCRIPT_PATH) return asset(res, "panel.js", "text/javascript; charset=utf-8");
			if (path === STYLE_PATH) return asset(res, "panel.css", "text/css; charset=utf-8");
			if (path.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, path.slice(ROUTE_PREFIX.length));
			return sendJson(res, 404, { ok: false, error: `no dsh-skills route for ${path}` });
		})
	}), "dsh-skills http routes");

	ready.effect(() => ready.on("webserver/index-inject", (table) => {
		table.push({ kind: "html", html: `<link rel="stylesheet" href="${STYLE_PATH}">`, placement: "head" });
		table.push({ kind: "script-src", src: SCRIPT_PATH, placement: "body" });
	}), "dsh-skills index injection");

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
