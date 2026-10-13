/**
 * The installed-feature inventory behind `GET /dsh-features/api/features`.
 *
 * A feature plugin declares itself in its own package.json:
 *
 *     "dsh": { "ui": { "feature": { "key": "doctor", "order": 60,
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
 * read because a plugin can land in either — `<profiles>/<profile>/node_modules`
 * for anything the plugin manager installed, `<profiles>/plugins/<name>` for a
 * hand-placed or preseeded copy — but a directory only counts when the profile
 * declares that package (see `declaredPackages`).
 *
 * @module dsh-features/lib/inventory
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Only entries with this prefix are inspected (scopes are skipped outright). */
const PACKAGE_PREFIX = "dsh-";
/**
 * pnpm stages an install in `<name>_tmp_<pid>_<thread>` and leaves that directory behind
 * when the install dies. It holds the real package's `package.json`, so it passes every
 * check below and then wins the per-key dedupe, which is how a leftover reported a stale
 * order and version for the installed package.
 */
const STAGING_SUFFIX = /_tmp_\d+_\d+$/u;
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
 * Packages the profile itself declares. `dependencies` is what the plugin manager
 * writes when it installs one; `dsh.profile.bundles` is what the loader mounts.
 *
 * Everything else found on disk is a staging copy: `profiles/plugins/<name>/` is
 * where a manual (offline) install is *prepared* before it is added to the
 * profile, so being in there proves nothing. Reporting such a copy as installed
 * is exactly how a feature that was never enabled ends up on the page claiming
 * its panel "did not load".
 *
 * @param profile - the profile's package.json.
 * @returns the declared package names.
 */
function declaredPackages(profile) {
	const names = new Set(Object.keys(profile?.dependencies ?? {}));
	for (const bundle of profile?.dsh?.profile?.bundles ?? []) {
		if (typeof bundle === "string") names.add(bundle);
	}
	return names;
}

/**
 * Collect every installed package declaring `dsh.ui.feature`.
 * @param layout - resolved path layout (see lib/layout.js).
 * @returns the inventory entries, ordered.
 */
export async function readInventory(layout) {
	const roots = [layout.pluginsDir, join(layout.profileDir, "node_modules")];
	const declared = declaredPackages(await manifestOf(layout.profileDir));
	const found = new Map();
	for (const root of roots) {
		for (const entry of await entriesOf(root)) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (!entry.name.startsWith(PACKAGE_PREFIX)) continue;
			if (STAGING_SUFFIX.test(entry.name)) continue;
			const manifest = await manifestOf(join(root, entry.name));
			if (manifest === undefined) continue;
			const packageName = typeof manifest.name === "string" ? manifest.name : entry.name;
			if (!declared.has(packageName)) continue;
			const marker = normalize(manifest.dsh?.ui?.feature);
			if (marker === undefined) continue;
			found.set(marker.key, {
				...marker,
				package: packageName,
				version: typeof manifest.version === "string" ? manifest.version : undefined
			});
		}
	}
	return [...found.values()].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}
