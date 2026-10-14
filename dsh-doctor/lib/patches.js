/**
 * dsh-doctor patches: the corrections this plugin makes to the process it runs in.
 *
 * A patch exists because a defect belongs to the running harness rather than to a file,
 * and a plugin cannot edit the harness. There is one today.
 *
 * `electron-run-as-node` — the official desktop app starts its harness host as the
 * Electron executable in Node mode (`lib/main.js`'s `desktopNodeEnvironment`, used by
 * `DesktopHostProcess.start`), so `ELECTRON_RUN_AS_NODE=1` sits in the host's own
 * environment. The harness scrubs a child environment of credential-shaped names and of
 * `DSH_*`, which leaves that one in place, so every application the open-in-app feature
 * launches inherits it. An Electron editor (VS Code, Cursor, Windsurf) then starts as
 * plain Node, is handed the workspace directory as a script, and exits non-zero, which
 * dsh reports as `failed to launch <app>` — the panel's 打开失败，请重试. The file
 * managers are unaffected because explorer.exe is not Electron.
 *
 * Dropping the name is what dsh itself does where it matters: `dsh-ptc-runtime-node`
 * filters `ELECTRON_RUN_AS_NODE` out of the environment it builds for its child, and the
 * two places that want Electron in Node mode (the desktop host's package manager, the
 * GitHub Desktop adapter) set it explicitly for that child instead of inheriting it.
 *
 * One dsh child does depend on inheriting it, and a pick made from a browser that is not
 * the app's own window is where that shows: the Win32 folder chooser runs in a worker
 * spawned as this very executable with `env: { ...process.env }`, so the variable this
 * patch drops is the only thing that starts it as Node (see `./picker-worker.js`, which
 * lends it back for that one call). Nothing reads the variable back in this process.
 *
 * The decision lives in `<DSH_HOME>/dsh-doctor.json`, so a patch can be switched off or
 * taken off the list from the panel at any time, and that one file is the whole record of
 * it. Reverting puts the environment back exactly as this process found it.
 *
 * @module dsh-doctor/lib/patches
 */
import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

/** The decision file, inside the active DSH home. Nothing else in this plugin writes it. */
export const PATCHES_FILENAME = "dsh-doctor.json";

/** The one patch, named so the module that gives its variable back for one spawn shares it. */
export const RUN_AS_NODE = { id: "electron-run-as-node", variable: "ELECTRON_RUN_AS_NODE" };

/**
 * The catalog, in panel order. `variable` names the environment entry the patch drops;
 * the panel keys that patch's title and description by `id`, in its own language.
 */
export const PATCH_CATALOG = [RUN_AS_NODE];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Coerce untrusted input (the file, or a browser POST) into the state shape.
 *
 * A patch with no entry is enabled: installing this plugin is the decision to fix the
 * defect, and switching one off has to be recorded deliberately. Entries for ids that are
 * no longer in the catalog are dropped, so a renamed patch cannot leave a stray decision
 * behind. `removed` wins over `enabled`, because a patch taken off the list must not come
 * back with a flag beside it.
 * @param raw - candidate state.
 * @returns `{ patches: { <id>: { enabled: false } | { removed: true } } }`.
 */
export function normalizePatchState(raw) {
	const source = isObject(raw) && isObject(raw.patches) ? raw.patches : {};
	const patches = {};
	for (const patch of PATCH_CATALOG) {
		const entry = source[patch.id];
		if (!isObject(entry)) continue;
		if (entry.removed === true) patches[patch.id] = { removed: true };
		else if (entry.enabled === false) patches[patch.id] = { enabled: false };
	}
	return { patches };
}

/** Read the state file, tolerating a missing or corrupt one. */
export async function loadPatchState(path) {
	try {
		return normalizePatchState(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return normalizePatchState(undefined);
	}
}

/**
 * Atomically persist the state. Normalized on the way out as well as on the way in, so a
 * hand-edited file is rewritten in the shape this module reads and no `enabled: true`
 * ever lands on disk beside a patch that is meant to be gone.
 */
export async function savePatchState(path, state) {
	const normalized = normalizePatchState(state);
	await writeFileAtomic(path, `${JSON.stringify(normalized, null, "\t")}\n`, { mode: 384 });
	return normalized;
}

/**
 * Every patch still on the list, with the reader's decision beside it. A removed patch is
 * absent from this list and therefore not applied; its environment is put back.
 * @param state - normalized patch state.
 */
export function listPatches(state) {
	return PATCH_CATALOG.filter((patch) => state.patches?.[patch.id]?.removed !== true).map((patch) => ({
		id: patch.id,
		variable: patch.variable,
		enabled: state.patches?.[patch.id]?.enabled !== false
	}));
}

/**
 * Record one patch as on or off.
 * @returns a new state; a removed patch stays removed, since it has no switch to press.
 */
export function setPatchEnabled(state, id, enabled) {
	const next = normalizePatchState(state);
	if (!PATCH_CATALOG.some((patch) => patch.id === id)) return next;
	if (next.patches[id]?.removed === true) return next;
	if (enabled === true) delete next.patches[id];
	else next.patches[id] = { enabled: false };
	return next;
}

/**
 * Take one patch off the list for good.
 * @returns a new state. Deleting `<DSH_HOME>/dsh-doctor.json` is what brings the catalog
 *   back, which is deliberate: the list has no add control, like the skills page's.
 */
export function removePatch(state, id) {
	const next = normalizePatchState(state);
	if (!PATCH_CATALOG.some((patch) => patch.id === id)) return next;
	next.patches[id] = { removed: true };
	return next;
}

/** What one environment held for a patch's variable, before this plugin touched it. */
function snapshotOf(env, variable) {
	return Object.prototype.hasOwnProperty.call(env, variable)
		? { present: true, value: env[variable] }
		: { present: false, value: undefined };
}

/**
 * Apply and revert the catalog against one environment, idempotently.
 *
 * The remembered value is what makes removing a patch honest: reverting puts the
 * environment back the way this process found it rather than into some third state.
 * @param env - the environment object to edit; this process's own by default.
 * @param catalog - the patches to consider.
 * @returns a handle the host half keeps for the life of the plugin.
 */
export function createPatchRuntime(env = process.env, catalog = PATCH_CATALOG) {
	/** What each variable held before this plugin touched it. */
	const before = new Map(catalog.map((patch) => [patch.id, snapshotOf(env, patch.variable)]));
	/** Patches whose decision has been carried out against this environment. */
	const settled = new Map();

	return {
		/**
		 * Whether this process ever carried a patch's variable. False means the patch is a
		 * no-op here (a bare CLI harness never sets it), which the panel says out loud
		 * instead of offering a fix that changes nothing.
		 */
		present(id) {
			return before.get(id)?.present === true;
		},
		/**
		 * Whether this process is right now carrying a patch out, i.e. the variable is gone
		 * because of this plugin. A process that never carried the variable reports false:
		 * nothing was taken there, so nothing has to be given back either.
		 */
		applied(id) {
			return before.get(id)?.present === true && settled.get(id) === true;
		},
		/**
		 * The value this process carried for a patch's variable before the patch dropped it.
		 * Handing the original value back is what keeps a lent variable honest.
		 */
		carried(id) {
			const shot = before.get(id);
			return shot?.present === true ? shot.value : undefined;
		},
		/**
		 * Make this environment match `state`.
		 * @returns the ids whose environment actually changed, for the log.
		 */
		settle(state) {
			const wanted = new Set(listPatches(state).filter((patch) => patch.enabled).map((patch) => patch.id));
			const changed = [];
			for (const patch of catalog) {
				const shot = before.get(patch.id);
				const shouldApply = wanted.has(patch.id);
				const isApplied = settled.get(patch.id) === true;
				if (shouldApply === isApplied) continue;
				settled.set(patch.id, shouldApply);
				// A process that never carried the variable has nothing to drop or restore,
				// so the decision is recorded without pretending the environment moved.
				if (!shot.present) continue;
				if (shouldApply) Reflect.deleteProperty(env, patch.variable);
				else env[patch.variable] = shot.value;
				changed.push(patch.id);
			}
			return changed;
		}
	};
}
