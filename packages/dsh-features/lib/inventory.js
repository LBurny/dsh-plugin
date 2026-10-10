/**
 * The installed-feature inventory behind `GET /dsh-features/api/features`.
 *
 * A feature plugin declares itself in its own package.json:
 *
 *     "dsh": { "ui": { "feature": { "key": "doctor", "order": 30,
 *                                  "title": { "zh": "诊断", "en": "Doctor" },
 *                                  "summary": { "zh": "…", "en": "…" } } } }
 *
 * The marker is metadata only — what the page actually mounts comes from the
 * browser-side registry (`window.__dshFeatures`), which only a loaded plugin can
 * populate. Keeping the two separate is the point: a feature that is installed
 * but whose browser half failed is *named* on the page instead of silently
 * missing, and the page still works when this inventory is unavailable.
 *
 * Scanning is directory-name driven: only `dsh-*` entries are opened, so the
 * profile's few-hundred-package dependency farm is never walked. Two roots are
 * read because a plugin can land in either — `<profiles>/plugins/<name>` for a
 * hand-placed or preseeded copy, `<profiles>/<profile>/node_modules/<name>` for
 * anything `dsh plugin add` installed.
 *
 * @module dsh-features/lib/inventory
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Only entries with this prefix are inspected (scopes are skipped outright). */
const PACKAGE_PREFIX = "dsh-";
/** Fallback order for a marker that does not set one. */
const DEFAULT_ORDER = 100;

/** Read one directory, tolerating a missing or unreadable one. */
async function entriesOf(dir) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Read and parse a package.json, tolerating anything that is not one. */
async function manifestOf(path) {
	try {
		return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Normalize a `dsh.ui.feature` marker. Anything malformed is rejected rather
 * than rendered: the page shows foreign text, so shape is checked here.
 * @param marker - the raw marker value.
 * @returns `{ key, order, title, summary }`, or undefined when unusable.
 */
function normalize(marker) {
	if (marker === null || typeof marker !== "object") return undefined;
	if (typeof marker.key !== "string" || marker.key.length === 0) return undefined;
	const text = (value) => {
		if (typeof value === "string") return value;
		if (value === null || typeof value !== "object") return undefined;
		const zh = typeof value.zh === "string" ? value.zh : undefined;
		const en = typeof value.en === "string" ? value.en : undefined;
		if (zh === undefined && en === undefined) return undefined;
		return { ...zh === undefined ? {} : { zh }, ...en === undefined ? {} : { en } };
	};
	return {
		key: marker.key,
		order: Number.isFinite(marker.order) ? marker.order : DEFAULT_ORDER,
		title: text(marker.title),
		summary: text(marker.summary)
	};
}

/**
 * Collect every installed package declaring `dsh.ui.feature`.
 * @param layout - resolved path layout (see lib/layout.js).
 * @returns the inventory entries, ordered.
 */
export async function readInventory(layout) {
	const roots = [layout.pluginsDir, join(layout.profileDir, "node_modules")];
	const found = new Map();
	for (const root of roots) {
		for (const entry of await entriesOf(root)) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (!entry.name.startsWith(PACKAGE_PREFIX)) continue;
			const manifest = await manifestOf(join(root, entry.name));
			if (manifest === undefined) continue;
			const marker = normalize(manifest.dsh?.ui?.feature);
			if (marker === undefined) continue;
			found.set(marker.key, {
				...marker,
				package: typeof manifest.name === "string" ? manifest.name : entry.name,
				version: typeof manifest.version === "string" ? manifest.version : undefined
			});
		}
	}
	return [...found.values()].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}
