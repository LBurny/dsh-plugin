/**
 * Read files out of an Electron `app.asar` without Electron: the format is a
 * pickle-framed JSON header followed by the concatenated file data.
 *
 *   node tools/asar.mjs <archive> --list [prefix]
 *   node tools/asar.mjs <archive> --cat <path>
 */
import { readFileSync } from "node:fs";

const [archive, mode, ...rest] = process.argv.slice(2);
if (!archive || !mode) {
	console.error("usage: asar.mjs <archive> --list [prefix] | --cat <path>");
	process.exit(2);
}

const raw = readFileSync(archive);
// The header is one pickle: [payload size][string length][JSON][padding]. Scanning
// for the JSON's own braces is steadier than trusting every field of that framing.
const dataStart = 8 + raw.readUInt32LE(4);
const text = raw.subarray(0, dataStart).toString("utf8");
const open = text.indexOf("{");
let depth = 0;
let close = -1;
for (let at = open; at < text.length; at++) {
	if (text[at] === "{") depth += 1;
	else if (text[at] === "}" && --depth === 0) {
		close = at;
		break;
	}
}
if (open < 0 || close < 0) {
	console.error(`${archive}: could not find the header JSON`);
	process.exit(1);
}
const header = JSON.parse(text.slice(open, close + 1));

/** Walk the header tree, yielding `path -> {offset, size}` for files. */
function* walk(node, prefix = "") {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const path = prefix === "" ? name : `${prefix}/${name}`;
		if (entry.files === undefined) yield [path, entry];
		else yield* walk(entry, path);
	}
}

if (mode === "--list") {
	const prefix = rest[0] ?? "";
	for (const [path, entry] of walk(header)) {
		if (!path.startsWith(prefix)) continue;
		console.log(`${String(entry.size ?? 0).padStart(9)}  ${path}`);
	}
} else if (mode === "--cat") {
	const wanted = rest.join(" ");
	for (const [path, entry] of walk(header)) {
		if (path !== wanted) continue;
		process.stdout.write(raw.subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + entry.size));
		process.exit(0);
	}
	console.error(`not in archive: ${wanted}`);
	process.exit(1);
} else if (mode === "--grep") {
	// Which packed file carries a string — far cheaper than extracting packages
	// one by one while hunting for a class name or an anchor.
	const needle = Buffer.from(rest.join(" "), "utf8");
	const hits = [];
	for (const [path, entry] of walk(header)) {
		if (!/\.(js|mjs|cjs|css|json|md)$/u.test(path)) continue;
		const at = Number(entry.offset);
		if (raw.subarray(dataStart + at, dataStart + at + entry.size).indexOf(needle) >= 0) hits.push(path);
	}
	console.log(hits.join("\n"));
} else {
	console.error(`unknown mode ${mode}`);
	process.exit(2);
}
