/**
 * Offline checks for lib/cloudflared.js: the platform mapping, the release manifest
 * parser, the signature parser, the install target, and the provisioning state
 * machine with an injected runner. No network, and no real cloudflared anywhere.
 *
 * Run from the plugin directory:
 *   node tests/cloudflared.test.mjs
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	cloudflaredCandidates,
	createCloudflaredInstaller,
	extractExecutable,
	installTarget,
	parseSignature,
	parseUpdateManifest,
	platformQuery,
	readTar
} from "../lib/cloudflared.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const exists = (path) => stat(path).then(() => true, () => false);

/**
 * A tar archive, gzipped, laid out the way a release tarball is: real 512-byte headers,
 * a real octal size field and a real checksum, so the reader meets the format rather
 * than a shape invented to fit it.
 * @param files - `{ name, data }` per member.
 * @returns the `.tgz` bytes.
 */
function tarGz(files) {
	const members = files.map(({ name, data }) => {
		const header = Buffer.alloc(512);
		header.write(name, 0, "utf8");
		header.write("0000644\u0000", 100);
		header.write("0000000\u0000", 108);
		header.write("0000000\u0000", 116);
		header.write(`${data.length.toString(8).padStart(11, "0")}\u0000`, 124);
		header.write("00000000000\u0000", 136);
		header.fill(0x20, 148, 156);
		header.write("0", 156);
		header.write("ustar\u0000", 257);
		header.write("00", 263);
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148);
		const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
		return Buffer.concat([header, data, pad]);
	});
	// Two blank blocks end an archive.
	return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]));
}

/* -------------------------------------------------------------- pure helpers */

const win = platformQuery("win32", "x64");
check(win?.os === "windows" && win?.arch === "amd64", "win32/x64 maps to windows/amd64", JSON.stringify(win));
const mac = platformQuery("darwin", "arm64");
check(mac?.os === "darwin" && mac?.arch === "arm64", "darwin/arm64 maps to darwin/arm64", JSON.stringify(mac));
const lin = platformQuery("linux", "x64");
check(lin?.os === "linux" && lin?.arch === "amd64", "linux/x64 maps to linux/amd64", JSON.stringify(lin));
check(platformQuery("freebsd", "x64") === undefined, "an unsupported OS maps to nothing", "");
check(platformQuery("win32", "ia32") === undefined, "an unsupported CPU maps to nothing", "");

// The exact body Cloudflare's update endpoint answered on 2026-10-11.
const manifest = parseUpdateManifest(JSON.stringify({
	version: "2026.10.0",
	url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe",
	checksum: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
	compressed: false,
	userMessage: "",
	shouldUpdate: true
}));
check(
	manifest?.version === "2026.10.0" && manifest.checksum.startsWith("86aee4") && manifest.compressed === false,
	"a real update-endpoint body parses",
	JSON.stringify(manifest)
);
check(parseUpdateManifest("not json") === undefined, "junk is not a manifest", "");
check(parseUpdateManifest(JSON.stringify({ version: "1", url: "http://x/y", checksum: "a".repeat(64) })) === undefined, "a plain-http download URL is refused", "");
check(parseUpdateManifest(JSON.stringify({ version: "1", url: "https://x/y", checksum: "abc" })) === undefined, "a checksum that is not a sha256 is refused", "");
check(parseUpdateManifest(JSON.stringify({ url: "https://x/y", checksum: "a".repeat(64) })) === undefined, "a manifest without a version is refused", "");
check(parseUpdateManifest(JSON.stringify({ version: "1", url: "https://x/y.tgz", checksum: "a".repeat(64), compressed: true }))?.compressed === true, "compressed is carried when the release says so", "");

// Measured on this machine's own copy: Status=Valid, CN="Cloudflare, Inc.".
check(
	parseSignature('Valid|CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco').ok === true,
	"a valid Cloudflare signature passes",
	""
);
check(parseSignature("NotSigned|").ok === false, "an unsigned file fails", "");
check(parseSignature('Valid|CN="Somebody Else", O="Somebody Else"').ok === false, "a valid signature by another publisher fails", "");

const target = installTarget("C:\\Users\\x\\.dsh", "win32");
check(target === join("C:\\Users\\x", "tunnel", "cloudflared.exe"), "the install target is <dsh home>/../tunnel/cloudflared.exe", target);
check(installTarget("/home/x/.dsh", "linux") === join("/home/x", "tunnel", "cloudflared"), "the install target drops .exe off Windows", installTarget("/home/x/.dsh", "linux"));
check(
	cloudflaredCandidates("", "/home/x/.dsh", { PATH: "/usr/bin" }, "/usr/bin/node", "linux").includes(join("/home/x", "tunnel", "cloudflared")),
	"the search still covers <dsh home>/../tunnel/",
	""
);

/* ---------------------------------------------------------- release archives */

// Cloudflare's darwin release is a .tgz and its manifest says `compressed: true`, while
// the checksum is the archive's own. So a straight install would leave an archive named
// `cloudflared`, whose sha256 legitimately matches, which the search then reports ready
// forever and spawn can never run. Nothing before the unpack can tell the two apart,
// which is why the archive path is checked on its own.
const inner = Buffer.from("#!/bin/sh\necho cloudflared\n");
const release = tarGz([{ name: "cloudflared", data: inner }]);
const unpacked = extractExecutable(release);
check(unpacked?.toString() === inner.toString(), "the executable comes out of a release tarball byte for byte", String(unpacked?.length));
check(readTar(release).length === 0, "the reader sees the compressed bytes as no archive at all", String(readTar(release).length));
check(readTar(gunzipSync(release))[0]?.name === "cloudflared", "the member name survives the reader", readTar(gunzipSync(release))[0]?.name);
check(gunzipSync(release).length % 512 === 0, "the fixture is a real tar, in whole blocks", String(gunzipSync(release).length));
check(
	extractExecutable(tarGz([{ name: "doc/README.md", data: Buffer.from("x") }, { name: "cloudflared", data: inner }]))?.toString() === inner.toString(),
	"the named member wins over the other entries",
	""
);
check(
	extractExecutable(tarGz([{ name: "renamed-binary", data: inner }]))?.toString() === inner.toString(),
	"a single-member archive is taken by shape when the name is unfamiliar",
	""
);
check(extractExecutable(Buffer.from("not an archive")) === undefined, "bytes that are not an archive yield nothing", "");
check(extractExecutable(gzipSync(Buffer.from("not a tar"))) === undefined, "a gzip that holds no member yields nothing", "");
check(readTar(gunzipSync(release).subarray(0, 520)).length === 0, "a truncated archive stops instead of reading past its bytes", "");

/* ------------------------------------------------------------ the installer */

/**
 * A runner double: records every call, and answers with a handler.
 * @param handler - `(exe, args)`; may throw to fail the call.
 */
function fakeRun(handler) {
	const calls = [];
	const run = async (exe, args, timeoutMs) => {
		calls.push({ exe, args, timeoutMs });
		return handler === undefined ? "" : await handler(exe, args);
	};
	run.calls = calls;
	return run;
}

/** A throwaway DSH home whose parent holds the `tunnel` directory the plugin writes. */
async function withHome(body) {
	const parent = await mkdtemp(join(tmpdir(), "dsh-remote-cf-"));
	const home = join(parent, "home");
	await mkdir(home, { recursive: true });
	try {
		return await body(home);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

/**
 * The installer over a throwaway home, with settings held in memory and the filesystem
 * replaced by an explicit list of visible paths (so a test never depends on what this
 * machine really has installed).
 * @param home - the DSH home.
 * @param options - `{ run, checksum, platform, arch, existing, verifySignature }`;
 *   `existing` is the array of paths `exists` reports, and the caller may push to it.
 */
function makeInstaller(home, options = {}) {
	const {
		run,
		checksum = "a".repeat(64),
		platform = "linux",
		arch = "x64",
		existing = [],
		cloudflaredPath = "",
		verifySignature,
		compressed = false,
		url = "https://example.test/cloudflared.exe"
	} = options;
	let settings = { enabled: false, mode: "tunnel", port: 0, token: "", cloudflaredPath, cloudflaredProxy: "" };
	const installer = createCloudflaredInstaller({
		layout: () => ({ dshHome: home }),
		config: async () => settings,
		save: async (patch) => {
			settings = { ...settings, ...patch };
			return settings;
		},
		log: () => {},
		platform,
		arch,
		env: { PATH: "" },
		exists: (path) => existing.includes(path),
		run,
		fetchManifest: async () => ({ version: "2026.10.0", url, checksum, compressed }),
		verifySignature
	});
	return { installer, settings: () => settings };
}

/** A `--output` handler that writes `bytes` where curl would have. */
const writes = (bytes) => (exe, args) => {
	const at = args.indexOf("--output");
	return at === -1 ? "" : writeFile(args[at + 1], bytes).then(() => "");
};

// An existing binary means no network call at all, and no path written to the settings:
// a value there has to keep meaning "the reader chose this one".
await withHome(async (home) => {
	const existing = installTarget(home, "linux");
	await mkdir(dirname(existing), { recursive: true });
	await writeFile(existing, "existing");
	const run = fakeRun();
	const { installer, settings } = makeInstaller(home, { run, existing: [existing] });
	const status = await installer.ensure();
	check(status.state === "ready" && status.source === "found", "an existing binary is reported as found", JSON.stringify(status));
	check(run.calls.length === 0, "an existing binary costs no network call", String(run.calls.length));
	check(settings().cloudflaredPath === "", "a found binary is not written into the settings", settings().cloudflaredPath);
});

// A path in the settings is the reader's own choice, and is labelled as such.
await withHome(async (home) => {
	const chosen = installTarget(home, "linux");
	await mkdir(dirname(chosen), { recursive: true });
	await writeFile(chosen, "chosen-by-hand");
	const run = fakeRun();
	const { installer } = makeInstaller(home, { run, existing: [chosen], cloudflaredPath: chosen });
	const status = await installer.ensure();
	check(status.state === "ready" && status.source === "manual", "a path the reader set is labelled as theirs", JSON.stringify(status));
});

// A missing binary is downloaded, verified and installed.
await withHome(async (home) => {
	const bytes = Buffer.from("cloudflared-bytes");
	const run = fakeRun(writes(bytes));
	const visible = [];
	const { installer, settings } = makeInstaller(home, { run, checksum: sha256(bytes), existing: visible });
	const status = await installer.ensure();
	const installed = installTarget(home, "linux");
	check(status.state === "ready" && status.source === "installed", "a missing binary is installed", JSON.stringify(status));
	check(status.version === "2026.10.0", "the installed version is reported", String(status.version));
	check(await readFile(installed, "utf8") === bytes.toString(), "the installed bytes are the downloaded bytes", installed);
	check(
		cloudflaredCandidates("", home, { PATH: "" }, process.execPath, "linux").includes(installed),
		"the install target is one of the directories the search already covers",
		installed
	);
	// So the path is deliberately not written into the settings: a second run has to find
	// the file unaided, and say it was found rather than that the reader had chosen it.
	check(settings().cloudflaredPath === "", "an install writes no path into the settings", settings().cloudflaredPath);
	visible.push(installed);
	const again = await installer.ensure();
	check(again.state === "ready" && again.source === "found", "the next run finds the installed file through the search", JSON.stringify(again));
});

// A checksum mismatch must never reach the install target.
await withHome(async (home) => {
	const run = fakeRun(writes("tampered"));
	const { installer, settings } = makeInstaller(home, { run, checksum: sha256("what-cloudflare-published") });
	const status = await installer.ensure();
	const installed = installTarget(home, "linux");
	check(status.state === "failed" && status.error === "checksum", "a checksum mismatch fails", JSON.stringify(status));
	check(settings().cloudflaredPath === "", "a checksum mismatch records no path", settings().cloudflaredPath);
	check(!(await exists(installed)), "a checksum mismatch leaves no installed binary", installed);
	check(!(await exists(`${installed}.download`)), "a checksum mismatch removes the temporary download", `${installed}.download`);
});

// A download that exits non-zero is reported as a download failure.
await withHome(async (home) => {
	const run = fakeRun(() => {
		throw new Error("curl exited with 5: could not resolve host");
	});
	const { installer, settings } = makeInstaller(home, { run });
	const status = await installer.ensure();
	check(status.state === "failed" && status.error === "download", "a failed download is reported", JSON.stringify(status));
	check(settings().cloudflaredPath === "", "a failed download records no path", settings().cloudflaredPath);
});

// A signature that is not Cloudflare's is refused on Windows.
await withHome(async (home) => {
	const bytes = Buffer.from("signed-by-someone-else");
	const run = fakeRun(writes(bytes));
	const { installer, settings } = makeInstaller(home, {
		run,
		checksum: sha256(bytes),
		platform: "win32",
		verifySignature: async () => ({ ok: false, status: "UnknownError" })
	});
	const status = await installer.ensure();
	check(status.state === "failed" && status.error === "signature", "a foreign signature is refused", JSON.stringify(status));
	check(settings().cloudflaredPath === "", "a foreign signature records no path", settings().cloudflaredPath);
	check(!(await exists(installTarget(home, "win32"))), "a foreign signature leaves no installed binary", installTarget(home, "win32"));
});

// An unsupported platform fails without trying anything.
await withHome(async (home) => {
	const run = fakeRun();
	const { installer } = makeInstaller(home, { run, platform: "freebsd" });
	const status = await installer.ensure();
	check(status.state === "failed" && status.error === "unsupported", "an unsupported platform is reported, not attempted", JSON.stringify(status));
	check(run.calls.length === 0, "an unsupported platform makes no network call", String(run.calls.length));
});

// The status is readable while the download runs, which is what the panel polls.
await withHome(async (home) => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const bytes = Buffer.from("late");
	const run = fakeRun(async (exe, args) => {
		const at = args.indexOf("--output");
		if (at === -1) return "";
		await gate;
		await writeFile(args[at + 1], bytes);
		return "";
	});
	const { installer } = makeInstaller(home, { run, checksum: sha256(bytes) });
	const running = installer.ensure();
	// Read before any await, because the POST that starts the install answers with this
	// status and the panel decides from that answer whether to keep asking.
	check(installer.status().state === "checking", "the status reads in-flight the moment ensure() is called, before any await", installer.status().state);
	await new Promise((resolve) => setTimeout(resolve, 30));
	check(["checking", "downloading"].includes(installer.status().state), "the status reads as in-flight while the download runs", installer.status().state);
	release();
	await running;
	check(installer.status().state === "ready", "the status settles on ready", installer.status().state);
});

// The proxy setting reaches the transport, which is the whole reason it exists.
await withHome(async (home) => {
	let seen;
	const run = fakeRun((exe, args) => {
		seen ??= args.includes("--proxy") ? args[args.indexOf("--proxy") + 1] : "";
		return writes("via-proxy")(exe, args);
	});
	const { installer, settings } = makeInstaller(home, { run, checksum: sha256("via-proxy") });
	await installer.setProxy(" http://127.0.0.1:7890 ");
	check(settings().cloudflaredProxy === "http://127.0.0.1:7890", "a proxy is stored trimmed", settings().cloudflaredProxy);
	await installer.ensure();
	check(seen === "http://127.0.0.1:7890", "the proxy reaches the download command", String(seen));
});

// A compressed release: the darwin path end to end. The manifest's checksum is the
// checksum of the executable *inside* the archive (measured on the real release: the
// .tgz hashes to 903845b8…, the 42,328,240-byte Mach-O it holds to 0560c9ab…, which is
// what the manifest publishes), so what gets installed has to be the unpacked file and
// neither temporary may survive.
await withHome(async (home) => {
	const binary = Buffer.from("darwin-cloudflared-binary");
	const archive = tarGz([{ name: "cloudflared", data: binary }]);
	const run = fakeRun(writes(archive));
	const { installer, settings } = makeInstaller(home, {
		run,
		checksum: sha256(binary),
		platform: "darwin",
		arch: "arm64",
		compressed: true,
		url: "https://example.test/cloudflared-darwin-amd64.tgz"
	});
	const status = await installer.ensure();
	const installed = installTarget(home, "darwin");
	check(status.state === "ready" && status.source === "installed", "a compressed release installs", JSON.stringify(status));
	check(await readFile(installed, "utf8") === binary.toString(), "the installed file is the unpacked binary, never the archive", installed);
	check(!(await exists(`${installed}.download`)), "the archive is not kept after unpacking", `${installed}.download`);
	check(!(await exists(`${installed}.unpacked`)), "the staging file is not kept either", `${installed}.unpacked`);
	check(settings().cloudflaredPath === "", "a compressed install writes no path into the settings", settings().cloudflaredPath);
});

// The digest of a compressed release is the unpacked executable's, so an archive whose own
// bytes happen to hash to it is still refused. Checking the archive instead was a real bug:
// the manifest's digest never matches the .tgz, so every macOS install failed with
// "checksum" before this ordering was measured.
await withHome(async (home) => {
	const binary = Buffer.from("darwin-cloudflared-binary");
	const archive = tarGz([{ name: "cloudflared", data: binary }]);
	const run = fakeRun(writes(archive));
	const { installer } = makeInstaller(home, { run, checksum: sha256(archive), platform: "darwin", compressed: true });
	const status = await installer.ensure();
	check(
		status.state === "failed" && status.error === "checksum",
		"a compressed release is checked against the unpacked executable, not the archive",
		JSON.stringify(status)
	);
	check(!(await exists(installTarget(home, "darwin"))), "the archive's own digest installs nothing", "");
});

// Compressed, digest matches, but the archive carries no binary: a named reason and no
// install target, because "ready" on a file that cannot run is the failure this whole
// path exists to prevent.
await withHome(async (home) => {
	const archive = tarGz([{ name: "README.md", data: Buffer.from("no binary here") }, { name: "LICENSE", data: Buffer.from("x") }]);
	const run = fakeRun(writes(archive));
	const { installer } = makeInstaller(home, { run, checksum: sha256(archive), platform: "darwin", compressed: true });
	const status = await installer.ensure();
	const installed = installTarget(home, "darwin");
	check(status.state === "failed" && status.error === "unpack", "an archive without a binary is reported as such", JSON.stringify(status));
	check(!(await exists(installed)), "an archive without a binary leaves nothing installed", installed);
	check(!(await exists(`${installed}.download`)), "an archive without a binary is not kept", `${installed}.download`);
	check(!(await exists(`${installed}.unpacked`)), "no staging file is left behind", `${installed}.unpacked`);
});

/* ---------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nCLOUDFLARED TEST PASS (${results.length} checks)` : `\nCLOUDFLARED TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
