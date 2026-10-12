/**
 * Checks for the skill store (lib/skills.js) and its ZIP import path
 * (lib/zip.js): directory moves, archive parsing, skill discovery layouts,
 * traversal protection and extraction. The archives are built here in memory.
 *
 * Run from an installed plugin copy, where `layout` paths exist:
 *   node test/skills.test.mjs
 */
import { deflateRawSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, discoverZipSkills, extractZipPrefix, listEntries, normalizeEntryName, readEntry, ZipError } from "../lib/zip.js";
import {
	deleteSkill,
	importSkills,
	importSources,
	importZipSkills,
	inspectZipSkills,
	listImportable,
	listSkills,
	setSkillEnabled,
	skillStats
} from "../lib/skills.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/** Whether a path exists. */
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build a minimal ZIP archive in memory: local headers + central directory +
 * EOCD, with the real CRC-32 written into both headers, the way an ordinary zip
 * tool writes it. `crc` overrides that field alone, which is how the reader's
 * integrity check is exercised.
 * @param entries - `[{ name, data: Buffer, method: 0|8, crc? }]`.
 */
function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBytes = Buffer.from(entry.name, "utf8");
		const data = entry.method === 8 ? deflateRawSync(entry.data) : entry.data;
		const crc = entry.crc ?? crc32(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(entry.method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(entry.method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		// The declared uncompressed size is authoritative for the reader, so a bomb
		// test needs to lie about it here.
		central.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const cdStart = offset;
	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(cdStart, 16);
	return Buffer.concat([...locals, directory, eocd]);
}

/** Expect a ZipError from a sync/async body. */
async function expectZipError(fn, label) {
	try {
		await fn();
	} catch (error) {
		check(error instanceof ZipError, label, String(error?.message ?? error));
		return;
	}
	check(false, label, "no error was thrown");
}

/* ------------------------------------------------------------- name rules */

check(normalizeEntryName("dir/file.md") === "dir/file.md", "plain relative name passes");
check(normalizeEntryName("dir\\file.md") === "dir/file.md", "backslashes are unified");
check(normalizeEntryName("dir/") === "dir", "a directory entry normalizes without the slash");
check(normalizeEntryName("../escape") === undefined, "dot-dot is rejected");
check(normalizeEntryName("a/./b") === undefined, "dot segments are rejected");
check(normalizeEntryName("/abs/path") === undefined, "absolute paths are rejected");
check(normalizeEntryName("C:/Windows/x") === undefined, "drive-qualified paths are rejected");
check(normalizeEntryName("a//b") === undefined, "empty segments are rejected");

/* -------------------------------------------------------- reader round trip */

const archive = buildZip([
	{ name: "alpha/SKILL.md", data: Buffer.from("---\nname: alpha\ndescription: \"Alpha skill\"\n---\n\nBody\n", "utf8"), method: 8 },
	{ name: "alpha/scripts/run.sh", data: Buffer.from("#!/bin/sh\necho hi\n", "utf8"), method: 0 },
	{ name: "beta/SKILL.md", data: Buffer.from("---\nname: beta\n---\n", "utf8"), method: 0 },
	{ name: "beta/", data: Buffer.alloc(0), method: 0 },
	{ name: "../evil.txt", data: Buffer.from("nope", "utf8"), method: 0 }
]);

const entries = listEntries(archive);
check(entries.length === 5, "central directory lists every entry", String(entries.length));
check(entries[0].method === 8 && entries[1].method === 0, "methods are parsed");
const inflated = readEntry(archive, entries[0]);
check(inflated.toString("utf8").includes("name: alpha"), "deflated entry inflates", inflated.length);
const stored = readEntry(archive, entries[1]);
check(stored.toString("utf8").startsWith("#!/bin/sh"), "stored entry reads verbatim");

// A bit flip in a stored entry is invisible to the format, which is what the central
// directory's CRC is for: without the check a corrupt archive imports silently.
const rotted = buildZip([{ name: "SKILL.md", data: Buffer.from("---\nname: rotted\n---\n", "utf8"), method: 0, crc: crc32(Buffer.from("something else entirely", "utf8")) }]);
await expectZipError(() => readEntry(rotted, listEntries(rotted)[0]), "an entry whose bytes do not match its CRC is rejected");
check(crc32(Buffer.from("123456789", "utf8")) === 0xcbf43926, "crc32 matches the standard check value", String(crc32(Buffer.from("123456789", "utf8"))));

await expectZipError(() => listEntries(Buffer.from("not a zip at all", "utf8")), "garbage is not a ZIP");
await expectZipError(() => listEntries(Buffer.alloc(10)), "a truncated buffer is not a ZIP");

// A deflate entry that expands past its declared size is a zip bomb: inflation must be
// capped at the declaration, or a 64 MiB upload can allocate gigabytes before any size
// check runs. Here 4 MiB of content declares 64 bytes.
const bomb = buildZip([{ name: "SKILL.md", data: Buffer.alloc(4 * 1024 * 1024, 0x41), method: 8, declaredSize: 64 }]);
await expectZipError(() => readEntry(bomb, listEntries(bomb)[0]), "an entry that inflates past its declared size is rejected as a bomb");

/* ---------------------------------------------------------------- discovery */

const discovered = discoverZipSkills(archive, "pack.zip");
check(discovered.length === 2, "two top-level skill directories are discovered", JSON.stringify(discovered.map((s) => s.name)));
check(discovered[0].name === "alpha" && discovered[1].name === "beta", "skills sort by name");
check(discovered[0].description === "Alpha skill", "frontmatter description is read");
check(discovered.every((s) => s.prefix.endsWith("/")), "directory skills carry a prefix");

// Root-level SKILL.md: single skill, named by frontmatter, then by file name.
const single = buildZip([{ name: "SKILL.md", data: Buffer.from("---\nname: solo\ndescription: one\n---\n", "utf8"), method: 8 }]);
check(discoverZipSkills(single, "pack.zip")[0].name === "solo", "root SKILL.md names the skill from frontmatter");
const unnamed = buildZip([{ name: "SKILL.md", data: Buffer.from("no frontmatter\n", "utf8"), method: 0 }]);
check(discoverZipSkills(unnamed, "fallback-name.zip")[0].name === "fallback-name", "missing frontmatter falls back to the archive name");

await expectZipError(() => discoverZipSkills(buildZip([{ name: "readme.txt", data: Buffer.from("x"), method: 0 }]), "x.zip"), "an archive without SKILL.md is rejected");

/* --------------------------------------------------------------- extraction */

const dir = await mkdtemp(join(tmpdir(), "kit-zip-"));
const out = join(dir, "out");
const extracted = await extractZipPrefix(archive, "alpha/", out);
check(extracted.files === 2, "extraction counts the prefix's files", String(extracted.files));
check((await readFile(join(out, "SKILL.md"), "utf8")).includes("name: alpha"), "SKILL.md extracted with the prefix stripped");
check((await readFile(join(out, "scripts", "run.sh"), "utf8")).startsWith("#!/bin/sh"), "nested files extract");
check(!(await exists(join(dir, "evil.txt"))), "traversal entries cannot escape the target");

/* --------------------------------------------- skills store ZIP integration */

const skillsDir = join(dir, "skills");
const layout = { skillsDir, skillsDisabledDir: join(dir, "skills-disabled") };
const inspected = await inspectZipSkills(layout, archive, "pack.zip");
check(inspected.length === 2 && inspected.every((s) => s.conflict === false), "inspection marks no conflicts on an empty store");

const first = await importZipSkills(layout, archive, "pack.zip", ["alpha"], "skip");
check(first.imported.length === 1 && first.imported[0] === "alpha", "import writes the selected skill");
check((await exists(join(skillsDir, "alpha", "SKILL.md"))), "the imported skill is in the enabled root");

const again = await inspectZipSkills(layout, archive, "pack.zip");
check(again.find((s) => s.name === "alpha")?.conflict === true, "re-inspection marks the conflict");
check(again.find((s) => s.name === "beta")?.conflict === false, "the unimported skill stays conflict-free");

const second = await importZipSkills(layout, archive, "pack.zip", ["alpha", "beta"], "skip");
check(second.imported.length === 1 && second.imported[0] === "beta", "skip policy imports only the new skill");
check(second.skipped.length === 1 && second.skipped[0].name === "alpha", "the conflicting skill is skipped");

await writeFile(join(skillsDir, "alpha", "extra.txt"), "stale", "utf8");
const third = await importZipSkills(layout, archive, "pack.zip", ["alpha"], "overwrite");
check(third.imported.length === 1, "overwrite re-imports");
check(!(await exists(join(skillsDir, "alpha", "extra.txt"))), "overwrite clears the previous copy first");

const bogus = await importZipSkills(layout, archive, "pack.zip", ["gamma"], "skip");
check(bogus.errors.length === 1, "a name missing from the archive reports an error");

/* ------------------------------------------------------- skills store moves */

// The store half: a directory with SKILL.md is a skill; moving it between the
// two roots is the enable switch. dsh's own watcher picks the move up.
const storeDir = await mkdtemp(join(tmpdir(), "kit-skills-"));
const store = { skillsDir: join(storeDir, "skills"), skillsDisabledDir: join(storeDir, "skills-disabled") };
await mkdir(join(store.skillsDir, "alpha"), { recursive: true });
await writeFile(join(store.skillsDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: \"Alpha skill\"\n---\n\nBody\n", "utf8");
await mkdir(join(store.skillsDir, "not-a-skill"), { recursive: true });
await writeFile(join(store.skillsDir, "not-a-skill", "readme.md"), "no SKILL.md here\n", "utf8");

let listed = await listSkills(store);
check(listed.length === 1, "a directory without SKILL.md is not a skill", JSON.stringify(listed.map((skill) => skill.name)));
check(listed[0].name === "alpha", "the skill name comes from the directory");
check(listed[0].description === "Alpha skill", "the frontmatter description is unquoted", listed[0].description);
check(listed[0].enabled === true, "a skill in the active root reads as enabled");
check((await skillStats(store)).enabled === 1, "stats count the enabled skills");

await setSkillEnabled(store, "alpha", false);
listed = await listSkills(store);
check(listed[0].enabled === false, "disabling is reflected in the listing");
check(await exists(join(store.skillsDisabledDir, "alpha", "SKILL.md")), "the disabled skill moved to the bypass root");
check(!(await exists(join(store.skillsDir, "alpha"))), "the active root no longer holds it");

// Occupying the destination must fail loudly rather than overwrite a skill.
await setSkillEnabled(store, "alpha", true);
await mkdir(join(store.skillsDisabledDir, "alpha"), { recursive: true });
await writeFile(join(store.skillsDisabledDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n", "utf8");
let conflictReported = false;
try {
	await setSkillEnabled(store, "alpha", false);
} catch (error) {
	conflictReported = String(error?.message ?? error).includes("already exists");
}
check(conflictReported, "toggling into an occupied root reports a conflict instead of clobbering");
check((await listSkills(store)).filter((skill) => skill.enabled).length === 1, "the conflicting toggle changed nothing");

await deleteSkill(store, "alpha");
check((await listSkills(store)).filter((skill) => skill.enabled).length === 0, "delete removes the skill");

let traversalRejected = false;
try {
	await deleteSkill(store, "../escape");
} catch {
	traversalRejected = true;
}
check(traversalRejected, "a traversing skill name is rejected");

await rm(storeDir, { recursive: true, force: true });

/* --------------------------------------------------- importing from a farm */

// The other agent tools usually share one checkout and link it into every root
// (that is what cc-switch does), so an import source is full of symlinks. A
// symlinked entry is a skill, and importing it must land real files in the
// managed root instead of a link back into the foreign farm.
const homeDir = await mkdtemp(join(tmpdir(), "kit-farm-home-"));
const derived = importSources(homeDir);
check(derived.length === 3 && derived.map((s) => s.id).join(",") === "codex,claude,opencode", "the default sources are the three agent tools", derived.map((s) => s.id).join(","));
check(derived[0].dir === join(homeDir, ".codex", "skills"), "a source path hangs off the home directory", derived[0].dir);

const sharedDir = join(homeDir, "shared", "alpha");
await mkdir(sharedDir, { recursive: true });
await writeFile(join(sharedDir, "SKILL.md"), "---\nname: alpha\ndescription: \"From the farm\"\n---\n\nBody\n", "utf8");
const sourceDir = join(homeDir, ".codex", "skills");
await mkdir(sourceDir, { recursive: true });
let sourceIsLink = true;
try {
	await symlink(sharedDir, join(sourceDir, "alpha"), "junction");
} catch {
	sourceIsLink = false;
	await mkdir(join(sourceDir, "alpha"), { recursive: true });
	await writeFile(join(sourceDir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: \"From the farm\"\n---\n", "utf8");
}
await mkdir(join(sourceDir, "not-a-skill"), { recursive: true });
await writeFile(join(sourceDir, "not-a-skill", "SKILL.md.bak"), "no marker\n", "utf8");

const importStore = { skillsDir: join(homeDir, "store", "skills"), skillsDisabledDir: join(homeDir, "store", "skills-disabled") };
const offered = await listImportable(importStore, importSources(homeDir));
check(offered[0].available === true, "a readable source is reported as available", JSON.stringify(offered[0]));
check(offered[0].skills.length === 1 && offered[0].skills[0].name === "alpha", `a ${sourceIsLink ? "symlinked " : ""}skill in a source is offered for import`, JSON.stringify(offered[0].skills.map((s) => s.name)));
check(offered[0].skills[0].description === "From the farm", "the offered skill carries its description", offered[0].skills[0].description);
check(offered[0].skills[0].conflict === false, "nothing installed yet means no conflict");
check(offered[1].available === false && offered[1].skills.length === 0, "an absent source is reported as unavailable with no skills", JSON.stringify(offered[1]));

const imported = await importSkills(importStore, "codex", ["alpha"], "skip", importSources(homeDir));
check(imported.imported.length === 1 && imported.imported[0] === "alpha", "the offered skill imports", JSON.stringify(imported));
check((await lstat(join(importStore.skillsDir, "alpha"))).isDirectory(), "the imported copy is a real directory, not a link into the source farm");
check((await readFile(join(importStore.skillsDir, "alpha", "SKILL.md"), "utf8")).includes("From the farm"), "the imported copy holds the skill's files");
check((await listImportable(importStore, importSources(homeDir)))[0].skills[0].conflict === true, "a second import reports the conflict");
check((await listSkills(importStore)).length === 1, "the imported skill is listed by the store", JSON.stringify((await listSkills(importStore)).map((s) => s.name)));

let unknownSource = false;
try {
	await importSkills(importStore, "nope", ["alpha"], "skip", importSources(homeDir));
} catch (error) {
	unknownSource = String(error?.message ?? error).includes("unknown import source");
}
check(unknownSource, "an unknown source id is rejected");

// A failed copy must not leave a half-imported skill in the managed root: a
// self-referential link inside the source makes `cp` throw part-way (ELOOP), and the
// partial tree used to stay behind, listed as installed and refusing later imports.
const loopyDir = join(sourceDir, "loopy");
await mkdir(loopyDir, { recursive: true });
await writeFile(join(loopyDir, "SKILL.md"), "---\nname: loopy\n---\n", "utf8");
let loopArmed = true;
try {
	await symlink(loopyDir, join(loopyDir, "loop"), "junction");
} catch {
	loopArmed = false;
}
if (loopArmed) {
	let loopThrew = false;
	try {
		await importSkills(importStore, "codex", ["loopy"], "overwrite", importSources(homeDir));
	} catch {
		loopThrew = true;
	}
	check(loopThrew, "a symlink loop inside the source fails the import");
	check(!(await exists(join(importStore.skillsDir, "loopy"))), "a failed copy leaves nothing in the managed root", "");

	// The same failure on top of an *existing* skill is the case that used to lose data:
	// the old copy was deleted before the new one was copied, so a failed overwrite left
	// the reader with neither. Nothing may be touched until the new copy is complete.
	await mkdir(join(importStore.skillsDir, "loopy"), { recursive: true });
	await writeFile(join(importStore.skillsDir, "loopy", "SKILL.md"), "---\nname: loopy\ndescription: the original\n---\n", "utf8");
	let overwriteThrew = false;
	try {
		await importSkills(importStore, "codex", ["loopy"], "overwrite", importSources(homeDir));
	} catch {
		overwriteThrew = true;
	}
	const survived = await readFile(join(importStore.skillsDir, "loopy", "SKILL.md"), "utf8").catch(() => "");
	check(overwriteThrew && survived.includes("the original"), "a failed overwrite leaves the skill that was already installed", survived.replace(/\s+/gu, " ").trim());
}

// The ZIP path replaces the same way: a name that cannot be installed must not cost the
// copy already in place.
const clashZip = buildZip([{ name: "clash/SKILL.md", data: Buffer.from("---\nname: clash\ndescription: the new one\n---\n", "utf8"), method: 0 }]);
await mkdir(join(importStore.skillsDir, "clash"), { recursive: true });
await writeFile(join(importStore.skillsDir, "clash", "SKILL.md"), "---\nname: clash\ndescription: the original\n---\n", "utf8");
const zipOver = await importZipSkills(importStore, clashZip, "pack.zip", ["clash"], "overwrite");
const zipKept = await readFile(join(importStore.skillsDir, "clash", "SKILL.md"), "utf8");
check(zipOver.imported.length === 1 && zipKept.includes("the new one"), "a ZIP overwrite installs the new copy over the old one", zipOver.imported.join(","));


// A destination that cannot be created (a stray file sits where the skill dir would
// go) must fail that one name, not the whole import after earlier names landed.
const blockedZip = buildZip([
	{ name: "good/SKILL.md", data: Buffer.from("---\nname: good\n---\n", "utf8"), method: 0 },
	{ name: "blocked/SKILL.md", data: Buffer.from("---\nname: blocked\n---\n", "utf8"), method: 0 }
]);
await mkdir(importStore.skillsDir, { recursive: true });
await writeFile(join(importStore.skillsDir, "blocked"), "not a directory\n", "utf8");
const blocked = await importZipSkills(importStore, blockedZip, "pack.zip", ["good", "blocked"], "overwrite");
check(blocked.imported.join(",") === "good" && blocked.errors.length === 1, "an uncreatable destination fails only its own name", JSON.stringify(blocked));

await rm(homeDir, { recursive: true, force: true });

/* -------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nSKILLS TEST PASS (${results.length} checks)` : `\nSKILLS TEST FAIL (${failed.length}/${results.length})`);
await rm(dir, { recursive: true, force: true });
if (failed.length > 0) process.exitCode = 1;
