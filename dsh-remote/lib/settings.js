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
import { writeFileAtomic } from "./atomic.js";

/** Fresh-install settings. Remote access is off: see `enabled`. */
export function defaultConfig() {
	return {
		// Off by default: enabling publishes the harness (on the tailnet, on the LAN, or
		// to the internet in tunnel mode), and the link it hands out is the only
		// credential.
		enabled: false,
		// One of `lan` (every interface), `tailnet` (this machine's Tailscale address
		// only, private and stable) or `tunnel` (a public Cloudflare hostname).
		mode: "tunnel",
		port: 0,
		token: "",
		cloudflaredPath: "",
		// Only for reaching Cloudflare's release host when this machine cannot reach it
		// directly: `github.com` is DNS-poisoned on some networks (measured on a China
		// Unicom line, where the download only completed through a local proxy), and the
		// bytes are transferred with `curl`, so an http(s) proxy URL is the whole fix.
		cloudflaredProxy: ""
	};
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** An http(s) proxy URL, or an empty string. Anything else reads as "no proxy". */
function normalizeProxy(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed === "") return "";
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? trimmed : "";
	} catch {
		return "";
	}
}

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
	merged.mode = ["lan", "tailnet", "tunnel"].includes(merged.mode) ? merged.mode : "tunnel";
	merged.enabled = merged.enabled === true;
	// An empty or malformed token means "mint a new one when access is enabled".
	merged.token = typeof merged.token === "string" && /^[0-9a-f]{32,}$/u.test(merged.token) ? merged.token : "";
	merged.port = Number.isInteger(merged.port) && merged.port >= 0 && merged.port <= 65535 ? merged.port : 0;
	merged.cloudflaredPath = typeof merged.cloudflaredPath === "string" ? merged.cloudflaredPath : "";
	merged.cloudflaredProxy = normalizeProxy(merged.cloudflaredProxy);
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
