/**
 * dsh-zoom settings: load / merge / save `<DSH_HOME>/dsh-zoom.json`.
 *
 * Deliberately a plain JSON file rather than a dsh settings namespace: the
 * browser half reads and writes it over this plugin's own HTTP routes, and a
 * patch-entry config would need a dsh restart (or an HMR round trip) for every
 * zoom-step change. `writeFileAtomic` keeps concurrent saves from truncating.
 *
 * @module dsh-zoom/lib/settings
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** Default zoom shortcut: Ctrl+Shift+= (mirrors the desktop shell). */
const DEFAULT_ZOOM_IN = { ctrl: true, shift: true, alt: false, code: "Equal", key: "+" };
/** Default zoom-out shortcut: Ctrl+Shift+- (mirrors the desktop shell). */
const DEFAULT_ZOOM_OUT = { ctrl: true, shift: true, alt: false, code: "Minus", key: "_" };

/** Fresh-install settings. */
export function defaultConfig() {
	return {
		level: 1,
		step: 0.02,
		min: 0.25,
		max: 5,
		in: { ...DEFAULT_ZOOM_IN },
		out: { ...DEFAULT_ZOOM_OUT },
		/** Whether the corner launcher is shown at all. */
		launcher: true
	};
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merge a patch over a base, returning a new value. Arrays and scalars
 * replace wholesale; plain objects merge key by key. The zoom settings are
 * shallow, but a patch carrying one field must never drop the others.
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
	merged.min = clampNumber(merged.min, 0.1, 5, defaults.min);
	merged.max = clampNumber(merged.max, merged.min, 8, defaults.max);
	merged.step = clampNumber(merged.step, 0.01, 0.25, defaults.step);
	merged.level = clampNumber(merged.level, merged.min, merged.max, 1);
	for (const side of ["in", "out"]) {
		const shortcut = merged[side];
		if (!isObject(shortcut)) {
			merged[side] = { ...defaults[side] };
			continue;
		}
		merged[side] = {
			ctrl: shortcut.ctrl === true,
			shift: shortcut.shift === true,
			alt: shortcut.alt === true,
			code: typeof shortcut.code === "string" && shortcut.code.length > 0 ? shortcut.code : defaults[side].code,
			key: typeof shortcut.key === "string" ? shortcut.key : defaults[side].key
		};
	}
	merged.launcher = merged.launcher !== false;
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
