/**
 * Upstream anchor probe: does the dsh build in front of us still carry everything
 * `dsh-remote` hangs off?
 *
 * Why this exists. The phone layer degrades silently on purpose: every step that cannot find
 * its anchor gives up and leaves the page in its un-adapted but working state. That is the right
 * behaviour, and it is also why a dsh upgrade can quietly cost the phone its UI, or cost the
 * proxy its whole row, without a single test going red: the suites pin this package's own
 * strings against fixtures of dsh's HTML, never against the build actually installed. This tool
 * closes that gap by asking the installed build the one question that matters, which of the
 * anchors are still there, and naming what dies for each one that is not.
 *
 *   node tools/anchors/anchors.mjs                         # the app's app.asar, when it is there
 *   node tools/anchors/anchors.mjs --asar "F:\Code\dsh\resources\app.asar"
 *   node tools/anchors/anchors.mjs --dir "<an unpacked dsh node_modules>"
 *   node tools/anchors/anchors.mjs --json
 *
 * Exit code 1 when a product anchor is missing, so an upgrade can be gated on it, and `--list`
 * prints the table itself. The closing section re-reads this repository's phone layer and
 * separates two kinds of literal it uses that the table does not mention: behavioural anchors
 * (printed as a warning, they belong in the table) and styling-only class selectors (counted,
 * a miss costs that element its phone styling and nothing else). The table is the one thing
 * here that can go stale, and that section is what makes staleness visible.
 *
 * Read-only: it never writes to the target and never starts anything.
 */
import { readFileSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ the anchors */

/**
 * Every upstream detail this package depends on.
 *
 * `severity`:
 *   `row`     a dsh change here can cost the plugin its mount, or the harness its boot.
 *   `feature` the plugin mounts, but a feature stops working outright.
 *   `silent`  the phone UI quietly falls back to its un-adapted shape. This is the class that
 *             is invisible without this tool, and it is deliberately the largest.
 *   `note`    an internal contract between this repository's own packages, or a hint.
 * `needles` is a list, because a few anchors are one fact spread over several names.
 * `where` says what has to carry the needle, so a miss can be told apart from a target that
 * simply was not scanned for it.
 */
const ANCHORS = [
	// --- dsh's services and extension points: whether the row mounts at all
	{
		needles: ["webServer"],
		severity: "row",
		where: "dsh runtime (the web-server service)",
		usedBy: "lib/index.js (the panel's routes), lib/remote.js (the loopback port)",
		ifMissing: "the injected callback throws, so the row never mounts"
	},
	{
		needles: ["prefix"],
		severity: "row",
		where: "dsh runtime (the web server's route registration kinds)",
		usedBy: "lib/index.js (`register({ kind: \"prefix\" })`)",
		ifMissing: "the route table entry is refused and the panel's assets 404"
	},
	{
		needles: ["webserver/index-inject"],
		severity: "row",
		where: "dsh runtime (the web server's injection event)",
		usedBy: "lib/index.js (panel script/stylesheet injection)",
		ifMissing: "the desktop panel loads unstyled and unscripted; the phone UI does not, it comes from the proxy's rewrite"
	},
	{
		needles: ["configEditor"],
		severity: "row",
		where: "dsh runtime (the config-editor service)",
		usedBy: "lib/index.js, lib/layout.js",
		ifMissing: "the injected callback throws, and every path this plugin writes becomes unknown"
	},
	{
		needles: ["documentPath"],
		severity: "row",
		where: "dsh runtime (the config editor's document path)",
		usedBy: "lib/layout.js (the DSH home is derived from it)",
		ifMissing: "no DSH home can be derived; the plugin refuses loudly instead of writing beside some other directory"
	},
	{
		needles: ["connection"],
		severity: "feature",
		where: "dsh runtime (the connection service)",
		usedBy: "lib/index.js (resume), lib/remote.js (the launch token)",
		ifMissing: "remote access cannot be enabled or resumed: every start ends with 'connection service is not available'"
	},
	{
		needles: ["authenticatedUrl"],
		severity: "feature",
		where: "dsh runtime (the connection service)",
		usedBy: "lib/remote.js (the launch token the proxy's cookie comes from)",
		ifMissing: "no launch token, so no cookie: every proxied request is refused"
	},
	{
		needles: ["browserAuth"],
		severity: "feature",
		where: "dsh runtime (the connection service's fallback field)",
		usedBy: "lib/remote.js (second source for the launch token)",
		ifMissing: "only if `authenticatedUrl` is gone too does the enable path lose its token"
	},
	{
		needles: ["loader"],
		severity: "note",
		where: "dsh runtime (the loader whose entries() answers 'did my row load?')",
		usedBy: "lib/index.js (the row-id collision warning)",
		ifMissing: "the collision warning stays silent; nothing else changes"
	},

	// --- dsh's client hooks the phone layer acts on
	{
		needles: ["data-composer-stats"],
		severity: "silent",
		where: "dsh client (chat UI, the composer's stats row)",
		usedBy: "lib/assets/mobile.js (the 信息 tab's turn stats)",
		ifMissing: "the 信息 tab opens empty"
	},
	{
		needles: ["conversation.composer.dock"],
		severity: "silent",
		where: "dsh client (chat UI, the composer dock slot)",
		usedBy: "lib/assets/mobile.js (locating the context-usage ring)",
		ifMissing: "the 信息 tab loses the context-usage number only"
	},
	{
		needles: ["aria-haspopup"],
		severity: "silent",
		where: "dsh client (the composer dock's pill buttons)",
		usedBy: "lib/assets/mobile.js (picking the ring out of the dock)",
		ifMissing: "as above: the ring is not found"
	},
	{
		needles: ["_tabActive"],
		severity: "silent",
		where: "dsh client (the conversation tab strip)",
		usedBy: "lib/assets/mobile.js (cloning the native tab's look for 项目/信息)",
		ifMissing: "the injected tabs lose the native styling but stay usable"
	},
	{
		needles: ["_tabs"],
		severity: "silent",
		where: "dsh client (the conversation tab strip's open state)",
		usedBy: "lib/assets/mobile.css (which native tab the injected panel yields to)",
		ifMissing: "an injected panel can stay open over a native tab"
	},
	{
		needles: ["_root"],
		severity: "silent",
		where: "dsh client (the chat root and the sidebar root)",
		usedBy: "lib/assets/mobile.js, lib/assets/mobile.css",
		ifMissing: "the 信息 panel loses its container, and the sidebar-as-drawer rule stops matching"
	},
	{
		needles: ["_tools", "_add", "_card"],
		severity: "silent",
		where: "dsh client (the composer: its card, tool row and add button)",
		usedBy: "lib/assets/mobile.js (the attach button)",
		ifMissing: "no attach button on the phone: files can no longer be sent from the system picker"
	},
	{
		needles: ["_panel", "_nav", "_navList", "_navCell", "_navTitle"],
		severity: "silent",
		where: "dsh client (the settings sheet: panel, nav bar, tab list, tab cell, title)",
		usedBy: "lib/assets/mobile.css, lib/assets/mobile.js",
		ifMissing: "the settings sheet reverts to a cramped desktop dialog on the phone, and the one-row fit stops working"
	},
	{
		needles: ["_overlay", "_content", "_options"],
		severity: "silent",
		where: "dsh client (the settings sheet: overlay, content, the scrolling options list)",
		usedBy: "lib/assets/mobile.js (replacing the models page's dead-end card)",
		ifMissing: "the 'settings are unavailable in this browser' dead end comes back, Retry and all"
	},
	{
		needles: ["settings are unavailable in this browser"],
		severity: "silent",
		where: "dsh client (the models settings page's failure wording)",
		usedBy: "lib/assets/mobile.js (matching the card to replace)",
		ifMissing: "the failure card stays as upstream wrote it; the note is not shown"
	},
	{
		needles: ["Preview Notice", "预览版说明", "Continue"],
		severity: "silent",
		where: "dsh client (the preview notice: heading and button)",
		usedBy: "lib/assets/mobile.js (dismissing it on each remote load)",
		ifMissing: "the phone shows the notice on every load and the reader taps 继续 each time. All three must match before anything is clicked"
	},
	{
		needles: ["data-sidebar-collapsed", "_frame", "_sidebarCol", "data-slot"],
		severity: "silent",
		where: "dsh client (the layout: sidebar state, frame, sidebar column, slots)",
		usedBy: "lib/assets/mobile.css (the sidebar-as-drawer rules)",
		ifMissing: "an expanded sidebar keeps its 280px track on the phone and squeezes the main column to a sliver"
	},
	{
		needles: ["100vw"],
		severity: "silent",
		where: "dsh client, narrow layout (the viewport-width inline size dsh writes on every panel host)",
		usedBy: "lib/assets/mobile.css (folding it back into layout pixels under a page zoom)",
		ifMissing: "harmless when dsh stops writing it; if it starts writing another unit the fold is not applied and a zoomed phone hangs its panes off the left edge again"
	},
	{
		needles: ["dsh.sessions.current"],
		severity: "silent",
		where: "dsh client (the workspace UI's current-session key in localStorage)",
		usedBy: "lib/assets/project.html (which session's workspace the phone browser opens)",
		ifMissing: "the 项目 browser opens no workspace: it asks for a session first"
	},
	{
		needles: ["tables", "workspaces"],
		severity: "silent",
		where: "dsh's workspace store (its table shape, and the table's name)",
		usedBy: "lib/project.js (session to workspace), lib/layout.js (the store's path under the DSH home)",
		ifMissing: "the 项目 browser 404s for every session"
	},
	{
		needles: ["uploadFileBinary"],
		severity: "note",
		where: "dsh client/server (the binary upload route)",
		usedBy: "lib/remote.js (a hint that forces streaming when a length is not declared)",
		ifMissing: "uploads still stream whenever the browser declares a length, which is the normal case"
	},

	{
		needles: ["data-plugin-panel"],
		severity: "silent",
		where: "dsh client (the plugins page: the section wrapping its page head)",
		usedBy: "lib/assets/mobile.css (the phone layout of the page head: the Add plugin button and the intro line)",
		ifMissing: "on the phone the Add plugin button is squeezed until its text wraps out of the pill, and the intro wraps onto a second line"
	},

	// --- the response-side rewrite's needles
	{
		needles: ["width=device-width, initial-scale=1"],
		severity: "silent",
		where: "dsh frontend (the SPA entry document's viewport meta)",
		usedBy: "lib/enhance.js (the iOS no-zoom viewport)",
		ifMissing: "iOS auto-zooms on the phone's composer and never restores"
	},
	{
		needles: ['<div id="root"></div>'],
		severity: "silent",
		where: "dsh frontend (the SPA entry document's mount point)",
		usedBy: "lib/enhance.js (the splash overlay)",
		ifMissing: "the phone's first load shows a blank screen instead of progress"
	},
	{
		needles: ["</head>"],
		severity: "silent",
		where: "dsh frontend (the SPA entry document)",
		usedBy: "lib/enhance.js (injecting the mobile stylesheet and script)",
		ifMissing: "the whole mobile layer is not injected: the phone gets dsh's desktop UI"
	}
];

/* ------------------------------------------------------------------ reading a target */

const TEXT_FILE = /\.(js|mjs|cjs|css|json|html|yml|yaml|md)$/u;
/** Files larger than this are skipped: nothing that carries an anchor is that big. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Walk a directory, following symlinked directories (lstat reports the link, not the target). */
async function* walkDirectory(root) {
	// A junction that points back into its own tree would otherwise loop the walk forever.
	const seen = new Set();
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			if (!isDir && !isFile) {
				// A linked package tree is a symlink to a directory, and lstat does not say so.
				try {
					const info = await stat(full);
					isDir = info.isDirectory();
					isFile = info.isFile();
				} catch {
					continue;
				}
			}
			if (isDir) {
				try {
					const real = await realpath(full);
					if (seen.has(real)) continue;
					seen.add(real);
				} catch {
					continue;
				}
				stack.push(full);
			} else if (isFile && TEXT_FILE.test(entry.name)) yield full;
		}
	}
}

/**
 * Find which needles appear in a target, with one witness path each.
 * @param target - `{ kind: "asar", archive }` or `{ kind: "dir", root }`.
 * @param needles - the strings to look for.
 * @returns a `Map` from needle to witness path.
 */
async function scan(target, needles) {
	const wanted = needles.map((needle) => ({ needle, bytes: Buffer.from(needle, "utf8") }));
	const found = new Map();
	/** One pass over the target; each file is checked against whatever is still missing. */
	const inspect = (path, bytes) => {
		for (const item of wanted) {
			if (found.has(item.needle)) continue;
			if (bytes.indexOf(item.bytes) >= 0) found.set(item.needle, path);
		}
		return found.size === wanted.length;
	};

	if (target.kind === "asar") {
		const raw = readFileSync(target.archive);
		// One pickle: [payload size][string length][JSON][padding]. The JSON's own braces are
		// steadier than trusting every field of that framing.
		const dataStart = 8 + raw.readUInt32LE(4);
		const text = raw.subarray(0, dataStart).toString("utf8");
		const open = text.indexOf("{");
		let depth = 0;
		let close = -1;
		for (let at = open; at >= 0 && at < text.length; at += 1) {
			if (text[at] === "{") depth += 1;
			else if (text[at] === "}" && --depth === 0) {
				close = at;
				break;
			}
		}
		if (open < 0 || close < 0) throw new Error(`${target.archive}: no header JSON`);
		const header = JSON.parse(text.slice(open, close + 1));
		const walk = function* (node, prefix = "") {
			for (const [name, entry] of Object.entries(node.files ?? {})) {
				const path = prefix === "" ? name : `${prefix}/${name}`;
				if (entry.files === undefined) yield [path, entry];
				else yield* walk(entry, path);
			}
		};
		for (const [path, entry] of walk(header)) {
			if (!TEXT_FILE.test(path)) continue;
			if (Number(entry.size ?? 0) > MAX_FILE_BYTES) continue;
			const at = dataStart + Number(entry.offset);
			if (inspect(path, raw.subarray(at, at + entry.size))) return found;
		}
		return found;
	}

	for await (const path of walkDirectory(target.root)) {
		let bytes;
		try {
			if ((await stat(path)).size > MAX_FILE_BYTES) continue;
			bytes = await readFile(path);
		} catch {
			continue;
		}
		if (inspect(relative(target.root, path).split("\\").join("/"), bytes)) return found;
	}
	return found;
}

/* ------------------------------------------------------------------ the table's own coverage */

/**
 * Which literal each file in `dsh-remote/lib` uses that looks like an upstream anchor.
 * @param libDir - that package's `lib`.
 * @returns a `Map` from literal to the set of files using it.
 */
async function usedAnchors(libDir) {
	const used = new Map();
	const add = (literal, file) => {
		if (typeof literal !== "string" || literal.length < 2) return;
		const files = used.get(literal) ?? new Set();
		files.add(file);
		used.set(literal, files);
	};
	const files = [
		"assets/mobile.js",
		"assets/mobile.css",
		"assets/project.html",
		"index.js",
		"layout.js",
		"remote.js",
		"enhance.js",
		"project.js",
		"settings.js",
		"session.js",
		"qr.js"
	];
	for (const file of files) {
		let source;
		try {
			source = await readFile(join(libDir, file), "utf8");
		} catch {
			continue;
		}
		for (const match of source.matchAll(/\[(?:class|style)\*="([^"]+)"\]/gu)) add(match[1].split(":").pop().trim(), file);
		for (const match of source.matchAll(/\[data-slot="([^"]+)"\]/gu)) add(match[1], file);
		for (const match of source.matchAll(/data-composer-stats|data-sidebar-collapsed|aria-haspopup|dsh\.sessions\.current/gu)) add(match[0], file);
		for (const match of source.matchAll(/Buffer\.from\((['"])(.+?)\1/gu)) add(match[2], file);
		for (const match of source.matchAll(/ctx\.get\("([^"]+)"\)/gu)) add(match[1], file);
		for (const match of source.matchAll(/inject\(\[([^\]]*)\]/gu)) {
			for (const name of match[1].matchAll(/"([^"]+)"/gu)) add(name[1], file);
		}
		for (const match of source.matchAll(/on\("([\w-]+\/[\w-]+)"/gu)) add(match[1], file);
	}
	return used;
}

/* ------------------------------------------------------------------ main */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? undefined : args[at + 1];
};

if (flag("help") || flag("h")) {
	console.log(
		[
			"usage: node tools/anchors/anchors.mjs [--asar <app.asar>] [--dir <dsh node_modules>] [--json] [--list] [--no-coverage]",
			"",
			"With neither --asar nor --dir, the official app's app.asar is used when it exists.",
			"Exit code 1 when a product anchor is missing."
		].join("\n")
	);
	process.exit(0);
}

const NEEDLES = ANCHORS.flatMap((anchor) => anchor.needles);

if (flag("list")) {
	for (const anchor of ANCHORS) console.log(`${anchor.severity.padEnd(8)} ${anchor.needles.join(", ")}`);
	process.exit(0);
}

/** The builds worth probing on this machine, in the order they are worth probing. */
const DEFAULT_TARGETS = [
	{ kind: "asar", archive: "F:\\Code\\dsh\\resources\\app.asar" },
	{ kind: "dir", root: "F:\\DSHDesktop\\runtime\\windows-x64\\dsh\\node_modules" }
];

let target;
if (typeof value("asar") === "string") target = { kind: "asar", archive: resolve(value("asar")) };
else if (typeof value("dir") === "string") target = { kind: "dir", root: resolve(value("dir")) };
else {
	target = DEFAULT_TARGETS.find((candidate) => {
		try {
			return statSync(candidate.kind === "asar" ? candidate.archive : candidate.root).isDirectory() !== (candidate.kind === "asar");
		} catch {
			return false;
		}
	});
	if (target === undefined) {
		console.error("no dsh build to probe: pass --asar <app.asar> or --dir <node_modules>");
		process.exit(2);
	}
}

const found = await scan(target, NEEDLES);
/** An anchor counts as missing when none of its needles is there. */
const missingNeedles = NEEDLES.filter((needle) => !found.has(needle));
const missing = ANCHORS.filter((anchor) => anchor.needles.every((needle) => !found.has(needle)));
const product = missing.filter((anchor) => anchor.severity !== "note");

if (flag("json")) {
	console.log(
		JSON.stringify(
			{
				target,
				present: NEEDLES.length - missingNeedles.length,
				total: NEEDLES.length,
				missing: missing.map(({ needles, severity, usedBy, ifMissing }) => ({ needles, severity, usedBy, ifMissing }))
			},
			null,
			1
		)
	);
} else {
	console.log(`anchor probe: ${target.kind === "asar" ? target.archive : target.root}`);
	console.log(`${NEEDLES.length - missingNeedles.length}/${NEEDLES.length} anchors present\n`);
	for (const anchor of ANCHORS) {
		const witnesses = anchor.needles.map((needle) => [needle, found.get(needle)]);
		const gone = witnesses.filter(([, witness]) => witness === undefined);
		const mark = gone.length === 0 ? "ok     " : gone.length === anchor.needles.length ? "MISSING" : "partial";
		console.log(`${mark} [${anchor.severity}] ${anchor.needles.join(", ")}`);
		if (gone.length === 0) {
			console.log(`         in: ${witnesses[0][1]}`);
			continue;
		}
		console.log(`         gone: ${gone.map(([needle]) => needle).join(", ")}`);
		console.log(`         wants: ${anchor.where}`);
		console.log(`         used by: ${anchor.usedBy}`);
		console.log(`         if it is gone: ${anchor.ifMissing}`);
	}
}

if (!flag("no-coverage")) {
	const here = dirname(fileURLToPath(import.meta.url));
	const used = await usedAnchors(join(here, "..", "..", "dsh-remote", "lib"));
	const uncovered = [...used.entries()].filter(
		([literal]) => !NEEDLES.some((needle) => needle.includes(literal) || literal.includes(needle))
	);
	// A class selector that only ever appears in the stylesheet costs that element its phone
	// styling when dsh renames it, which the reader sees rather than this table. A literal the
	// layer's scripts use is a behaviour, and belongs in the table.
	const styling = uncovered.filter(([, files]) => [...files].every((file) => file.endsWith(".css")));
	const behavioural = uncovered.filter(([, files]) => [...files].some((file) => !file.endsWith(".css")));
	console.log(
		behavioural.length === 0
			? "\ncoverage: every behavioural anchor literal in dsh-remote/lib is in the table above"
			: `\ncoverage: ${behavioural.length} behavioural literal(s) the table does not mention, add them:\n  ${behavioural
					.map(([literal, files]) => `${literal} (${[...files].join(", ")})`)
					.join("\n  ")}`
	);
	console.log(`coverage: ${styling.length} styling-only selector(s) are deliberately out of the table (a miss costs that element's phone styling): ${styling
		.map(([literal]) => literal)
		.join(", ")}`);
}

if (product.length > 0) {
	console.log(`\n${product.length} product anchor(s) missing: the phone layer or the proxy will degrade in the ways listed above.`);
}
process.exit(product.length === 0 ? 0 : 1);
