/**
 * The live-session record that keeps a phone link stable across dsh restarts.
 *
 * A Cloudflare *quick* tunnel gets a fresh random hostname every time cloudflared
 * starts, so the link (the credential) changes on every restart and the reader has to
 * re-scan the QR code. The desktop shell solves this by leaving the tunnel process
 * alive on exit and adopting it on the next start, so the hostname (and therefore the
 * link) is byte-identical. This plugin does the same, and this file is what makes it
 * possible: it records which tunnel is ours, where it points, and which binary runs it.
 *
 * It holds no credential (the token lives in the settings file, and never leaves the
 * process in logs), so it is a plain JSON file next to `dsh-remote.json`.
 *
 * @module dsh-remote/lib/session
 */
import { readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic.js";

/**
 * Read the session record.
 * @param path - `<DSH_HOME>/dsh-remote-session.json`.
 * @param read - file reader, injectable for tests.
 * @returns the record, or undefined when there is none (or it is unreadable/junk).
 */
export function loadSession(path, read = readFileSync) {
	let text;
	try {
		text = read(path, "utf8");
	} catch {
		// Missing is the normal case on a first start.
		return undefined;
	}
	let parsed;
	try {
		parsed = JSON.parse(String(text));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { tunnelUrl, tunnelPid, cloudflaredExe, target } = parsed;
	// A record missing any of these cannot be adopted, so it is worth nothing.
	if (typeof tunnelUrl !== "string" || tunnelUrl.length === 0) return undefined;
	if (!Number.isInteger(tunnelPid) || tunnelPid <= 0) return undefined;
	if (typeof cloudflaredExe !== "string" || cloudflaredExe.length === 0) return undefined;
	if (typeof target !== "string" || target.length === 0) return undefined;
	return { tunnelUrl, tunnelPid, cloudflaredExe, target };
}

/**
 * Write the session record. 0600, like the settings file: it names a process and a
 * public hostname, which is nobody else's business.
 * @param path - `<DSH_HOME>/dsh-remote-session.json`.
 * @param state - `{ tunnelUrl, tunnelPid, cloudflaredExe, target }`.
 */
export function saveSession(path, state) {
	return writeFileAtomic(path, `${JSON.stringify(state, null, "\t")}\n`, { mode: 384 });
}

/**
 * Forget the session — used when the reader disables remote access, or when the
 * tunnel we recorded is gone and we are starting a fresh one anyway.
 * @param path - `<DSH_HOME>/dsh-remote-session.json`.
 * @param remove - file remover, injectable for tests.
 */
export function clearSession(path, remove = rmSync) {
	try {
		remove(path, { force: true });
	} catch {
		/* already gone */
	}
}

/**
 * Whether a recorded session is worth adopting.
 *
 * All three have to agree, because adopting a tunnel that points somewhere else is
 * worse than starting a new one: the link would answer with a 502. The binary check
 * also guards a reinstall in place, where the recorded path is a different file.
 *
 * @param saved - a record from `loadSession`.
 * @param current - `{ exe, target }` for the tunnel we would start now.
 * @returns true when the recorded tunnel can be reused as-is.
 */
export function canAdopt(saved, current) {
	if (saved === undefined) return false;
	return saved.cloudflaredExe === current.exe && saved.target === current.target;
}
