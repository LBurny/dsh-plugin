/**
 * cloudflared: find the binary, and install one when the machine has none.
 *
 * The tunnel channel is the only one needing a program neither app ships. The search
 * below covers everything a reader could reasonably already have; when it finds
 * nothing, this module fetches one instead of ending at "paste a path here", which is
 * the shape of a dead end for anyone who does not already know what cloudflared is.
 *
 * Where the bytes come from is the whole design. The version and the sha256 come from
 * Cloudflare's own update endpoint (`https://update.argotunnel.com/?os=&arch=`), which
 * is the manifest cloudflared's built-in updater uses: it is Cloudflare-hosted, it is
 * not behind the GitHub API rate limit, and it answers with a checksum. The URL in that
 * manifest is on `github.com`, which some networks cannot reach (measured: DNS-poisoned
 * on a China Unicom line, where the same URL through a local proxy returned 55 MB in
 * 11 s with a digest identical to the manifest's), so `cloudflaredProxy` / `HTTPS_PROXY`
 * is a first-class setting and the transport is `curl`, which honours a proxy without
 * any extra code. Nothing is installed until the bytes match that checksum, and on
 * Windows until the Authenticode signature is Cloudflare's.
 *
 * @module dsh-remote/lib/cloudflared
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** Cloudflare's release manifest, the same one cloudflared's own updater reads. */
export const UPDATE_ENDPOINT = "https://update.argotunnel.com/";

const MANIFEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const SIGNATURE_TIMEOUT_MS = 30_000;

/** A sha256 digest, lowercase hex. */
const SHA256 = /^[0-9a-f]{64}$/u;

/** The publisher every downloaded copy has to be signed by, on platforms that sign. */
const PUBLISHER = "Cloudflare, Inc.";

/**
 * The update endpoint's words for this runtime. It takes `windows`/`darwin`/`linux`
 * and `amd64`/`arm64`, none of which is what `process.platform`/`process.arch` say.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the query parameters, or undefined for a platform with no build.
 */
export function platformQuery(platform = process.platform, arch = process.arch) {
	const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
	const cpu = { x64: "amd64", arm64: "arm64" }[arch];
	return os === undefined || cpu === undefined ? undefined : { os, arch: cpu };
}

/**
 * Read the fields this plugin needs out of the update endpoint's answer.
 *
 * The checksum is the point of parsing at all: it is what lets the bytes come from
 * anywhere (a proxy, a mirror, GitHub) without trusting that source. The URL is
 * required to be https for the same reason, and `compressed` marks the platforms
 * whose release is a tarball rather than the binary itself.
 *
 * @param text - the endpoint's stdout.
 * @returns `{ version, url, checksum, compressed }`, or undefined for junk.
 */
export function parseUpdateManifest(text) {
	let parsed;
	try {
		parsed = JSON.parse(String(text));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { version, url, checksum } = parsed;
	if (typeof version !== "string" || version.length === 0) return undefined;
	if (typeof url !== "string" || !url.startsWith("https://")) return undefined;
	if (typeof checksum !== "string" || !SHA256.test(checksum)) return undefined;
	return { version, url, checksum, compressed: parsed.compressed === true };
}

/**
 * Read a Windows Authenticode result: `Get-AuthenticodeSignature` printed as
 * `<Status>|<Subject>`.
 * @param text - the command's output.
 * @returns `{ ok, status }`; `ok` only when the signature is valid and Cloudflare's.
 */
export function parseSignature(text) {
	const [status = "", subject = ""] = String(text).trim().split("|");
	return { ok: status === "Valid" && subject.includes(PUBLISHER), status };
}

/**
 * Where a cloudflared binary may live, most specific first. Neither app ships one:
 * the shell bundles it beside its node, and the official desktop app bundles nothing
 * at all, so on that app the answer is the user's own install — which is why the
 * locations below matter more than the two bundled ones.
 * @param override - explicit path from settings, if any.
 * @param dshHome - active DSH home, used to find the shell's persistent copy.
 * @param env - environment to read (PATH, LOCALAPPDATA, ProgramFiles).
 * @param execPath - the runtime's node.exe (or the host binary) to look beside.
 * @param platform - `process.platform`.
 * @returns candidates in priority order; the caller takes the first that exists.
 */
export function cloudflaredCandidates(override, dshHome, env = process.env, execPath = process.execPath, platform = process.platform) {
	const name = platform === "win32" ? "cloudflared.exe" : "cloudflared";
	const candidates = [];
	if (typeof override === "string" && override.length > 0) candidates.push(override);
	// `process.execPath` is the runtime's node.exe under both the shell and the installer.
	candidates.push(join(dirname(execPath), name));
	// The shell keeps a copy outside its install dir so a tunnel outlives the app.
	if (typeof dshHome === "string" && dshHome.length > 0) candidates.push(join(dirname(dshHome), "tunnel", name));
	// `cloudflared` installed by hand is on PATH, which is the only place a user can
	// reasonably be expected to have put it.
	for (const dir of String(env.PATH ?? "").split(delimiter)) {
		if (dir.length > 0) candidates.push(join(dir, name));
	}
	if (platform === "win32") {
		// The winget shim directory and the MSI's install directory; both are real
		// answers on a machine that has cloudflared but never had either app's copy.
		if (typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.length > 0) {
			candidates.push(join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", name));
		}
		for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
			if (typeof root === "string" && root.length > 0) candidates.push(join(root, "cloudflared", name));
		}
	}
	return candidates;
}

/**
 * Locate the cloudflared binary, preferring the explicit setting and then the places
 * it is actually installed.
 *
 * The platform, environment and runtime path are parameters rather than reads of the
 * ambient process because the installer threads its own injectables through here: the
 * binary's name depends on the platform, and a test that fakes a Linux machine must not
 * end up searching the real one's `PATH`.
 *
 * @param override - explicit path from settings, if any.
 * @param dshHome - active DSH home, used to find the shell's persistent copy.
 * @param exists - existence probe, injectable for tests.
 * @param platform - `process.platform`.
 * @param env - environment to read.
 * @param execPath - the runtime binary to look beside.
 * @returns the first candidate that exists.
 */
export function findCloudflared(override, dshHome, exists = existsSync, platform = process.platform, env = process.env, execPath = process.execPath) {
	return cloudflaredCandidates(override, dshHome, env, execPath, platform).find((candidate) => exists(candidate));
}

/**
 * Where an installed copy belongs: `<DSH_HOME>/../tunnel/`, which is the directory the
 * search above already looks in. That is deliberate — it means a copy this module
 * installs is found by the same code path as one the reader installed by hand, and a
 * plugin reinstalled later keeps using it.
 * @param dshHome - active DSH home.
 * @param platform - `process.platform`.
 * @returns the absolute path to install to.
 */
export function installTarget(dshHome, platform = process.platform) {
	const name = platform === "win32" ? "cloudflared.exe" : "cloudflared";
	return join(dirname(dshHome), "tunnel", name);
}

/**
 * The sha256 of a file, streamed.
 * @param path - file to hash.
 * @returns lowercase hex digest.
 */
export async function sha256File(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

/**
 * Run a command and collect stdout, rejecting on a non-zero exit.
 *
 * Both consumers here need that failure: a download that exited non-zero has left a
 * partial file behind, and a signature check that could not run must not read as
 * "valid". The tailscale module's runner deliberately tolerates failure (a missing
 * CLI is not an error there), so this is a separate function rather than a shared one
 * with a flag.
 *
 * @param exe - executable to spawn.
 * @param args - arguments.
 * @param timeoutMs - wall clock before the child is killed.
 * @returns stdout text.
 */
export function runCommand(exe, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		let out = "";
		let err = "";
		let child;
		try {
			child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (cause) {
			reject(cause);
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			reject(new Error(`${exe} timed out after ${String(timeoutMs)}ms`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			err += String(chunk);
		});
		child.on("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`${exe} exited with ${String(code)}: ${(err.length > 0 ? err : out).trim().slice(0, 200)}`));
		});
	});
}

/**
 * The curl invocation both network calls share. curl is what this module uses instead
 * of a Node client because it is present on Windows 10+, macOS and most Linux images,
 * and because it carries a proxy without any extra code (`--proxy`, or `HTTPS_PROXY`
 * on its own).
 * @param url - what to fetch.
 * @param options - `{ output, proxy, timeoutMs }`.
 * @returns the argument vector.
 */
function curlArgs(url, { output, proxy, timeoutMs }) {
	const args = ["--silent", "--show-error", "--location", "--fail", "--max-time", String(Math.ceil(timeoutMs / 1000))];
	if (typeof proxy === "string" && proxy.length > 0) args.push("--proxy", proxy);
	if (typeof output === "string") args.push("--output", output);
	args.push(url);
	return args;
}

/**
 * Ask Cloudflare what the current release is for this platform.
 * @param query - `{ os, arch }` from `platformQuery`.
 * @param options - `{ proxy, run, timeoutMs }`.
 * @returns the manifest, or undefined when it could not be read usably.
 */
export async function fetchUpdateManifest(query, { proxy = "", run = runCommand, timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
	const url = `${UPDATE_ENDPOINT}?os=${encodeURIComponent(query.os)}&arch=${encodeURIComponent(query.arch)}`;
	try {
		return parseUpdateManifest(await run("curl", curlArgs(url, { proxy, timeoutMs }), timeoutMs + 5_000));
	} catch {
		// A missing manifest is a state the panel reports, not an exception to carry.
		return undefined;
	}
}

/**
 * Download a URL to a file, rejecting unless curl exited zero (`--fail` is what turns
 * an HTTP error into a non-zero exit, so a 404 body never lands in the file).
 * @param url - what to fetch.
 * @param dest - where to write it (a temporary path, never the install target).
 * @param options - `{ proxy, run, timeoutMs }`.
 */
export async function downloadTo(url, dest, { proxy = "", run = runCommand, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
	await run("curl", curlArgs(url, { output: dest, proxy, timeoutMs }), timeoutMs + 5_000);
}

/**
 * Check a downloaded Windows binary's Authenticode signature. Fail-closed on purpose:
 * the signature is the one check that does not depend on a hash coming from the same
 * network as the bytes, so a check that cannot run is a rejection, not a pass. Other
 * platforms verify the sha256 only, which is why the design keeps the manifest's
 * checksum as the primary gate.
 * @param path - the downloaded file.
 * @param options - `{ platform, run, timeoutMs }`.
 * @returns `{ ok, status }`.
 */
export async function checkCloudflaredSignature(path, { platform = process.platform, run = runCommand, timeoutMs = SIGNATURE_TIMEOUT_MS } = {}) {
	if (platform !== "win32") return { ok: true, status: "not-applicable" };
	const literal = String(path).replace(/'/gu, "''");
	const script = `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; Write-Output "$($s.Status)|$($s.SignerCertificate.Subject)"`;
	try {
		return parseSignature(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs));
	} catch (cause) {
		return { ok: false, status: `unavailable: ${String(cause?.message ?? cause)}` };
	}
}

/** Bytes in one tar member header. */
const TAR_BLOCK = 512;

/** A tar header field is NUL-padded ASCII; leading/trailing padding is not content. */
const tarField = (header, from, to) => String(header.subarray(from, to)).split("\u0000", 1)[0].trim();

/**
 * The regular files in a tar archive, in order.
 *
 * Only what an executable release archive needs: 512-byte member headers, the octal size
 * field, and `0` or a NUL byte for "this is a file". Links, directories, GNU long names
 * and pax extensions are skipped, and a truncated archive stops where it ends instead of
 * reading past its own bytes.
 *
 * @param buffer - the uncompressed archive.
 * @returns `{ name, data }` per regular file.
 */
export function readTar(buffer) {
	const files = [];
	let at = 0;
	while (at + TAR_BLOCK <= buffer.length) {
		const header = buffer.subarray(at, at + TAR_BLOCK);
		// Two blank blocks end an archive; one is enough to know the rest is padding.
		if (header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(tarField(header, 124, 136), 8);
		const bytes = Number.isInteger(size) && size > 0 ? size : 0;
		const body = at + TAR_BLOCK;
		const end = body + bytes;
		if (end > buffer.length) break;
		const type = tarField(header, 156, 157);
		if (type === "" || type === "0") {
			const prefix = tarField(header, 345, 500);
			const name = tarField(header, 0, 100);
			files.push({ name: prefix === "" ? name : `${prefix}/${name}`, data: buffer.subarray(body, end) });
		}
		at = body + Math.ceil(bytes / TAR_BLOCK) * TAR_BLOCK;
	}
	return files;
}

/**
 * The executable inside a release archive.
 *
 * This exists because a `compressed` release cannot be installed as if its bytes were the
 * binary. Cloudflare's darwin artifact is a `.tgz` whose sha256 legitimately matches the
 * manifest, so installing it directly would leave an archive named `cloudflared`: the
 * search would find that file on every later run, report it ready, and `spawn` could never
 * run it. Which is also why the checksum check alone cannot catch this.
 *
 * @param archive - the downloaded archive.
 * @param name - the executable's name inside it.
 * @returns the executable's bytes, or undefined when the archive carries none.
 */
export function extractExecutable(archive, name = "cloudflared") {
	let files;
	try {
		files = readTar(gunzipSync(archive));
	} catch {
		return undefined;
	}
	// The release names the file it ships, so the name is the answer; a single-file
	// archive is the same answer for a release that ever stops naming it.
	const named = files.find((file) => file.name === name || file.name.endsWith(`/${name}`));
	if (named !== undefined) return Buffer.from(named.data);
	return files.length === 1 ? Buffer.from(files[0].data) : undefined;
}

/**
 * Move a verified download into place. Same directory, so the rename is atomic and a
 * reader can never observe a half-written binary.
 * @param from - the temporary file.
 * @param to - the install target.
 */
async function place(from, to) {
	await chmod(from, 0o755).catch(() => {
		/* Windows, or a filesystem that does not carry the bit */
	});
	await rename(from, to);
}

/**
 * The provisioning state machine the panel reads.
 *
 * `ensure()` is idempotent and cheap when a binary already exists: it resolves the
 * search, records which path that was, and returns without a single network call. Only
 * a missing binary starts a download, and only a verified one is installed, so the
 * failure states are the point of the whole thing: each names what happened and leaves
 * the reader with the manual path field rather than a half-installed file.
 *
 * @param options - `{ layout, config, save, log }` plus every injectable probe
 *   (`platform`, `arch`, `env`, `exists`, `run`, `fetchManifest`, `verifySignature`).
 * @returns `{ status, ensure, setProxy }`.
 */
export function createCloudflaredInstaller({ layout, config, save, log, platform = process.platform, arch = process.arch, env = process.env, execPath = process.execPath, exists = existsSync, run = runCommand, fetchManifest = fetchUpdateManifest, verifySignature = checkCloudflaredSignature } = {}) {
	let status = { state: "idle" };
	let inFlight;

	/** Record a failure, log it, and hand the caller the state the panel will read. */
	const fail = (error, detail) => {
		status = { state: "failed", error, detail };
		log(`cloudflared provisioning failed (${error})${detail === undefined ? "" : `: ${detail}`}`);
		return status;
	};

	async function provision() {
		const settings = await config();
		const dshHome = layout().dshHome;
		const found = findCloudflared(settings.cloudflaredPath, dshHome, exists, platform, env, execPath);
		if (found !== undefined) {
			// Nothing to fetch: a binary is already usable, and no request leaves the
			// machine. The path is deliberately *not* written into the settings, here or
			// after an install: a value there means the reader chose that binary, and the
			// search already covers every place one can be. Writing what the search found
			// would make the next load read the plugin's own choice back as the reader's.
			// "manual" is likewise only the exact path the reader set: a stale configured
			// path falls through to the search, and what the search found is "found".
			status = { state: "ready", path: found, source: found === settings.cloudflaredPath ? "manual" : "found" };
			return status;
		}
		const query = platformQuery(platform, arch);
		if (query === undefined) return fail("unsupported", `${platform}/${arch}`);
		const target = installTarget(dshHome, platform);
		// Two temporaries, both inside the target's own directory: the downloaded artifact,
		// and, for a compressed release, the executable unpacked out of it. Placing either
		// from here is a rename within one directory, so it is atomic either way.
		const archive = `${target}.download`;
		const unpacked = `${target}.unpacked`;
		status = { state: "checking", target };
		try {
			const manifest = await fetchManifest(query, { proxy: settings.cloudflaredProxy, run });
			if (manifest === undefined) return fail("manifest", "no usable release manifest");
			status = { state: "downloading", version: manifest.version, target };
			await mkdir(dirname(target), { recursive: true });
			await downloadTo(manifest.url, archive, { proxy: settings.cloudflaredProxy, run });
			// A compressed release is a tarball, and the manifest's checksum is the checksum
			// of the executable inside it, not of the archive. Measured against the darwin
			// release: the `.tgz` hashes to 903845b8… while its 42,328,240-byte Mach-O
			// unpacks to 0560c9ab…, which is what the manifest publishes. So the unpack comes
			// first and the digest is checked on the file that will actually be installed; a
			// straight install would otherwise leave an archive named `cloudflared` that the
			// checksum accepts, the search finds forever and spawn can never run.
			let binary = archive;
			if (manifest.compressed === true) {
				const executable = extractExecutable(await readFile(archive));
				if (executable === undefined) return fail("unpack", "the release archive carried no cloudflared binary");
				await writeFile(unpacked, executable, { mode: 0o755 });
				binary = unpacked;
			}
			const digest = await sha256File(binary);
			if (digest !== manifest.checksum) return fail("checksum", `expected ${manifest.checksum}, got ${digest}`);
			const signature = await verifySignature(binary, { platform, run });
			if (signature.ok !== true) return fail("signature", String(signature.status ?? "unknown"));
			await place(binary, target);
			status = { state: "ready", path: target, source: "installed", version: manifest.version };
			log(`cloudflared ${manifest.version} installed at ${target}`);
			// Again, no path in the settings: the install target is a directory the search
			// already covers, so the next load finds it unaided and calls it found.
			return status;
		} catch (error) {
			return fail("download", String(error?.message ?? error));
		} finally {
			// No outcome may leave a temporary file behind. After a successful install
			// `place` renamed the file it used away, so that one is a no-op here.
			for (const leftover of [archive, unpacked]) {
				await rm(leftover, { force: true }).catch(() => {
					/* nothing to remove */
				});
			}
		}
	}

	return {
		/** The current state, read synchronously by the panel's poll. */
		status: () => status,
		/**
		 * Run the provisioning, at most one at a time: a second caller (a retry click
		 * during a download) joins the run in flight instead of starting another.
		 *
		 * The in-flight status is recorded synchronously, before the first `await`: the
		 * POST that starts this answers with this very status, and the panel decides from
		 * that answer whether to keep asking. Without it the answer could carry the settled
		 * failure from before the click and the panel would stop polling a download it had
		 * just started.
		 */
		ensure() {
			if (inFlight === undefined) {
				status = { state: "checking" };
				inFlight = provision().finally(() => {
					inFlight = undefined;
				});
			}
			return inFlight;
		},
		/**
		 * Set the proxy used to reach Cloudflare's release host. The settings layer is
		 * what validates it: anything that is not an http(s) URL is stored as an empty
		 * string, which means "no proxy".
		 * @param proxy - the reader's input.
		 */
		async setProxy(proxy) {
			await save({ cloudflaredProxy: typeof proxy === "string" ? proxy.trim() : "" });
			return status;
		}
	};
}
