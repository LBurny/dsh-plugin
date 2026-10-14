/**
 * Offline checks for lib/picker.js: the profile-patch pin that gives a phone a folder
 * picker it can actually see. The document shapes here are the ones this file really
 * carries on this machine: id-targeted overrides, an `insert` list of MCP rows, the
 * reader's own comments, and dsh-hotreload's marked block.
 *
 * Run from the plugin directory:
 *   node tests/picker.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyPin,
	createPickerPin,
	DRIVES_SENTINEL,
	drivesLevel,
	parsePatchText,
	readPin,
	removePin,
	withDrivesCrumb,
	wrapBrowseCapability
} from "../lib/picker.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/** A patch document shaped like the real one: overrides, an insert list, comments, markers. */
const FIXTURE = `# Your patch layer for this dsh profile.
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
- insert:
    - id: mcp-playwright
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: playwright

# >>> dsh-hotreload >>>
- id: hmr
  config:
    base: file:///C:/Users/intel/.dsh/profiles/desktop
# <<< dsh-hotreload <<<
`;

const rowsOf = (doc) => (doc.contents?.items ?? []).map((op) => (typeof op?.toJSON === "function" ? op.toJSON() : op));

/* ------------------------------------------------------------- the pin */

const pinned = parsePatchText(FIXTURE);
check(applyPin(pinned) === true, "an unpinned document is a change");
const pinnedText = String(pinned);
check(/^- id: directory-picker\n  disabled: true$/mu.test(pinnedText), "the adaptive row gets an id-targeted disable op", pinnedText.split("\n").slice(-6).join(" | "));
check(pinnedText.includes("- id: directory-picker-browse\n      name: \"@deepseek-ai/dsh-host-directory-picker-browse\""), "the browse backend row is inserted");
check(pinnedText.includes("- id: ui-directory-picker-browse\n      name: \"@deepseek-ai/dsh-client-ui-directory-picker-browse\""), "the browse surface row is inserted");
check(applyPin(pinned) === false, "pinning twice changes nothing");
check(readPin(pinned).pinned === true && readPin(pinned).missing.length === 0, "the document reads as pinned", JSON.stringify(readPin(pinned)));
check(readPin(pinned).autoDisabled === true, "and names the adaptive row as disabled");

// The shared file must survive: the reader's comments, the MCP rows and hotreload's block are
// not this plugin's to rewrite, and a re-serialized document would drop them.
check(pinnedText.includes("# Your patch layer for this dsh profile."), "the document's leading comment survives");
check(pinnedText.includes("# >>> dsh-hotreload >>>") && pinnedText.includes("# <<< dsh-hotreload <<<"), "dsh-hotreload's marked block survives");
check(pinnedText.includes("serverName: playwright"), "an MCP row's config survives");
const kept = rowsOf(pinned).find((op) => op?.id === "ui-theme");
check(kept?.config?.preference === "dark", "an unrelated override keeps its config", JSON.stringify(kept));

// A reader who switched the pin off by hand is switched back on: the pin is this plugin's
// statement about the composition, and it is re-asserted at every load.
const reenabled = parsePatchText(`${FIXTURE}- id: directory-picker\n  disabled: false\n`);
check(applyPin(reenabled) === true, "a re-enabled adaptive row is pinned again");
check(rowsOf(reenabled).find((op) => op?.id === "directory-picker")?.disabled === true, "and the flag is set, not duplicated");

// A document that already carries the rows (a reader who pinned by hand, or an earlier run)
// only needs the flag removed from them.
const handPinned = parsePatchText(`${FIXTURE}- insert:\n    - id: directory-picker-browse\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n      disabled: true\n    - id: ui-directory-picker-browse\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"\n`);
check(applyPin(handPinned) === true, "hand-written browse rows are adopted");
check(rowsOf(handPinned).filter((op) => Array.isArray(op?.insert)).map((op) => op.insert).flat().every((row) => row.disabled === undefined), "and switched on rather than duplicated");

/* ----------------------------------------------------------- the unpin */

const original = rowsOf(parsePatchText(FIXTURE));
const restored = parsePatchText(String(pinned));
check(removePin(restored) === true, "unpinning a pinned document is a change");
check(removePin(restored) === false, "unpinning twice changes nothing");
check(JSON.stringify(rowsOf(restored)) === JSON.stringify(original), "unpinning leaves exactly the document it found", JSON.stringify(rowsOf(restored)).slice(0, 120));
check(String(restored).includes("# >>> dsh-hotreload >>>"), "and the comments come through too");

// Only the flag goes when the reader's own override sits on the same op.
const shared = parsePatchText(`${FIXTURE}- id: directory-picker\n  disabled: true\n  config:\n    maxEntries: 5000\n`);
removePin(shared);
const sharedOp = rowsOf(shared).find((op) => op?.id === "directory-picker");
check(sharedOp !== undefined && sharedOp.config?.maxEntries === 5000 && sharedOp.disabled === undefined, "an op with the reader's own config keeps it and only loses the flag", JSON.stringify(sharedOp));

// An insert list that still holds other rows stays, one this plugin emptied does not.
const emptied = parsePatchText(String(pinned));
removePin(emptied);
const lists = rowsOf(emptied).filter((op) => Array.isArray(op?.insert));
check(lists.length === 1 && lists[0].insert.length === 1, "the MCP insert list stays while this plugin's own lists go", JSON.stringify(lists.map((op) => op.insert.length)));

/* ------------------------------------------------------- the file edges */

const dir = await mkdtemp(join(tmpdir(), "dsh-remote-picker-"));
const path = join(dir, "cordis.patch.yml");
const layout = () => ({ patchPath: path });
const logged = [];
const pin = createPickerPin({ layout, log: (message) => logged.push(message) });

// A missing file is an empty op list, and the pin creates it.
const first = await pin.ensure(true);
check(first.changed === true && first.state.pinned === true, "pinning a missing file writes it", JSON.stringify(first));
check((await readFile(path, "utf8")).includes("disabled: true"), "the file on disk carries the disable op");
check(logged.length === 1 && logged[0].includes("next dsh start"), "the write says when it applies", logged[0]);
const second = await pin.ensure(true);
check(second.changed === false && logged.length === 1, "a second load writes nothing and logs nothing");
check((await pin.refresh()).pinned === true, "the panel's read agrees");

await writeFile(path, FIXTURE, "utf8");
check((await pin.refresh()).pinned === false, "the reader's own document reads as unpinned");
const removed = await pin.ensure(false);
check(removed.changed === false && (await readFile(path, "utf8")) === FIXTURE, "unpinning a document without the pin leaves it byte-identical", String(removed.changed));

// A document this plugin cannot read is reported, never repaired by force: it belongs to the
// reader, and dsh's own editor refuses the same input.
await writeFile(path, "- id: [unclosed\n", "utf8");
check((await pin.refresh()).error !== undefined, "invalid YAML is reported to the panel", JSON.stringify(await pin.refresh()));
let refused = false;
try {
	await pin.ensure(true);
} catch {
	refused = true;
}
check(refused, "and pinning refuses to touch it");
await writeFile(path, "id: not-a-sequence\n", "utf8");
check((await pin.refresh()).error !== undefined, "a document that is not an op list is reported too");

await rm(dir, { recursive: true, force: true });

/* --------------------------------------------------------- the drive level */

const fakeStat = (path) => (/^[CD]:\\$/u.test(path) ? Promise.resolve({ isDirectory: () => true }) : Promise.reject(new Error("ENOENT")));
const level = await drivesLevel({ stat: fakeStat, home: "C:\\Users\\x" });
check(level.path === DRIVES_SENTINEL && level.entries.length === 2, "the drive level lists the readable roots", JSON.stringify(level.entries));
check(level.entries[0].name === "C:" && level.entries[0].path === "C:\\", "a drive row is the root path under a colon name", JSON.stringify(level.entries[0]));
check(level.crumbs.length === 1 && level.crumbs[0].path === DRIVES_SENTINEL, "the level itself is the only crumb");
check(level.home === "C:\\Users\\x", "the home directory rides along, so the client still infers the separator", level.home);

// The real probe against this machine: the test machine has a C drive, whatever else it has.
const real = await drivesLevel({ home: homedir() });
check(real.entries.some((entry) => entry.name === "C:"), "the real probe finds this machine's system drive", real.entries.map((entry) => entry.name).join(" "));

// A drive root's chain is that one root (dsh derives crumbs from the path, and a drive has no
// parent), so nothing would lead back up without the sentinel crumb in front.
const root = { path: "C:\\", home: "C:\\Users\\x", crumbs: [{ name: "C:\\", path: "C:\\" }], entries: [], truncated: false };
const amended = withDrivesCrumb(root);
check(amended.crumbs.length === 2 && amended.crumbs[0].path === DRIVES_SENTINEL, "a drive root gains the drive level first", JSON.stringify(amended.crumbs));
check(root.crumbs.length === 1, "and the backend's own listing is not edited in place");
const inside = { path: "C:\\Users", home: "C:\\Users\\x", crumbs: [{ name: "C:\\", path: "C:\\" }, { name: "Users", path: "C:\\Users" }], entries: [], truncated: false };
check(withDrivesCrumb(inside) === inside, "a path inside a drive is passed through untouched");
check(withDrivesCrumb(amended) === amended, "an already amended chain is not amended twice");
check(withDrivesCrumb(undefined) === undefined, "no listing is passed through");
const notAListing = { path: "C:\\" };
check(withDrivesCrumb(notAListing) === notAListing, "a listing without crumbs is passed through");

// The wrapper sits on the capability object the controller resolves per call: dsh refuses a
// path that is not fully qualified before listing it, so the sentinel has to be answered here.
let backendCalls = 0;
const browseCapability = {
	kind: "browse",
	list: async () => {
		backendCalls += 1;
		return { ...root };
	}
};
const originalList = browseCapability.list;
const detachBrowse = wrapBrowseCapability(browseCapability, { platform: "win32", stat: fakeStat, home: "C:\\Users\\x" });
check(typeof detachBrowse === "function", "the wrapper attaches to a mounted browse capability");
const sentinel = await browseCapability.list(DRIVES_SENTINEL);
check(sentinel.entries.length === 2 && backendCalls === 0, "the sentinel is answered here and never reaches the backend", String(backendCalls));
check(sentinel.path === "dsh:drives", "with the sentinel as its own path", sentinel.path);
const listed = await browseCapability.list("C:\\");
check(backendCalls === 1 && listed.crumbs.length === 2, "a real path is the backend's listing plus the crumb", String(backendCalls));
// The client asks for no path when it opens. The drive level is the only view every drive is
// one tap from, since the client folds the crumb chain inside the home subtree.
const opened = await browseCapability.list();
check(opened.path === DRIVES_SENTINEL && opened.entries.length === 2, "opening the browser lands on the drive level", String(opened.path));
check(backendCalls === 1, "and the initial view never reaches the backend either", String(backendCalls));
check(browseCapability.kind === "browse", "the capability stays a browse capability");
check(wrapBrowseCapability(browseCapability, { platform: "win32" }) === undefined, "a second wrap is refused rather than stacked");
detachBrowse();
check(browseCapability.list === originalList, "detaching puts the backend's own listing back");

// Everything that is not a mounted browse backend on Windows is left alone.
check(wrapBrowseCapability({ kind: "native", pick: () => null }, { platform: "win32" }) === undefined, "a native capability has no listing to wrap");
check(wrapBrowseCapability({ kind: "browse" }, { platform: "win32" }) === undefined, "a browse capability without a listing is nothing to wrap");
check(wrapBrowseCapability({ kind: "browse", list: async () => root }, { platform: "linux" }) === undefined, "another platform has no drives to name");
check(wrapBrowseCapability(undefined, { platform: "win32" }) === undefined, "an unmounted picker is nothing to wrap");

/* ------------------------------------------------------------ reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nPICKER TEST PASS (${results.length} checks)` : `\nPICKER TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
