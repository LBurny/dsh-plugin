/**
 * dsh-notify settings: load / merge / save `<DSH_HOME>/dsh-notify.json`.
 *
 * Deliberately a plain JSON file rather than a dsh settings namespace: the
 * browser half reads and writes it over this plugin's own HTTP routes, and a
 * patch-entry config would need a dsh restart (or an HMR round trip) for every
 * toggle. `writeFileAtomic` keeps concurrent saves from truncating.
 *
 * @module dsh-notify/lib/settings
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** The four reminder kinds, matching the desktop shell's classification. */
export const NOTIFY_KINDS = ["approval", "question", "turn_done", "answer_done"];

/** Bundled completion sound; the desktop shell's default is `staplebops-02`. */
export const DEFAULT_SOUND = "staplebops-02";

/**
 * Fresh-install settings.
 *
 * The two kinds that *block* the agent notify unconditionally, because a reader who
 * is looking at the window is usually looking at another session: dsh's own sidebar
 * carries an approval or a question, so "the page has focus" is no reason to believe
 * the reader has seen it, and a missed approval costs a stalled agent. The two
 * completion kinds keep deferring to the background, where a reminder is worth
 * raising and an interruption is not.
 */
export function defaultConfig() {
	return {
		approval: { enabled: true, timing: "always" },
		question: { enabled: true, timing: "always" },
		turn_done: { enabled: true, timing: "background" },
		answer_done: { enabled: true, timing: "background" },
		sound: DEFAULT_SOUND,
		volume: 0.7,
		/** In-page toast. */
		toast: true,
		/** Browser notification (needs the user to grant permission once). */
		browser: true
	};
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merge a patch over a base, returning a new value. Scalars replace
 * wholesale; plain objects merge key by key. A patch carrying one rule must not
 * drop the others.
 */
export function mergeDeep(base, patch) {
	if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
	const out = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] = isObject(value) && isObject(base[key]) ? mergeDeep(base[key], value) : value;
	}
	return out;
}

/** Clamp a numeric setting, falling back when the value is not usable. */
function clampNumber(value, min, max, fallback) {
	const num = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, num));
}

/**
 * Coerce untrusted input (the settings file, or a browser POST) into the shape
 * the panel expects. Anything malformed falls back to the default rather than
 * failing the whole save.
 * @param raw - candidate settings.
 * @returns fully populated, range-checked settings.
 */
export function normalizeConfig(raw) {
	const defaults = defaultConfig();
	const merged = mergeDeep(defaults, isObject(raw) ? raw : {});
	for (const kind of NOTIFY_KINDS) {
		const rule = merged[kind];
		merged[kind] = isObject(rule)
			? { enabled: rule.enabled !== false, timing: rule.timing === "always" ? "always" : "background" }
			: { ...defaults[kind] };
	}
	merged.volume = clampNumber(merged.volume, 0, 1, defaults.volume);
	merged.sound = typeof merged.sound === "string" && merged.sound.length > 0 ? merged.sound : DEFAULT_SOUND;
	merged.toast = merged.toast !== false;
	merged.browser = merged.browser !== false;
	return merged;
}

/** Read the settings file, tolerating a missing or corrupt file. */
export async function loadConfig(path) {
	try {
		return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return normalizeConfig(undefined);
	}
}

/** Atomically persist the settings. */
export async function saveConfig(path, config) {
	await writeFileAtomic(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 384 });
	return config;
}
