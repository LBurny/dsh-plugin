/**
 * Atomic file replacement, owned by this plugin.
 *
 * dsh ships `@deepseek-ai/dsh-atomic-write`, and this plugin used to import it at
 * module scope. That import sits in the entry's import chain, so a dsh release that
 * renames or drops the package takes the whole row down with it, silently: dsh prints
 * one `N entries did not activate` and boots on, and the reader finds the panel gone
 * with nothing pointing at this package. The contract this plugin needs is small
 * enough to own, so it owns it. Semantics follow the upstream implementation:
 * a random-suffix sibling created with `wx` (exclusive create, which refuses to follow
 * a symlink planted at the temp path), the caller's mode carried on that fresh inode
 * (so replacing a wider-permission file narrows it without a chmod race), then a rename
 * over the target, which is atomic because both paths are in one directory. Windows
 * reports transient sharing violations on `rename` as EACCES/EBUSY/EPERM, so those are
 * retried for a bounded interval with the complete temp file still in place. Crash
 * durability (fsync) is out of scope upstream as well, so it stays out of scope here.
 *
 * @module dsh-remote/lib/atomic
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Error codes Windows reports for temporary interference with a replacement. */
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RETRY_FIRST_MS = 20;
const RETRY_MAX_MS = 200;
const RETRY_LIMIT = 8;
/** Default permission bits: owner-only, which is what every file here wants. */
const DEFAULT_MODE = 0o600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replace `filename` with `content` in one atomic step, creating parent directories.
 * @param filename - the final path receiving the content.
 * @param content - the complete next content of the file.
 * @param options - `mode`, the permission bits of the replacement inode.
 */
export async function writeFileAtomic(filename, content, options = {}) {
	const mode = typeof options.mode === "number" ? options.mode : DEFAULT_MODE;
	const directory = dirname(filename);
	const temp = join(directory, `.${randomBytes(6).toString("hex")}.tmp`);
	await mkdir(directory, { recursive: true });
	try {
		await writeFile(temp, content, { mode, flag: "wx" });
		let delay = RETRY_FIRST_MS;
		for (let retries = 0; ; retries += 1) {
			try {
				await rename(temp, filename);
				return;
			} catch (error) {
				const transient = process.platform === "win32" && TRANSIENT_RENAME_CODES.has(error?.code ?? "");
				if (!transient || retries >= RETRY_LIMIT) throw error;
			}
			await sleep(delay);
			delay = Math.min(delay * 2, RETRY_MAX_MS);
		}
	} catch (error) {
		// Never leave the half-written sibling behind for the next reader to find.
		await rm(temp, { force: true });
		throw error;
	}
}
