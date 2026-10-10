/**
 * dsh-remote settings: load / merge / save `<DSH_HOME>/dsh-remote.json`.
 *
 * The remote settings are read on every proxied request — the gate needs them
 * synchronously — so they live in a plain JSON file the manager can snapshot,
 * not in a patch entry that would need a restart to change.
 *
 * @module dsh-remote/lib/settings
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** Fresh-install settings. Remote access is off: see `enabled`. */
export function defaultConfig() {
	return {
		// Off by default: enabling publishes the harness (on the LAN, or to the
		// internet in tunnel mode), and the link it hands out is the only
		// credential.
		enabled: false,
		mode: "tunnel",
		port: 0,
		token: "",
		cloudflaredPath: ""
	};
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep-merge a patch over a base, returning a new value. */
export function mergeDeep(base, patch) {
	if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
	const out = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] = isObject(value) && isObject(base[key]) ? mergeDeep(base[key], value) : value;
	}
	return out;
}

/**
 * Coerce untrusted input (the settings file, or a browser POST) into the shape
 * the manager expects.
 * @param raw - candidate settings.
 * @returns fully populated settings.
 */
export function normalizeConfig(raw) {
	const defaults = defaultConfig();
	const merged = mergeDeep(defaults, isObject(raw) ? raw : {});
	merged.mode = merged.mode === "lan" ? "lan" : "tunnel";
	merged.enabled = merged.enabled === true;
	// An empty or malformed token means "mint a new one when access is enabled".
	merged.token = typeof merged.token === "string" && /^[0-9a-f]{32,}$/u.test(merged.token) ? merged.token : "";
	merged.port = Number.isInteger(merged.port) && merged.port >= 0 && merged.port <= 65535 ? merged.port : 0;
	merged.cloudflaredPath = typeof merged.cloudflaredPath === "string" ? merged.cloudflaredPath : "";
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
