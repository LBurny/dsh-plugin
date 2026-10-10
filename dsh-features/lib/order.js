/**
 * The reader's own feature order, kept on the host.
 *
 * It used to live in `localStorage`, which is per-origin: the desktop shell reaches dsh
 * at `127.0.0.1:<port>` while the phone reaches the same dsh through the proxy at a
 * different origin, so a reorder on the desktop never reached the phone. The order is a
 * property of the reader, not of one browser, so it is stored beside the home instead and
 * served to every origin. The page still caches it locally to paint the right order on the
 * first frame; the host is what it reconciles against.
 *
 * @module dsh-features/lib/order
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** Field holding the order inside the data file. */
const FIELD = "navOrder";
/** A feature list longer than this is a malformed client, not a big profile. */
const MAX_KEYS = 256;
/** Feature keys are package-derived short ids. */
const MAX_KEY_LENGTH = 64;

/**
 * Coerce untrusted input into a usable order. Anything else (a non-array, junk entries,
 * an absurd length) is dropped entry by entry rather than failing the whole write: a
 * partially understood order still beats losing the reader's arrangement entirely.
 * @param raw - candidate value.
 * @returns a sanitized list of feature keys.
 */
export function normalizeOrder(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	const keys = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const key = item.trim();
		if (key === "" || key.length > MAX_KEY_LENGTH || seen.has(key)) continue;
		seen.add(key);
		keys.push(key);
		if (keys.length >= MAX_KEYS) break;
	}
	return keys;
}

/**
 * Read the saved order. A missing or corrupt file reads as "no saved order", which the
 * page renders as the default order — never as an error.
 * @param path - the hub's data file.
 * @returns the sanitized order.
 */
export async function loadNavOrder(path) {
	try {
		return normalizeOrder(JSON.parse(await readFile(path, "utf8"))?.[FIELD]);
	} catch {
		return [];
	}
}

/**
 * Persist the order atomically (a torn file would read as "no saved order" and quietly
 * reset the reader's arrangement on the next load).
 * @param path - the hub's data file.
 * @param keys - the order to save.
 * @returns the order that was written.
 */
export async function saveNavOrder(path, keys) {
	const order = normalizeOrder(keys);
	await writeFileAtomic(path, `${JSON.stringify({ [FIELD]: order }, null, "\t")}\n`, { mode: 384 });
	return order;
}
