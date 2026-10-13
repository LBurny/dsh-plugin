/**
 * Diagnostics: service status, environment facts, the plugin tree, and log tails.
 *
 * The logs this panel shows come from three places:
 *  1. The in-process capture (`capture.js`) — every record the harness's logger
 *     emitted, from every plugin. This is the one source that exists on the official
 *     desktop app, which writes no log file at all.
 *  2. Any log file that happens to exist: the desktop shell's unified `events.log`
 *     under DSHDesktop, a `logs/startup-*.log` written only when a required row failed
 *     to activate, the remote plugin's tunnel log, and the app's own crash report.
 *  3. This plugin's own ring, which always exists and records its lifecycle actions.
 *
 * @module dsh-doctor/lib/diagnostics
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";

import { collectRows, REQUIRED_ROW_IDS, summarizeRows } from "./rows.js";

/** Log lines kept in the in-memory ring. */
const RING_LIMIT = 500;
/** Bytes read from the tail of a log file; matches the desktop shell's own cap. */
const LOG_FILE_MAX_BYTES = 512 * 1024;
/** Lines returned from a log file tail. */
const LOG_FILE_MAX_LINES = 200;

/**
 * A bounded in-memory log. Timestamped like the shell's own lines so a
 * plugin-supplied tail reads the same as a shell-supplied one.
 */
export function createLogRing(limit = RING_LIMIT) {
	const lines = [];
	return {
		/** Append one line, prefixed with the wall clock. */
		add(message) {
			const now = new Date();
			const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
			lines.push(`[${stamp}] [dsh-doctor] ${message}`);
			if (lines.length > limit) lines.splice(0, lines.length - limit);
		},
		/** Snapshot the ring, oldest first. */
		snapshot() {
			return [...lines];
		}
	};
}

/**
 * Read the tail of a file without loading it whole.
 * @param path - file to read.
 * @param maxBytes - how much of the end to read.
 * @returns the trailing lines, or `undefined` when the file is absent.
 */
async function readTail(path, maxBytes) {
	let info;
	try {
		info = await stat(path);
	} catch {
		return undefined;
	}
	const start = Math.max(0, info.size - maxBytes);
	const length = info.size - start;
	let handle;
	try {
		handle = await open(path, "r");
	} catch {
		// A log can vanish between the `stat` above and this open (rotation, a tunnel log
		// being rewritten), or refuse to be opened at all. Every candidate is optional, so
		// this one is simply not a source: letting it throw takes the whole diagnostics
		// response down instead.
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(length);
		// A file can shrink between the `stat` above and this read (log rotation, a tunnel
		// log being rewritten), in which case fewer bytes come back and the tail of the
		// buffer is still zeros: decoding all of it appends a line of NULs to the panel.
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
		// A byte-window read usually lands mid-line; drop that fragment.
		if (start > 0) lines.shift();
		return lines.filter((line) => line.length > 0);
	} finally {
		await handle.close();
	}
}

/**
 * The newest file in `dir` whose name matches `pattern`, or undefined.
 * @param dir - directory to scan.
 * @param pattern - name test.
 */
async function newestFile(dir, pattern) {
	if (typeof dir !== "string" || dir === "") return undefined;
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	let newest;
	let newestAt = -Infinity;
	for (const name of names) {
		if (!pattern.test(name)) continue;
		try {
			const info = await stat(join(dir, name));
			if (info.mtimeMs > newestAt) {
				newestAt = info.mtimeMs;
				newest = join(dir, name);
			}
		} catch {
			/* a file that vanished between readdir and stat is simply not a candidate */
		}
	}
	return newest;
}

/**
 * Every log file this machine actually has, with its tail. Each candidate is optional:
 * a bare `~/.dsh` setup has none of them, and that is the normal case on the official
 * app, which writes no log file while it runs.
 * @param layout - resolved paths.
 * @returns `[{ source, path, lines }]`, in the order the panel lists them.
 */
export async function readLogFiles(layout) {
	const home = layout?.dshHome;
	const appData = process.env.APPDATA;
	const candidates = [
		/** The desktop shell's unified log, written next to its DSH home. */
		{ source: "shell", path: layout?.shellLogPath },
		/** dsh's own failure report, written only when a required row failed to activate. */
		{ source: "startup", path: await newestFile(typeof home === "string" ? join(home, "logs") : undefined, /^startup-.*\.log$/u) },
		/** The remote plugin's tunnel log (cloudflared's own output). */
		{ source: "tunnel", path: typeof home === "string" ? join(home, "dsh-remote-tunnel.log") : undefined },
		/** The desktop app's crash report, written before its recovery dialog. */
		{ source: "crash", path: await newestFile(typeof appData === "string" ? join(appData, "@deepseek-ai", "dsh-desktop", "logs") : undefined, /^crash-.*\.log$/u) }
	];
	const files = [];
	for (const candidate of candidates) {
		if (typeof candidate.path !== "string" || candidate.path === "") continue;
		const lines = await readTail(candidate.path, LOG_FILE_MAX_BYTES);
		if (lines === undefined) continue;
		files.push({ source: candidate.source, path: candidate.path, lines: lines.slice(-LOG_FILE_MAX_LINES) });
	}
	return files;
}

/** Count sessions, tolerating a service that is not mounted. */
function sessionCount(sessions) {
	try {
		const list = sessions?.list?.();
		return Array.isArray(list) ? list.length : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Assemble the diagnostics payload.
 * @param options - web server, session registry, the resolved layout, the loader
 *   service, and the capture state (`{ attached, reason, boot, store }`).
 * @returns a JSON-serializable status document.
 */
export async function collectDiagnostics({ webServer, sessions, layout, loader, capture }) {
	const memory = process.memoryUsage();
	const collected = collectRows(loader);
	const files = await readLogFiles(layout);
	return {
		state: "ready",
		version: getDshRuntimeVersion(),
		node: process.version,
		pid: process.pid,
		uptimeSeconds: Math.round(process.uptime()),
		memoryMb: Math.round(memory.rss / (1024 * 1024)),
		port: webServer?.port,
		host: webServer?.host,
		profile: layout.profileName,
		profileDir: layout.profileDir,
		dshHome: layout.dshHome,
		patchPath: layout.patchPath,
		sessions: sessionCount(sessions),
		platform: process.platform,
		arch: process.arch,
		rows: collected.rows,
		rowsAvailable: collected.available,
		rowsReason: collected.reason,
		rowsSummary: summarizeRows(collected),
		rowsActive: collected.rows.filter((row) => row.state === "active").length,
		rowsTotal: collected.rows.length,
		rowsFailed: collected.rows.filter((row) => row.state === "failed").map((row) => row.id),
		requiredRowIds: REQUIRED_ROW_IDS,
		logFiles: files.map((file) => ({ source: file.source, path: file.path, lines: file.lines.length })),
		capture: capture === undefined
			? undefined
			// `records` and `bytes` are the ring's occupancy against the budget the logs
			// route reports, so a reader can tell how close the history is to being trimmed.
			: { attached: capture.attached === true, reason: capture.reason, boot: capture.boot ?? 0, records: capture.store?.count ?? 0, bytes: capture.store?.bytes ?? 0 }
	};
}
