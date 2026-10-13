/**
 * Minimal ZIP reader for skill-pack imports — no dependency, just the central
 * directory plus `zlib.inflateRawSync`.
 *
 * The desktop shell imports skills from ZIP files with the `zip` crate; the
 * plugin needs the same capability without taking a dependency into the
 * profile's pnpm-managed `node_modules`. Skill archives are produced by
 * ordinary zip tools, so the reader deliberately covers the common subset:
 * stored and deflated entries, no encryption, no ZIP64, no multi-disk.
 * Anything outside the subset fails with a clear "invalid ZIP" error rather
 * than a half-read.
 *
 * Safety rules mirror the shell (`src-tauri/src/features/skills.rs`):
 *  - entry names are normalized (`\` → `/`) and must be relative: no drive
 *    letters, no leading `/`, no `.`/`..`/empty segments — anything else is
 *    skipped, so an archive cannot write outside the target directory;
 *  - entry count and total extracted bytes are capped against zip bombs.
 *
 * @module dsh-skills/lib/zip
 */
import { inflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Entries the reader walks at most (bomb guard, same value as the shell). */
export const MAX_ZIP_ENTRIES = 10_000;
/** Total uncompressed bytes extraction may write (bomb guard, same as shell). */
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD is 22 bytes plus a comment of up to 65535 bytes. */
const EOCD_SEARCH_WINDOW = 22 + 0xffff;
/** A size field of all-ones means the real value lives in a ZIP64 record. */
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

/** Failure every caller can show verbatim; "invalid ZIP" covers all format gaps. */
export class ZipError extends Error {}

function invalid(message = "not a valid ZIP archive") {
	return new ZipError(message);
}

/** CRC-32 (IEEE 802.3) lookup table, built once. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

/**
 * The CRC-32 a ZIP central directory records per entry. Verified on the way out because
 * a corrupted archive must fail loudly: a DEFLATE stream does not catch every bit flip,
 * and a stored entry is copied verbatim, so without this a truncated or bit-rotted upload
 * imports silently and the reader gets a corrupt SKILL.md with no error to tell them.
 * @param data - the entry's uncompressed bytes.
 * @returns the checksum as an unsigned 32-bit number.
 */
export function crc32(data) {
	let crc = 0xffffffff;
	for (let index = 0; index < data.length; index++) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Normalize an entry name to a relative, forward-slashed path, or return
 * `undefined` when the name tries to escape (absolute, drive-qualified, or
 * dot segments). Backslashes are unified first: the ZIP standard writes `/`,
 * but some tools write `\`.
 * @param name - raw entry name from the central directory.
 */
export function normalizeEntryName(name) {
	const text = String(name).replaceAll("\\", "/");
	if (text.startsWith("/") || /^[A-Za-z]:/u.test(text)) return undefined;
	const segments = text.split("/");
	// A trailing slash marks a directory entry; drop it before validating.
	if (segments.at(-1) === "") segments.pop();
	if (segments.length === 0) return undefined;
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") return undefined;
	}
	return segments.join("/");
}

/**
 * Parse the central directory of a ZIP buffer.
 * @param buffer - the whole archive in memory.
 * @returns entry list: `{ name, method, size, compressedSize, dataOffset }`,
 *   where `dataOffset` still points at the entry's *local* header.
 */
export function listEntries(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw invalid();
	// Find the end-of-central-directory record by scanning the tail backwards.
	const windowStart = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
	let eocd = -1;
	for (let at = buffer.length - 22; at >= windowStart; at--) {
		if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
			eocd = at;
			break;
		}
	}
	if (eocd === -1) throw invalid();
	const disk = buffer.readUInt16LE(eocd + 4);
	const cdDisk = buffer.readUInt16LE(eocd + 6);
	const total = buffer.readUInt16LE(eocd + 10);
	const cdSize = buffer.readUInt32LE(eocd + 12);
	const cdOffset = buffer.readUInt32LE(eocd + 16);
	if (disk !== 0 || cdDisk !== 0) throw invalid("multi-disk ZIP archives are not supported");
	if (total === ZIP64_SENTINEL_16 || cdSize === ZIP64_SENTINEL_32 || cdOffset === ZIP64_SENTINEL_32) {
		throw invalid("ZIP64 archives are not supported");
	}
	if (cdOffset + cdSize > buffer.length) throw invalid();
	if (total > MAX_ZIP_ENTRIES) throw invalid(`archive has more than ${String(MAX_ZIP_ENTRIES)} entries`);

	const entries = [];
	let at = cdOffset;
	for (let index = 0; index < total; index++) {
		if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw invalid();
		const flags = buffer.readUInt16LE(at + 8);
		const method = buffer.readUInt16LE(at + 10);
		const crc = buffer.readUInt32LE(at + 16);
		const compressedSize = buffer.readUInt32LE(at + 20);
		const size = buffer.readUInt32LE(at + 24);
		const nameLength = buffer.readUInt16LE(at + 28);
		const extraLength = buffer.readUInt16LE(at + 30);
		const commentLength = buffer.readUInt16LE(at + 32);
		const dataOffset = buffer.readUInt32LE(at + 42);
		if ((flags & 0x1) !== 0) throw invalid("encrypted ZIP entries are not supported");
		if (method !== 0 && method !== 8) throw invalid(`unsupported compression method ${String(method)}`);
		if (compressedSize === ZIP64_SENTINEL_32 || size === ZIP64_SENTINEL_32 || dataOffset === ZIP64_SENTINEL_32) {
			throw invalid("ZIP64 archives are not supported");
		}
		const nameStart = at + 46;
		if (nameStart + nameLength > buffer.length) throw invalid();
		const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
		entries.push({ name, method, size, compressedSize, crc, dataOffset, directory: name.endsWith("/") });
		at = nameStart + nameLength + extraLength + commentLength;
	}
	return entries;
}

/**
 * Read one entry's bytes. Sizes and the data offset come from the central
 * directory (authoritative), so entries written with data descriptors still
 * read correctly.
 * @param buffer - the whole archive.
 * @param entry - an entry from {@link listEntries}.
 */
export function readEntry(buffer, entry) {
	const at = entry.dataOffset;
	if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) throw invalid();
	const nameLength = buffer.readUInt16LE(at + 26);
	const extraLength = buffer.readUInt16LE(at + 28);
	const dataStart = at + 30 + nameLength + extraLength;
	if (dataStart + entry.compressedSize > buffer.length) throw invalid();
	const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
	let out;
	if (entry.method === 0) {
		out = Buffer.from(data);
	} else {
		try {
			// Cap the inflation at the declared size: a deflated entry that expands past
			// what its central directory claims is a bomb, and must never get to allocate
			// it (a 64 MiB upload can claim gigabytes).
			out = inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(entry.size, MAX_ZIP_BYTES)) });
		} catch (error) {
			if (error instanceof ZipError) throw error;
			throw invalid(`entry "${entry.name}" could not be inflated`);
		}
	}
	if (out.length !== entry.size) throw invalid(`entry "${entry.name}" decompressed to an unexpected size`);
	// The central directory's CRC is the only integrity check a ZIP carries, and neither the
	// stored path (copied verbatim) nor DEFLATE catches every corruption. Without this a
	// truncated or bit-rotted archive imports silently and the reader gets a corrupt file.
	if (crc32(out) !== entry.crc) throw invalid(`entry "${entry.name}" failed its CRC-32 check`);
	return out;
}

/** Skill names become directory names, so they stay deliberately narrow. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** `name` and `description` out of a SKILL.md frontmatter block (shallow scan). */
function parseFrontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
	if (match === null) return {};
	const fields = {};
	for (const line of match[1].split(/\r?\n/u)) {
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
		if (pair === null) continue;
		let value = pair[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[pair[1]] = value;
	}
	return fields;
}

/**
 * Discover the skills inside an archive, mirroring the shell's layout rules:
 *  - `SKILL.md` at the archive root → a single skill, named by its frontmatter
 *    `name` (falling back to the archive file name);
 *  - otherwise every top-level `<dir>/SKILL.md` is one skill, named by the dir.
 * @param buffer - the whole archive.
 * @param archiveName - the uploaded file name, used for the fallback name.
 * @returns `{ prefix, name, description }` list, sorted by name.
 */
export function discoverZipSkills(buffer, archiveName) {
	const entries = listEntries(buffer);
	const found = []; // { prefix, entry }
	for (const entry of entries) {
		if (entry.directory) continue;
		const name = normalizeEntryName(entry.name);
		if (name === undefined) continue;
		if (name === "SKILL.md") {
			found.push({ prefix: "", entry });
		} else if (name.endsWith("/SKILL.md") && name.indexOf("/") === name.lastIndexOf("/")) {
			const prefix = `${name.slice(0, name.indexOf("/"))}/`;
			if (!found.some((item) => item.prefix === prefix)) found.push({ prefix, entry });
		}
	}
	if (found.length === 0) throw new ZipError("no skill found in the archive (missing SKILL.md)");
	return found
		.map(({ prefix, entry }) => {
			const fields = parseFrontmatter(readEntry(buffer, entry).toString("utf8"));
			let name;
			if (prefix === "") {
				name = typeof fields.name === "string" && NAME_PATTERN.test(fields.name) ? fields.name : undefined;
				if (name === undefined) {
					const stem = String(archiveName ?? "").replace(/\.zip$/iu, "");
					if (!NAME_PATTERN.test(stem)) throw new ZipError("cannot determine a skill name from the archive");
					name = stem;
				}
			} else {
				name = prefix.slice(0, -1);
			}
			return { prefix, name, description: typeof fields.description === "string" ? fields.description : "" };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract every entry under `prefix` into `destination`, prefix stripped.
 * Traversal-shaped entries are skipped (they never match the normalized
 * prefix anyway); bomb guards trip on entry count and total bytes.
 * @param buffer - the whole archive.
 * @param prefix - the discovered skill prefix (`""` for a root-level skill).
 * @param destination - target directory, created as needed.
 * @param siblings - prefixes of the other skills in the same archive. A root-level skill's
 *   prefix is `""`, which matches every entry, so without this an archive holding both a
 *   root `SKILL.md` and `alpha/SKILL.md` writes `alpha/` inside the root skill.
 * @returns `{ files, bytes }` written.
 */
export async function extractZipPrefix(buffer, prefix, destination, siblings = []) {
	const entries = listEntries(buffer);
	let files = 0;
	let bytes = 0;
	for (const entry of entries) {
		if (entry.directory) continue;
		const name = normalizeEntryName(entry.name);
		if (name === undefined || !name.startsWith(prefix)) continue;
		if (siblings.some((other) => name.startsWith(other))) continue;
		const rel = name.slice(prefix.length);
		if (rel === "") continue;
		files += 1;
		bytes += entry.size;
		if (files > MAX_ZIP_ENTRIES || bytes > MAX_ZIP_BYTES) {
			throw new ZipError("archive content exceeds size limits");
		}
		const target = join(destination, ...rel.split("/"));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, readEntry(buffer, entry));
	}
	return { files, bytes };
}
