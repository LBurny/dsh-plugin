/**
 * The directory picker a phone can actually use.
 *
 * dsh resolves its adaptive chooser once at boot: `@deepseek-ai/dsh-host-directory-picker-auto`
 * reads the bind host, and a loopback bind means the `native` backend, whose chooser is an OS
 * folder dialog on this machine's screen. A phone, or any browser that is not the app's own
 * window, can neither see nor drive that dialog: 添加工作区 on the phone reported a failure
 * until the worker fix of 2026-10-14, and even with the worker alive it only opened a window
 * on the PC.
 *
 * dsh ships the other interaction for exactly this case: the `browse` backend and its client
 * surface render a folder browser inside the page, so the desktop and the phone share one
 * shape. Nothing selects it for a loopback bind, so this plugin asks for it in the profile
 * patch document, the same pin DSHDesktop's bootstrap writes
 * (`bootstrap/patches/picker.rs` in LBurny/deepseek-harness-desktop): an id-targeted op
 * disabling the adaptive row, plus an insert list carrying the browse pair. That document is
 * the profile's declared composition rather than a hidden runtime swap, and it takes effect
 * on the next dsh start.
 *
 * The ask is the reader's to take back: `remove` drops the two rows and the disable flag
 * again. Both directions are idempotent, keep every comment and `!!js` tag (the `yaml`
 * package's document API, the same way `dsh-mcp/lib/mcp.js` edits this file), and are written
 * atomically. The file is shared, and the edit is a whole-document read-modify-write, so a
 * race with dsh's own config editor could lose the other writer's change; this plugin writes
 * at load and on an explicit panel action only, and re-reads at every load, which is where a
 * lost pin would be put back.
 *
 * @module dsh-remote/lib/picker
 */
import { readFile, stat as statPath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

import { writeFileAtomic } from "./atomic.js";

/** The adaptive row this plugin disables. */
const AUTO_ROW_ID = "directory-picker";
/** What replaces it: dsh's own browse backend and the surface that renders it in the page. */
const BROWSE_ROWS = [
	{ id: "directory-picker-browse", name: "@deepseek-ai/dsh-host-directory-picker-browse" },
	{ id: "ui-directory-picker-browse", name: "@deepseek-ai/dsh-client-ui-directory-picker-browse" }
];

/**
 * The listing level that carries this machine's drives, and the crumb naming it. dsh's browse
 * backend lists one level of one fully qualified path and derives the breadcrumb chain from
 * it, so a reader who starts in the home directory can walk down but never sideways: another
 * drive has no entry and no crumb (DSHDesktop's `pickerpatch.rs` adds the same sentinel to its
 * own runtime copy of the backend; a plugin cannot edit the copy inside the official app).
 * The level is a host-side invention, so the client renders it like any other directory, and
 * the crumb label stays English here for the same reason DSHDesktop's host does: this string
 * is decided before the client's language is known (the phone layer relabels it).
 */
export const DRIVES_SENTINEL = "dsh:drives";
export const DRIVES_CRUMB = "This PC";
const DRIVES_MARK = "__dshRemoteDrives";

/** A drive root (`C:\`), the one path shape that gets a crumb back to the drive level. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]$/u;

/**
 * Parse the patch document, treating an absent or empty file as an empty op list.
 * @param text - the document's content.
 * @returns the parsed document, ready to edit.
 */
export function parsePatchText(text) {
	const doc = parseDocument(text.trim() === "" ? "[]\n" : text);
	if (doc.errors.length > 0) throw new Error(`cordis.patch.yml is not valid YAML: ${doc.errors[0].message}`);
	if (doc.contents === null) doc.contents = doc.createNode([]);
	if (!isSeq(doc.contents)) throw new Error("cordis.patch.yml must be a YAML sequence");
	// Block style, matching dsh's own writer: this file is read by hand far more often
	// than by a machine.
	doc.contents.flow = false;
	return doc;
}

/** The top-level op that targets one row by id, if the document has one. */
function idOp(doc, id) {
	if (!isSeq(doc.contents)) return undefined;
	for (const op of doc.contents.items) {
		if (!isMap(op) || isSeq(op.get("insert", true))) continue;
		if (op.get("id") === id) return op;
	}
	return undefined;
}

/** Every row node carrying one row id, with the insert list holding it when there is one. */
function rowNodes(doc, id) {
	const found = [];
	if (!isSeq(doc.contents)) return found;
	for (const op of doc.contents.items) {
		if (!isMap(op)) continue;
		const insert = op.get("insert", true);
		if (!isSeq(insert)) {
			if (op.get("id") === id) found.push({ row: op, container: undefined });
			continue;
		}
		for (const row of insert.items) if (isMap(row) && row.get("id") === id) found.push({ row, container: insert });
	}
	return found;
}

/**
 * Ask the document for the browse interaction.
 * @param doc - the parsed patch document, edited in place.
 * @returns whether anything changed.
 */
export function applyPin(doc) {
	let changed = false;
	// The adaptive row: an id-targeted op without an insert key, the shape dsh's own overlay
	// uses. A reader who deleted the flag (or the op) is pinned again, since the pin is this
	// plugin's own statement about the composition.
	const op = idOp(doc, AUTO_ROW_ID);
	if (op === undefined) {
		doc.add(doc.createNode({ id: AUTO_ROW_ID, disabled: true }));
		changed = true;
	} else if (op.get("disabled") !== true) {
		op.set("disabled", true);
		changed = true;
	}
	// The browse pair: insert what is missing, re-enable what was switched off.
	for (const { id, name } of BROWSE_ROWS) {
		const [found] = rowNodes(doc, id);
		if (found === undefined) {
			doc.add(doc.createNode({ insert: [{ id, name }] }));
			changed = true;
			continue;
		}
		if (found.row.has("disabled")) {
			found.row.delete("disabled");
			changed = true;
		}
	}
	return changed;
}

/**
 * Put the composition back: no disable flag on the adaptive row, no browse pair from this
 * plugin. A row that still carries other keys is kept, only the flag goes.
 * @param doc - the parsed patch document, edited in place.
 * @returns whether anything changed.
 */
export function removePin(doc) {
	let changed = false;
	const op = idOp(doc, AUTO_ROW_ID);
	if (op !== undefined && op.has("disabled")) {
		op.delete("disabled");
		changed = true;
		// An op left with nothing but the id was this plugin's entire statement about the row.
		if (op.items.length === 1) doc.contents.items = doc.contents.items.filter((entry) => entry !== op);
	}
	for (const { id } of BROWSE_ROWS) {
		for (const { row, container } of rowNodes(doc, id)) {
			if (container === undefined) continue;
			container.items = container.items.filter((entry) => entry !== row);
			changed = true;
		}
	}
	// An insert list this plugin emptied does not belong in the document either.
	if (isSeq(doc.contents)) {
		doc.contents.items = doc.contents.items.filter((entry) => !(isMap(entry) && isSeq(entry.get("insert", true)) && entry.get("insert", true).items.length === 0));
	}
	return changed;
}

/**
 * What the document currently says, for the panel.
 * @param doc - the parsed patch document.
 * @returns `{ pinned, autoDisabled, missing }`: `missing` names the rows the pin would insert.
 */
export function readPin(doc) {
	const op = idOp(doc, AUTO_ROW_ID);
	const autoDisabled = op?.get("disabled") === true;
	const missing = BROWSE_ROWS.filter(({ id }) => rowNodes(doc, id).length === 0).map(({ id }) => id);
	return { pinned: autoDisabled && missing.length === 0, autoDisabled, missing };
}

/**
 * The drive level: one row per readable drive root, `A:` through `Z:`. A drive that is
 * absent, empty or not ready fails its `stat` and is skipped, which is the same probe the
 * crumb walk itself would do (DSHDesktop's host patch probes the same way).
 * @param options - `stat` and `home` are injectable for tests.
 * @returns the listing shape the browse client renders.
 */
export async function drivesLevel(options = {}) {
	const probe = options.stat ?? statPath;
	const entries = [];
	for (let code = 65; code <= 90; code += 1) {
		const letter = String.fromCharCode(code);
		const root = `${letter}:\\`;
		try {
			if (!(await probe(root)).isDirectory()) continue;
		} catch (error) {
			if (options.signal?.aborted === true) throw error;
			continue;
		}
		entries.push({ name: `${letter}:`, path: root, hidden: false });
	}
	return {
		path: DRIVES_SENTINEL,
		home: options.home ?? homedir(),
		crumbs: [{ name: DRIVES_CRUMB, path: DRIVES_SENTINEL, hidden: false }],
		entries,
		truncated: false
	};
}

/**
 * Put the drive level in reach from a drive root's listing: the crumb chain of `C:\` is that
 * one root (dsh derives crumbs from the path, and a drive has no parent), so nothing would
 * lead back up. Everything else in the listing is the backend's own.
 * @param listing - one listing from the mounted backend.
 * @returns the listing to send, with the sentinel crumb in front of a drive root's chain.
 */
export function withDrivesCrumb(listing) {
	if (listing === null || typeof listing !== "object" || !Array.isArray(listing.crumbs)) return listing;
	if (typeof listing.path !== "string" || !DRIVE_ROOT.test(listing.path)) return listing;
	if (listing.crumbs.some((crumb) => crumb?.path === DRIVES_SENTINEL)) return listing;
	return { ...listing, crumbs: [{ name: DRIVES_CRUMB, path: DRIVES_SENTINEL, hidden: false }, ...listing.crumbs] };
}

/**
 * Wrap a mounted picker's browse capability with the drive level.
 *
 * The wrapper sits on the capability object the workspace controller resolves per call
 * (`ctx.directoryPicker.capability().list`), so the backend's own listing stays untouched:
 * only the sentinel path is answered here, and only a drive root's crumb chain is amended.
 * dsh validates a path as fully qualified before listing it, which is why the sentinel is
 * answered before the backend ever sees it.
 * @param capability - the mounted capability object, if this profile mounts a browse backend.
 * @param options - `platform`, `stat`, `home` and `log` are injectable.
 * @returns the disposer that puts the capability back, or undefined when there is nothing to wrap.
 */
export function wrapBrowseCapability(capability, options = {}) {
	const platform = options.platform ?? process.platform;
	const list = capability?.list;
	// Only Windows has drives to name, and only a browse capability has a listing to amend.
	if (platform !== "win32" || capability?.kind !== "browse" || typeof list !== "function") return undefined;
	if (list[DRIVES_MARK] === true) {
		options.log?.("picker drives: the drive level is already in place");
		return undefined;
	}
	const wrapped = async function (path, signal) {
		if (typeof path === "string" && path.replace(/[\\/]+$/u, "") === DRIVES_SENTINEL) {
			return drivesLevel({ stat: options.stat, home: options.home, signal });
		}
		// The client asks for no path when it opens, which the backend answers with the home
		// directory. Starting at this machine's drives instead is what Windows' own chooser
		// does, and it is the only view from which every drive is one tap away: dsh's crumb
		// chain cannot climb out of the home subtree (the client folds that prefix into a
		// single Home crumb, which is the fold DSHDesktop's client patch preserves the
		// sentinel crumb through, and a plugin cannot patch the client inside the app).
		if (path === undefined) return drivesLevel({ stat: options.stat, home: options.home, signal });
		return withDrivesCrumb(await list.call(this, path, signal));
	};
	wrapped[DRIVES_MARK] = true;
	capability.list = wrapped;
	options.log?.("picker drives: the drive level is in place on the browse listing");
	return () => {
		if (capability.list === wrapped) capability.list = list;
	};
}

/**
 * The pin, as this plugin's own small service.
 * @param options - `layout` resolves the profile patch path, `log` reports a write.
 * @returns `{ refresh, ensure, remove }`.
 */
export function createPickerPin({ layout, log, platform, stat, home }) {
	/** Read the document text, treating a missing file as an empty op list. */
	async function read() {
		const path = layout().patchPath;
		try {
			return { path, text: await readFile(path, "utf8") };
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			return { path, text: "" };
		}
	}

	/** What the file says right now, without touching it. Never throws: the panel renders this. */
	async function refresh() {
		try {
			const { text } = await read();
			return readPin(parsePatchText(text));
		} catch (error) {
			return { pinned: undefined, autoDisabled: undefined, missing: [], error: String(error?.message ?? error) };
		}
	}

	/**
	 * Make the document ask for the browse interaction, or stop asking.
	 * @param pin - true to pin browse, false to put the composition back.
	 * @returns `{ changed, state }`; `changed` means the next dsh start composes differently.
	 */
	async function ensure(pin) {
		const { path, text } = await read();
		const doc = parsePatchText(text);
		const changed = pin ? applyPin(doc) : removePin(doc);
		const state = readPin(doc);
		if (!changed) return { changed: false, state };
		const out = String(doc);
		await writeFileAtomic(path, out.endsWith("\n") ? out : `${out}\n`, { mode: 0o600 });
		log?.(`picker ${pin ? "pinned to the browse interaction" : "unpinned"} in ${basename(path)}: the composition changes on the next dsh start`);
		return { changed: true, state };
	}

	/**
	 * Put the drive level on the mounted picker, when this machine has drives to name. The
	 * backend is created by dsh's adaptive picker after boot, so this is called from an
	 * inject that waits for the service rather than read at load.
	 * @param service - the mounted `ctx.directoryPicker` service.
	 * @returns the disposer, or undefined when there is nothing to wrap.
	 */
	function attach(service) {
		const capability = typeof service?.capability === "function" ? service.capability() : undefined;
		return wrapBrowseCapability(capability, { platform, stat, home, log });
	}

	return { refresh, ensure, remove: () => ensure(false), attach };
}
