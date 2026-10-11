/**
 * dsh-doctor — harness diagnostics, inside dsh.
 *
 * Built to debug this repository's plugins and anything else installed beside them: it
 * captures the harness's own log records in-process (there is no log file to tail on
 * the official desktop app), lists every row of the plugin tree with its activation
 * state (a green boot does not mean a row loaded), and tails whichever log files do
 * exist. Panel plus `/doctor`.
 *
 * @module dsh-doctor/index
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachLogger, createRecordStore, RECORD_LIMIT, RECORD_WINDOW_MS } from "./capture.js";
import { collectDiagnostics, createLogRing, readLogFiles } from "./diagnostics.js";
import { guard, sendJson, sendText } from "./http.js";
import { resolveLayout } from "./layout.js";

const name = "doctor";
const inject = ["commands"];
/** Shown in the panel and /api/diagnostics; bump alongside package.json. */
const VERSION = "0.2.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-doctor";
const SCRIPT_PATH = `${ROUTE_PREFIX}/client.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/client.css`;

/** The browser half (client.js/client.css) is served from this directory. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Create the plugin state: layout resolution (lazy — the config-editor service
 * may not be mounted yet when `apply` runs), this plugin's log ring, and the
 * in-process capture.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	const ring = createLogRing();
	const store = createRecordStore();
	return {
		ring,
		/** `{ attached, boot, reason, store }`, filled in by `attachCapture`. */
		capture: { attached: false, boot: 0, reason: "not attached yet", store },
		layout() {
			const configEditor = ctx.get("configEditor");
			if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
			return resolveLayout(configEditor);
		},
		webServer: () => ctx.get("webServer"),
		sessions: () => ctx.get("sessions"),
		/** The loader service, which owns the plugin tree. Absent only outside a profile. */
		loader: () => ctx.get("loader"),
		log(message) {
			ring.add(message);
			ctx.logger.info(`[dsh-doctor] ${message}`);
		}
	};
}

/**
 * Start capturing the harness's log records. The disposer is tied to this plugin's
 * fiber through `ctx.effect`, so a reload takes the exporter with it.
 * @param ctx - plugin context.
 * @param state - plugin state.
 */
function attachCapture(ctx, state) {
	ctx.effect(() => {
		const result = attachLogger(ctx.logger, state.capture.store);
		state.capture.attached = result.attached;
		state.capture.boot = result.boot;
		state.capture.reason = result.reason;
		if (result.attached) state.log(`log capture attached, ${String(result.boot)} boot record(s) replayed`);
		else ctx.logger.warn(`[dsh-doctor] log capture unavailable: ${String(result.reason)}`);
		return () => {
			try {
				result.dispose?.();
			} catch {
				/* the service tearing down is allowed to have removed it already */
			}
		};
	}, "dsh-doctor log capture");
}

/** Collect the status document both the command and the route return. */
async function status(state) {
	return collectDiagnostics({
		webServer: state.webServer(),
		sessions: state.sessions(),
		layout: state.layout(),
		loader: state.loader(),
		capture: state.capture
	});
}

/**
 * The log payload. Records are the primary view; the log files are only re-read on a
 * full fetch, since a live poll asks for new records alone.
 * @param state - plugin state.
 * @param since - the newest record `sn` the caller already holds, or undefined.
 */
async function logs(state, since) {
	const captured = state.capture;
	const numeric = since === null || since === undefined || since === "" ? undefined : Number(since);
	// The window is sent along so the panel can say what it is looking at: a reader who
	// sees "47 records" deserves to know whether that is everything or a trimmed tail.
	const retention = { records: RECORD_LIMIT, minutes: Math.round(RECORD_WINDOW_MS / 60_000) };
	if (!captured.attached) {
		// Without a capture the ring is all there is. Its lines shift as it trims, so
		// there is no stable `sn` to resume from: every read is a full one.
		const records = state.ring.snapshot().map((text, index) => ({ sn: index + 1, name, type: "info", level: 1, text }));
		return { ok: true, source: "plugin", reason: captured.reason, reset: true, records, files: await readLogFiles(state.layout()), retention };
	}
	const selection = captured.store.select(Number.isFinite(numeric) ? numeric : undefined);
	const files = Number.isFinite(numeric) ? [] : await readLogFiles(state.layout());
	return { ok: true, source: "capture", reason: undefined, reset: selection.reset, records: selection.records, files, retention };
}

/** One row of the plugin tree, as `/doctor` prints it. */
function renderRow(row) {
	const marks = [row.state];
	if (row.disabled) marks.push("disabled");
	if (row.required) marks.push("required");
	return `  ${row.id} [${marks.join(", ")}] ${row.package}`;
}

/** The multi-line text `/doctor` answers with. */
function renderStatus(document, log) {
	const lines = [
		`dsh ${document.version} on node ${document.node}`,
		`state=${document.state} port=${document.port} pid=${document.pid} uptime=${document.uptimeSeconds}s rss=${document.memoryMb}MB`,
		`profile=${document.profile} sessions=${document.sessions ?? "?"}`,
		`dsh home: ${document.dshHome}`,
		`patch: ${document.patchPath}`,
		`rows: ${document.rowsSummary ?? "unavailable"}`,
		`capture: ${document.capture?.attached === true ? `${String(document.capture.records)} record(s), ${String(document.capture.boot)} from boot` : `unavailable (${String(document.capture?.reason ?? "?")})`}`
	];
	const noteworthy = (document.rows ?? []).filter((row) => row.state === "failed" || (row.required && row.state !== "active"));
	if (noteworthy.length > 0) lines.push("rows to look at:", ...noteworthy.slice(0, 12).map(renderRow));
	if ((document.logFiles ?? []).length > 0) lines.push("log files:", ...document.logFiles.map((file) => `  ${file.source}: ${file.path} (${String(file.lines)} lines)`));
	const tail = (log.records ?? []).slice(-10).map((record) => `${record.name} ${record.type}: ${record.text}`);
	if (tail.length > 0) lines.push("", `recent log (${log.source}):`, ...tail);
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
			description: "Show harness diagnostics: version, port, pid, plugin rows and recent log",
			handler: command(async () => {
				const document = await status(state);
				const log = await logs(state, undefined);
				return { kind: "success", text: renderStatus(document, log) };
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
			sendText(res, 200, await readFile(join(LIB_DIR, file), "utf8"), type);
		} catch (error) {
			sendText(res, 500, `dsh-doctor: asset ${file} unavailable — ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, url) => {
		// The prefix is this plugin's mount point, not part of its own route names.
		const path = url.pathname.slice(ROUTE_PREFIX.length);
		const method = req.method ?? "GET";
		if (path === "/api/diagnostics" && method === "GET") {
			const document = await status(state);
			return sendJson(res, 200, { ok: true, status: document, plugin: { name, version: VERSION } });
		}
		if (path === "/api/logs" && method === "GET") {
			return sendJson(res, 200, await logs(state, url.searchParams.get("since")));
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-doctor route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const url = new URL(req.url ?? "/", "http://x");
			if (url.pathname === SCRIPT_PATH) return asset(res, "client.js", "text/javascript; charset=utf-8");
			if (url.pathname === STYLE_PATH) return asset(res, "client.css", "text/css; charset=utf-8");
			if (url.pathname.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, url);
			return sendJson(res, 404, { ok: false, error: `no dsh-doctor route for ${url.pathname}` });
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
	attachCapture(ctx, state);
	registerCommands(ctx, state);
	ctx.inject(["webServer", "configEditor"], (ready) => {
		mount(ready, state);
	});
	state.log("host half wired");
}

export { apply, inject, name };
