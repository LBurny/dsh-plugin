# dsh-remote: cloudflared auto-provisioning — Implementation Plan

> **For agentic workers:** Implement this plan in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A freshly installed `dsh-remote` finds cloudflared on the machine, and when there is none it installs one itself, so the tunnel channel works without the reader ever being asked for a path.

**Architecture:** A new host module `lib/cloudflared.js` owns every cloudflared concern (the existing binary search moves there, plus the Cloudflare-hosted release manifest, a verified download, and a provisioning state machine). `lib/index.js` creates one installer per plugin instance, kicks it off after mount, exposes its status through the existing `/dsh-remote/api/remote` payload and two new POST actions, and the panel reports the source, the progress, or the failure reason.

**Tech Stack:** hand-written ESM JavaScript, Node 22+ (`node:child_process`, `node:crypto`, `node:fs`), no build step, no new dependency. `curl` is spawned for the two network calls; `powershell.exe` verifies the Windows signature.

## Global Constraints

- No new runtime dependency. `lib/cloudflared.js` imports `node:*` builtins only, so `tests/manifest.test.mjs` passes unchanged.
- No build, lint or typecheck step exists. The only checks are the Node suites.
- Panel and hub UI text may contain no em dash (`tests/hub-contract.test.mjs` fails any non-comment line with one).
- The panel keys its strings off `navigator.language` through the existing `T({en, zh})` map, never dsh's locale.
- A plugin row must never throw out of `apply`; the provisioning run is floating (`void ... .catch(...)`) and only ever logs.
- Nothing may write outside `<DSH_HOME>/../tunnel/` and `<DSH_HOME>/dsh-remote.json`.
- Measured facts this design rests on, all re-verified 2026-10-11: `https://update.argotunnel.com/?os=<windows|darwin|linux>&arch=<amd64|arm64>` answers `{version,url,checksum,compressed}` (Cloudflare-hosted, reachable from a China Unicom line and not behind the GitHub API rate limit); the `url` it returns is on `github.com`, which that line DNS-poisons (`curl` exits instantly, 0 bytes); the same URL through `http://127.0.0.1:7890` returned 55,365,048 bytes in 11 s with sha256 `86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c`, identical to the manifest's; the local copy is Authenticode-signed, `Status=Valid`, `CN="Cloudflare, Inc."`.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `dsh-remote/lib/cloudflared.js` | create | binary search (moved), release manifest, verified download, installer state machine |
| `dsh-remote/lib/settings.js` | modify | new `cloudflaredProxy` setting, validated |
| `dsh-remote/lib/remote.js` | modify | search functions move out; snapshot gains `cloudflaredProxy` |
| `dsh-remote/lib/index.js` | modify | create + start the installer, new actions, status in the API payload, `/remote` line, version |
| `dsh-remote/lib/client.js` | modify | source label, progress note, failure reason + retry, proxy field, install polling |
| `dsh-remote/tests/cloudflared.test.mjs` | create | offline suite for the new module (no network, injected runner) |
| `dsh-remote/tests/proxy.test.mjs` | modify | import the moved search functions |
| `dsh-remote/package.json`, `dsh-remote/README.md`, `AGENTS.md` | modify | version bump and docs |
| `tests/panel-embed.test.mjs` | modify | payload fixtures + the install-poll assertions |

---

### Task 1: settings carry a download proxy

**Files:**
- Modify: `dsh-remote/lib/settings.js`

**Interfaces:**
- Produces: `defaultConfig().cloudflaredProxy === ""`, and `normalizeConfig()` coerce rules used by Task 4's `setProxy` and by the panel's `cloudflared-proxy` action.

- [ ] **Step 1: Add the setting and its validation**

In `defaultConfig()`, after `cloudflaredPath: ""`:

```js
		// Only used to reach Cloudflare's release host when this machine cannot:
		// `github.com` is DNS-poisoned on some networks (measured), and `curl` is the
		// transport, so an http(s) proxy URL is all that is needed to fix it.
		cloudflaredProxy: ""
```

Add above `normalizeConfig`:

```js
/** An http(s) proxy URL, or an empty string. Anything else reads as "no proxy". */
export function normalizeProxy(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed === "") return "";
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? trimmed : "";
	} catch {
		return "";
	}
}
```

and in `normalizeConfig`, after the `cloudflaredPath` line:

```js
	merged.cloudflaredProxy = normalizeProxy(merged.cloudflaredProxy);
```

- [ ] **Step 2: Verify it survives a round trip**

Run: `cd dsh-remote && node -e "import('./lib/settings.js').then(m=>{const n=m.normalizeConfig({cloudflaredProxy:' http://127.0.0.1:7890 '});console.log(n.cloudflaredProxy, JSON.stringify(m.normalizeConfig({cloudflaredProxy:'nonsense'}).cloudflaredProxy), JSON.stringify(m.defaultConfig().cloudflaredProxy))})"`

Expected: `http://127.0.0.1:7890 "" ""`

- [ ] **Step 3: Commit**

```bash
git add dsh-remote/lib/settings.js && git commit -m "feat(dsh-remote): 下载 cloudflared 用的代理变成一个设置项"
```

---

### Task 2: `lib/cloudflared.js` — the search moves, plus the pure helpers

**Files:**
- Create: `dsh-remote/lib/cloudflared.js`
- Modify: `dsh-remote/lib/remote.js:152-200` (delete), `dsh-remote/lib/remote.js:40` (import)
- Create: `dsh-remote/tests/cloudflared.test.mjs`
- Modify: `dsh-remote/tests/proxy.test.mjs:30`

**Interfaces:**
- Consumes: nothing.
- Produces: `cloudflaredCandidates(override, dshHome, env?, execPath?, platform?)`, `findCloudflared(override, dshHome, exists?)`, `platformQuery(platform?, arch?)`, `parseUpdateManifest(text)`, `parseSignature(text)`, `installTarget(dshHome, platform?)`, `UPDATE_ENDPOINT`.

- [ ] **Step 1: Write the failing tests**

Create `dsh-remote/tests/cloudflared.test.mjs`. This file is self-contained (no `@deepseek-ai/*` resolution needed) and follows the sibling suite's shape: a `results` array, `check()`, and a summary with `process.exitCode`.

```js
/**
 * Offline checks for lib/cloudflared.js: the platform mapping, the release manifest
 * parser, the signature parser, the install target, and the provisioning state
 * machine with an injected runner (no network, no real cloudflared anywhere).
 *
 * Run from the plugin directory:
 *   node tests/cloudflared.test.mjs
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	cloudflaredCandidates,
	createCloudflaredInstaller,
	findCloudflared,
	installTarget,
	parseSignature,
	parseUpdateManifest,
	platformQuery
} from "../lib/cloudflared.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/* ------------------------------------------------------------- pure helpers */

const win = platformQuery("win32", "x64");
check(win?.os === "windows" && win?.arch === "amd64", "win32/x64 maps to windows/amd64", JSON.stringify(win));
const mac = platformQuery("darwin", "arm64");
check(mac?.os === "darwin" && mac?.arch === "arm64", "darwin/arm64 maps to darwin/arm64", JSON.stringify(mac));
const lin = platformQuery("linux", "x64");
check(lin?.os === "linux" && lin?.arch === "amd64", "linux/x64 maps to linux/amd64", JSON.stringify(lin));
check(platformQuery("freebsd", "x64") === undefined, "an unsupported OS maps to nothing", "");
check(platformQuery("win32", "ia32") === undefined, "an unsupported CPU maps to nothing", "");

// The exact body Cloudflare's update endpoint answered on 2026-10-11.
const realManifest = JSON.stringify({
	version: "2026.10.0",
	url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe",
	checksum: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
	compressed: false,
	userMessage: "",
	shouldUpdate: true
});
const manifest = parseUpdateManifest(realManifest);
check(
	manifest?.version === "2026.10.0" && manifest?.compressed === false && manifest?.checksum.startsWith("86aee4"),
	"a real update-endpoint body parses",
	JSON.stringify(manifest)
);
check(parseUpdateManifest("not json") === undefined, "junk is not a manifest", "");
check(parseUpdateManifest(JSON.stringify({ version: "1", url: "http://x/y", checksum: "a".repeat(64) })) === undefined, "a plain-http download URL is refused", "");
check(parseUpdateManifest(JSON.stringify({ version: "1", url: "https://x/y", checksum: "abc" })) === undefined, "a checksum that is not a sha256 is refused", "");
check(parseUpdateManifest(JSON.stringify({ url: "https://x/y", checksum: "a".repeat(64) })) === undefined, "a manifest without a version is refused", "");
const compressed = parseUpdateManifest(JSON.stringify({ version: "1", url: "https://x/y.tgz", checksum: "a".repeat(64), compressed: true }));
check(compressed?.compressed === true, "compressed is carried when the release says so", JSON.stringify(compressed));

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

const candidates = cloudflaredCandidates("", "/home/x/.dsh", { PATH: "/usr/bin" }, "/usr/bin/node", "linux");
check(candidates.includes(join("/home/x", "tunnel", "cloudflared")), "the search still covers <dsh home>/../tunnel/", candidates.join(","));

/* ------------------------------------------------------- the installer */

/** A runner double: records calls, and either fails or runs a callback. */
function fakeRun(handler) {
	const calls = [];
	const run = async (exe, args, timeoutMs) => {
		calls.push({ exe, args, timeoutMs });
		return handler === undefined ? "" : handler(exe, args);
	};
	run.calls = calls;
	return run;
}

/** A manifest server double. */
const manifestFor = (checksum) => async () => ({ version: "2026.10.0", url: "https://example.test/cloudflared.exe", checksum, compressed: false });

async function withHome(body) {
	const home = await mkdtemp(join(tmpdir(), "dsh-remote-cf-"));
	try {
		return await body(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

/** An installer over a throwaway DSH home, with settings held in memory. */
function makeInstaller(home, { run, checksum, signature, platform = "linux", arch = "x64", find } = {}) {
	let settings = { enabled: false, mode: "tunnel", port: 0, token: "", cloudflaredPath: "", cloudflaredProxy: "" };
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
		exists: (path) => (find === undefined ? false : find.includes(path)),
		run,
		fetchManifest: manifestFor(checksum ?? "a".repeat(64)),
		verifySignature: signature
	});
	return { installer, settings: () => settings };
}

// An existing binary means no network call at all.
await withHome(async (home) => {
	const existing = join(dirname(home), "tunnel", "cloudflared");
	await mkdir(dirname(existing), { recursive: true });
	await writeFile(existing, "existing");
	const run = fakeRun();
	const { installer, settings } = makeInstaller(home, { run, find: [existing] });
	const status = await installer.ensure();
	check(status.state === "ready" && status.source === "found", "an existing binary is reported as found", JSON.stringify(status));
	check(run.calls.length === 0, "an existing binary costs no network call", String(run.calls.length));
	check(settings().cloudflaredPath === existing, "the found binary is recorded in settings", settings().cloudflaredPath);
});

// A missing binary is downloaded, verified, installed and recorded.
await withHome(async (home) => {
	const bytes = Buffer.from("cloudflared-bytes");
	const checksum = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
	const run = fakeRun((exe, args) => {
		if (args.includes("--output")) return writeFile(args[args.indexOf("--output") + 1], bytes).then(() => "");
		return "";
	});
	const { installer, settings } = makeInstaller(home, { run, checksum });
	const status = await installer.ensure();
	const target = installTarget(home, "linux");
	check(status.state === "ready" && status.source === "installed", "a missing binary is installed", JSON.stringify(status));
	check(status.version === "2026.10.0", "the installed version is reported", String(status.version));
	check(settings().cloudflaredPath === target, "the installed path is recorded in settings", settings().cloudflaredPath);
	check((await stat(target)).isFile(), "the binary lands at the install target", target);
	check((await readFile(target, "utf8")) === bytes.toString(), "the installed bytes are the downloaded bytes", "");
	await rm(target, { force: true });
});

// A checksum mismatch must never reach the install target.
await withHome(async (home) => {
	const run = fakeRun((exe, args) => (args.includes("--output") ? writeFile(args[args.indexOf("--output") + 1], "tampered").then(() => "") : ""));
	const { installer, settings } = makeInstaller(home, { run, checksum: "b".repeat(64) });
	const status = await installer.ensure();
	check(status.state === "failed" && status.error === "checksum", "a checksum mismatch fails", JSON.stringify(status));
	check(settings().cloudflaredPath === "", "a checksum mismatch records no path", settings().cloudflaredPath);
	let kept = true;
	try {
		await stat(installTarget(home, "linux"));
	} catch {
		kept = false;
	}
	check(kept === false, "a checksum mismatch leaves no installed binary", "");
	const leftovers = await stat(dirname(installTarget(home, "linux"))).then((info) => info.isDirectory(), () => false);
	const temp = await stat(`${installTarget(home, "linux")}.download`).then(() => true, () => false);
	check(temp === false && leftovers === true, "the temporary download is removed, the directory stays", `temp=${String(temp)}`);
});

// A download that exits non-zero is reported as a download failure.
await withHome(async (home) => {
	const run = fakeRun(() => {
		throw new Error("curl exited with 5: could not resolve host");
	});
	const { installer } = makeInstaller(home, { run, checksum: "a".repeat(64) });
	const status = await installer.ensure();
	check(status.state === "failed" && status.error === "download", "a failed download is reported", JSON.stringify(status));
});

// A signature that is not Cloudflare's is refused on Windows.
await withHome(async (home) => {
	const bytes = Buffer.from("signed-by-someone-else");
	const checksum = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
	const run = fakeRun((exe, args) => (args.includes("--output") ? writeFile(args[args.indexOf("--output") + 1], bytes).then(() => "") : ""));
	const { installer, settings } = makeInstaller(home, {
		run,
		checksum,
		platform: "win32",
		verifySignature: async () => ({ ok: false, status: "UnknownError" })
	});
	const status = await installer.ensure();
	check(status.state === "failed" && status.error === "signature", "a foreign signature is refused", JSON.stringify(status));
	check(settings().cloudflaredPath === "", "a foreign signature records no path", settings().cloudflaredPath);
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
	const run = fakeRun(async (exe, args) => {
		if (args.includes("--output")) {
			await gate;
			await writeFile(args[args.indexOf("--output") + 1], "late");
		}
		return "";
	});
	const { installer } = makeInstaller(home, { run, checksum: (await import("node:crypto")).createHash("sha256").update("late").digest("hex") });
	const running = installer.ensure();
	await new Promise((resolve) => setTimeout(resolve, 30));
	check(["checking", "downloading"].includes(installer.status().state), "the status reads as in-flight while the download runs", installer.status().state);
	release();
	await running;
	check(installer.status().state === "ready", "the status settles on ready", installer.status().state);
	await rm(installTarget(home, "linux"), { force: true });
});

/* -------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nCLOUDFLARED TEST PASS (${results.length} checks)` : `\nCLOUDFLARED TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd dsh-remote && node tests/cloudflared.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` for `../lib/cloudflared.js`.

- [ ] **Step 3: Write the module**

Create `dsh-remote/lib/cloudflared.js`: the module note, `UPDATE_ENDPOINT`, the timeouts, `SHA256`, `platformQuery`, `parseUpdateManifest`, `parseSignature`, `cloudflaredCandidates` + `findCloudflared` (moved verbatim from `remote.js`), `installTarget`, `sha256File`, `installTarget`, `runCommand`, `fetchUpdateManifest`, `downloadTo`, `verifySignature`, `createCloudflaredInstaller`.

The state machine is the only part with judgement in it, so it is spelled out here:

```js
/**
 * The provisioning state machine the panel reads.
 *
 * `ensure()` is idempotent and cheap when a binary already exists: it resolves the
 * search, records the path, and returns without a single network call. Only a missing
 * binary starts a download, and only a verified one is installed, so the failure
 * states are the whole point: each one names what happened and leaves the reader with
 * the manual path field rather than a half-installed file.
 *
 * @param options - `{ layout, config, save, log }` plus every injectable probe.
 * @returns `{ status, ensure, setProxy }`.
 */
export function createCloudflaredInstaller({ layout, config, save, log, ...injectables }) {
	let status = { state: "idle" };
	let inFlight;

	const fail = (error, detail) => {
		status = { state: "failed", error, detail };
		log(`cloudflared provisioning failed (${error})${detail === undefined ? "" : `: ${detail}`}`);
		return status;
	};

	async function provision() {
		const settings = await config();
		const dshHome = layout().dshHome;
		const found = find(dshHome, settings);
		if (found !== undefined) {
			const configured = typeof settings.cloudflaredPath === "string" && settings.cloudflaredPath.length > 0;
			if (settings.cloudflaredPath !== found) await save({ cloudflaredPath: found });
			status = { state: "ready", path: found, source: configured ? "manual" : "found" };
			return status;
		}
		const query = platformQuery(platform, arch);
		if (query === undefined) return fail("unsupported", `${platform}/${arch}`);
		status = { state: "checking" };
		const target = installTarget(dshHome, platform);
		const temp = `${target}.download`;
		try {
			const manifest = await fetchManifest(query, { proxy: settings.cloudflaredProxy, run });
			if (manifest === undefined) return fail("manifest", "no usable release manifest");
			status = { state: "downloading", version: manifest.version, target };
			await mkdir(dirname(target), { recursive: true });
			await download({ url: manifest.url, dest: temp, proxy: settings.cloudflaredProxy, run });
			const digest = await sha256File(temp);
			if (digest !== manifest.checksum) return fail("checksum", `expected ${manifest.checksum}, got ${digest}`);
			const signature = await checkSignature(temp);
			if (signature.ok !== true) return fail("signature", `authenticode ${signature.status}`);
			await place(temp, target);
			await save({ cloudflaredPath: target });
			status = { state: "ready", path: target, source: "installed", version: manifest.version };
			log(`cloudflared ${manifest.version} installed at ${target}`);
			return status;
		} catch (error) {
			return fail("download", String(error?.message ?? error));
		} finally {
			// The temp file must not survive any outcome, including the verified one
			// (`place` renamed it away, so this is a no-op there).
			await rm(temp, { force: true }).catch(() => {});
		}
	}

	return {
		status: () => status,
		ensure() {
			inFlight ??= provision().finally(() => {
				inFlight = undefined;
			});
			return inFlight;
		},
		async setProxy(proxy) {
			await save({ cloudflaredProxy: normalizeProxy(proxy) });
			return status;
		}
	};
}
```

`place` is `chmod(path, 0o755)` followed by `rename(path, target)`: same directory, so the rename is atomic and a reader can never observe a partial binary. `checkSignature` is `() => verifySignature(temp, { platform, run, timeoutMs })` on win32 and `async () => ({ ok: true })` elsewhere.

- [ ] **Step 4: Run the tests again**

Run: `cd dsh-remote && node tests/cloudflared.test.mjs`
Expected: `CLOUDFLARED TEST PASS` with every check `ok`.

- [ ] **Step 5: Move the search out of `remote.js`**

Delete `cloudflaredCandidates`, `findCloudflared` and their doc comments from `dsh-remote/lib/remote.js` (currently lines 152-200), and add to its import block:

```js
import { cloudflaredCandidates, findCloudflared } from "./cloudflared.js";
```

Then drop `delimiter` from the `node:path` import if it is now unused:

Run: `cd dsh-remote && grep -n "delimiter" lib/remote.js`
Expected: only the import line remains; edit it to `import { dirname, join } from "node:path";`.

In `dsh-remote/tests/proxy.test.mjs:30`, change the import to:

```js
import { cloudflaredCandidates, findCloudflared } from "../lib/cloudflared.js";
```

- [ ] **Step 6: Run both suites**

Run: `cd dsh-remote && node tests/cloudflared.test.mjs && node tests/proxy.test.mjs`
Expected: both print `PASS`.

- [ ] **Step 7: Commit**

```bash
git add dsh-remote/lib/cloudflared.js dsh-remote/lib/remote.js dsh-remote/tests/
git commit -m "feat(dsh-remote): cloudflared 的查找与安装独立成一个模块"
```

---

### Task 3: the host half starts it and reports it

**Files:**
- Modify: `dsh-remote/lib/index.js` (createState, mount, handleAction, GET payload, renderStatus, VERSION)
- Modify: `dsh-remote/lib/remote.js` (snapshot gains `cloudflaredProxy`)
- Modify: `dsh-remote/package.json:3` (version)

**Interfaces:**
- Consumes: `createCloudflaredInstaller`, `installTarget` (Task 2).
- Produces: `GET /dsh-remote/api/remote` payload gains `cloudflaredSetup` and `remote.cloudflaredProxy`; `POST` gains `cloudflared-install` and `cloudflared-proxy`; the panel (Task 4) reads exactly those.

- [ ] **Step 1: Wire it up**

In `createState`, after `state.remote = ...`:

```js
	// Provisioning is its own object, not part of the proxy manager: it owns one
	// question (is there a cloudflared binary, and if not, get one) and nothing else.
	state.cloudflared = createCloudflaredInstaller({
		layout,
		config: () => state.config(),
		save: (patch) => state.save(patch),
		log: (message) => state.log(message)
	});
```

In `mount`, at the end (after `state.log(...)`):

```js
	// Install cloudflared when this machine has none, so the tunnel channel works the
	// moment the plugin is installed instead of asking the reader for a path. Floating
	// and non-fatal: a machine with no network must still boot with a working plugin.
	void state.cloudflared.ensure().catch((error) => state.log(`cloudflared setup failed: ${String(error?.message ?? error)}`));
```

In `handleAction`, two cases before `default`:

```js
		case "cloudflared-install": {
			// Started, not awaited: the download runs for seconds to minutes, and the
			// panel polls the status it already reads.
			void state.cloudflared.ensure().catch((error) => state.log(`cloudflared setup failed: ${String(error?.message ?? error)}`));
			return { ok: true, remote: state.remote.snapshot(), cloudflaredSetup: state.cloudflared.status() };
		}
		case "cloudflared-proxy": {
			await state.cloudflared.setProxy(body.proxy);
			return { ok: true, remote: state.remote.snapshot(), cloudflaredSetup: state.cloudflared.status() };
		}
```

In the GET `/api/remote` payload, after `cloudflared: state.remote.cloudflared() ?? null,`:

```js
				cloudflaredSetup: state.cloudflared.status(),
```

In `renderStatus`, extend the cloudflared line with its source:

```js
			`cloudflared: ${state_.remote.cloudflared() ?? "not found"}${state_.cloudflared.status().source === undefined ? "" : ` (${state_.cloudflared.status().source})`}`,
```

Add the import: `import { createCloudflaredInstaller } from "./cloudflared.js";`

In `dsh-remote/lib/remote.js`, in `snapshot()`, after `cloudflaredPath: settings().cloudflaredPath,`:

```js
		cloudflaredProxy: settings().cloudflaredProxy,
```

Bump the version in both places: `VERSION = "0.2.0"` in `lib/index.js:31` and `"version": "0.2.0"` in `package.json:3`.

- [ ] **Step 2: Verify the host half still mounts**

Run: `cd .. && node tests/host-half.test.mjs`
Expected: `PASS`, with no new failure. (It mounts every `lib/index.js` against a fake context and calls the registered route and command, so a bad import or a throwing `apply` shows up here.)

- [ ] **Step 3: Verify the new actions against a live sandbox**

Run the sandbox (see the repository AGENTS.md: `node tools/sandbox/sandbox.mjs up`), open its URL, enable the remote panel in tunnel mode once, then:

```bash
curl -s "http://127.0.0.1:25499/dsh-remote/api/remote" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify({cloudflared:j.cloudflared,setup:j.cloudflaredSetup,proxy:j.remote.cloudflaredProxy}))})"
```

Expected: `cloudflared` is a real path, `setup.state` is `ready`, and `setup.source` is `installed` on a machine where the sandbox home has none (`found` when the machine already has one).

- [ ] **Step 4: Commit**

```bash
git add dsh-remote/lib/index.js dsh-remote/lib/remote.js dsh-remote/package.json
git commit -m "feat(dsh-remote): 装完即用，加载时自己把 cloudflared 备好"
```

---

### Task 4: the panel says where it came from, and what went wrong

**Files:**
- Modify: `dsh-remote/lib/client.js` (string map, `render`, the binary block, `pollWhileInstalling`)
- Modify: `tests/panel-embed.test.mjs` (fixtures + assertions at the two `linkedPayload`/`waitingPayload` blocks and the `PAYLOADS` map)

**Interfaces:**
- Consumes: `cloudflaredSetup` and `remote.cloudflaredProxy` from Task 3.
- Produces: nothing other code reads.

- [ ] **Step 1: Add the strings**

In the `T({...})` map in `lib/client.js`, beside the existing `binary*` entries:

```js
		binaryFoundHere: ["Found on this machine", "本机已装"],
		binaryInstalled: ["Installed by the plugin", "插件自动装好"],
		binaryManual: ["Set by you", "手动指定"],
		installChecking: ["Checking whether this machine has cloudflared.", "正在检查本机有没有 cloudflared。"],
		installDownloading: ["Downloading cloudflared from Cloudflare.", "正在从 Cloudflare 下载 cloudflared。"],
		installRetry: ["Install it for me", "帮我安装"],
		installErrorManifest: ["Cloudflare's release list could not be read. Check the network or set a proxy below.", "读不到 Cloudflare 的发布清单。检查网络，或在下面填一个代理。"],
		installErrorDownload: ["The download failed. Where GitHub is unreachable, a proxy fixes it.", "下载失败。在 GitHub 不可达的网络里，填一个代理通常就能解决。"],
		installErrorChecksum: ["The downloaded file did not match Cloudflare's checksum, so it was discarded.", "下载的文件与 Cloudflare 公布的校验值不符，已丢弃。"],
		installErrorSignature: ["The downloaded file is not signed by Cloudflare, so it was discarded.", "下载的文件没有 Cloudflare 的签名，已丢弃。"],
		installErrorUnsupported: ["This platform has no cloudflared build for the plugin to fetch. Set a path below.", "这个平台上没有可自动获取的 cloudflared 版本，请在下面填一个路径。"],
		proxyLabel: ["Proxy for the download", "下载用代理"],
		proxyHint: ["Optional. Empty means the HTTPS_PROXY environment variable is used. For example http://127.0.0.1:7890.", "可选。留空则只看 HTTPS_PROXY 环境变量。例如 http://127.0.0.1:7890。"],
		proxySave: ["Save", "保存"],
		proxyPlaceholder: ["http://127.0.0.1:7890", "http://127.0.0.1:7890"],
```

- [ ] **Step 2: Read the new field and poll while it is in flight**

In `render()`, after `cloudflaredPath = data.remote?.cloudflaredPath;`:

```js
		cloudflaredSetup = data.cloudflaredSetup ?? {};
```

and after `pollWhileStarting();` add `pollWhileInstalling();`.

Declare it with the other panel state (`let cloudflaredSetup = {};` next to `let cloudflared;`) and add the poll beside `pollWhileStarting`:

```js
	/**
	 * Keep asking while the plugin is fetching cloudflared: the download runs for
	 * seconds to minutes, and a panel painted once would sit on "downloading" forever.
	 */
	function pollWhileInstalling() {
		if (!(inHub || (panel !== undefined && !panel.hidden))) return;
		const state = cloudflaredSetup.state;
		if (state !== "checking" && state !== "downloading") return;
		setTimeout(() => void render(), LINK_POLL_MS);
	}
```

- [ ] **Step 3: Replace the binary block**

Replace the `if (typeof cloudflared === "string") { ... } else if (remote.mode === "tunnel") { ... }` block in `renderRemote()` with:

```js
		// The tunnel binary is a prerequisite neither app supplies, and the plugin now
		// installs one itself, so the panel reports the source and only falls back to
		// asking for a path when that install could not run.
		const setup = cloudflaredSetup ?? {};
		const source = { found: T("binaryFoundHere"), manual: T("binaryManual"), installed: T("binaryInstalled") }[setup.source];
		if (typeof cloudflared === "string") {
			fragment.append(el("div", { class: "field" }, el("label", { text: T("binary") }),
				el("div", { class: "row" },
					el("div", { class: "row-main" },
						el("div", { class: "row-name", text: T("binaryFound") }),
						el("div", { class: "row-sub", text: [cloudflared, source, setup.version].filter(Boolean).join(" · "), title: cloudflared })),
					el("div", { class: "row-actions" },
						cloudflaredPath === "" ? undefined : el("button", { text: T("binaryClear"), onclick: () => void act({ action: "cloudflared", path: "" }) })))));
		} else if (remote.mode !== "tunnel") {
			// Only the tunnel channel needs a binary, so the others stay quiet about it.
		} else if (setup.state === "checking" || setup.state === "downloading") {
			fragment.append(el("div", { class: "note", text: setup.state === "checking"
				? T("installChecking")
				: [T("installDownloading"), setup.version].filter(Boolean).join(" ") }));
		} else {
			fragment.append(el("div", { class: "note", text: installErrorText(setup) }));
			const field = el("input", { type: "text", value: cloudflaredPath ?? "", placeholder: T("binaryPlaceholder") });
			fragment.append(el("div", { class: "field" }, el("label", { text: T("binaryPath") }), field,
				el("div", { class: "actions" },
					el("button", { class: "primary", text: T("installRetry"), onclick: () => void act({ action: "cloudflared-install" }) }),
					el("button", { text: T("binarySave"), onclick: () => void act({ action: "cloudflared", path: field.value }) }))));
		}

		// The proxy only matters for reaching Cloudflare's release host, so it sits with
		// the binary and only where it can matter.
		if (remote.mode === "tunnel") {
			const proxy = el("input", { type: "text", value: remote.cloudflaredProxy ?? "", placeholder: T("proxyPlaceholder") });
			fragment.append(el("div", { class: "field" }, el("label", { text: T("proxyLabel") }), proxy,
				el("div", { class: "note", text: T("proxyHint") }),
				el("div", { class: "actions" }, el("button", { text: T("proxySave"), onclick: () => void act({ action: "cloudflared-proxy", proxy: proxy.value }) }))));
		}
```

and add the reason lookup:

```js
	/** The failure reason in the reader's language; the codes are the host's. */
	function installErrorText(setup) {
		return {
			manifest: T("installErrorManifest"),
			download: T("installErrorDownload"),
			checksum: T("installErrorChecksum"),
			signature: T("installErrorSignature"),
			unsupported: T("installErrorUnsupported")
		}[setup.error] ?? T("cloudflaredMissing");
	}
```

- [ ] **Step 4: Extend the panel-embed fixtures and assertions**

In `tests/panel-embed.test.mjs`, add `cloudflaredSetup: { state: "ready", path: "C:/tools/cloudflared.exe", source: "found" }` to both `waitingPayload` and `linkedPayload`, and add a third block after them:

```js
// cloudflared is fetched by the plugin itself after install, so a panel that is
// waiting on that download has to keep asking, and one that holds a failure has to
// show the reason and offer the install again.
const downloadingPayload = {
	remote: {
		state: "off", enabled: false, mode: "tunnel", proxyPort: undefined, cloudflaredPath: "", cloudflaredProxy: "", lanUrls: []
	},
	cloudflared: null, qrAvailable: true, qrPath: "/dsh-remote/qr.svg",
	cloudflaredSetup: { state: "downloading", version: "2026.10.0", target: "C:/Users/x/tunnel/cloudflared.exe" }
};
const downloading = await bootPanel("dsh-remote", { payload: downloadingPayload, timers: [] });
check(
	downloading.timers.includes(2000),
	"dsh-remote: a panel waiting on the cloudflared download keeps asking",
	downloading.timers.join(",") || "(nothing scheduled)"
);
check(
	textOf(downloading.host).includes("2026.10.0"),
	"dsh-remote: the download note names the version being fetched",
	textOf(downloading.host).slice(0, 160)
);

const failedPayload = {
	remote: {
		state: "off", enabled: false, mode: "tunnel", proxyPort: undefined, cloudflaredPath: "", cloudflaredProxy: "", lanUrls: []
	},
	cloudflared: null, qrAvailable: true, qrPath: "/dsh-remote/qr.svg",
	cloudflaredSetup: { state: "failed", error: "checksum" }
};
const failedInstall = await bootPanel("dsh-remote", { payload: failedPayload, timers: [] });
check(
	!failedInstall.timers.includes(2000),
	"dsh-remote: a settled failure stops asking",
	failedInstall.timers.join(",") || "(nothing scheduled)"
);
check(
	textOf(failedInstall.host).toLowerCase().includes("checksum"),
	"dsh-remote: the failure reason reaches the panel",
	textOf(failedInstall.host).slice(0, 200)
);
check(
	descendants(failedInstall.host).some((child) => child.tag === "button"),
	"dsh-remote: a failed install still offers a way out",
	descendants(failedInstall.host).map((child) => child.tag).join(",")
);
```

Also add the field to the `PAYLOADS` map entry (`tests/panel-embed.test.mjs:68`):

```js
	"dsh-remote": { remote: { enabled: false, mode: "lan" }, cloudflared: null, qrAvailable: false, cloudflaredSetup: { state: "ready", source: "found" } }
```

- [ ] **Step 5: Run it**

Run: `node tests/panel-embed.test.mjs`
Expected: `PASS`, including the three new `dsh-remote` checks. If a check fails, the panel's own render is the suspect: the fixtures above declare the real payload shape, and a thin one makes the render throw and every assertion pass vacuously.

- [ ] **Step 6: Commit**

```bash
git add dsh-remote/lib/client.js tests/panel-embed.test.mjs
git commit -m "feat(dsh-remote): 面板说明 cloudflared 从哪来，并盯住下载进度"
```

---

### Task 5: docs, then ship it to the installed app

**Files:**
- Modify: `dsh-remote/README.md` (the cloudflared caveat), `AGENTS.md` (the dsh-remote bullet)

- [ ] **Step 1: Update the two documents**

`dsh-remote/README.md`: in **Caveats**, replace the "Tunnel mode needs a cloudflared binary" bullet's remedy sentence with the new behaviour: the plugin fetches it itself on first load when the search finds none, from Cloudflare's update endpoint (`{version, url, checksum}`), installs it to `<dsh home>/../tunnel/`, and verifies the sha256 (plus the Authenticode signature on Windows) before keeping it; `cloudflaredProxy` covers a network where `github.com` is unreachable; a manual path still wins.

`AGENTS.md`: in the **phone (dsh-remote)** section, extend the cloudflared bullet: the search stays injectable (`cloudflaredCandidates`) and now has a provisioning counterpart in `lib/cloudflared.js` whose version and sha256 come from `https://update.argotunnel.com/?os=&arch=` (the manifest cloudflared's own updater uses, which is reachable from networks where `github.com` is DNS-poisoned and is not behind the GitHub API rate limit), while the bytes are fetched with `curl` so a proxy can be used, and nothing is installed unless the hash (and the Windows signature) match.

- [ ] **Step 2: Run the whole set**

Run: `node tests/manifest.test.mjs && node tests/hub-contract.test.mjs && node tests/host-half.test.mjs && node tests/panel-embed.test.mjs && node tests/mobile-layer.test.mjs`
Expected: every suite `PASS`. `hub-contract` is the one that fails on an em dash in any non-comment line.

Then: `cd dsh-remote && node tests/cloudflared.test.mjs && node tests/proxy.test.mjs`
Expected: both `PASS`.

- [ ] **Step 3: Boot all packages together**

Run: `node tools/sandbox/sandbox.mjs up --restart` and open the printed URL; look for the ready line and no `did not activate` warning.
Expected: dsh boots, the 手机远程 panel opens, and the binary row reads "Found on this machine" or "Installed by the plugin".

- [ ] **Step 4: Mirror it into the installed app**

Run: `node tools/hotreload/hotreload.mjs sync && node tools/hotreload/hotreload.mjs status`
Expected: every package reads `in sync`. This step is not optional: the user reads the installed app, so a change that exists only in this tree has not happened for them. The host half does not hot reload, so follow it with `node tools/hotreload/hotreload.mjs restart` when it has to be visible immediately.

- [ ] **Step 5: Commit**

```bash
git add dsh-remote/README.md AGENTS.md
git commit -m "docs(dsh-remote): 记下 cloudflared 现在由插件自己装好"
```

---

## Self-Review

**Spec coverage:** auto-install when missing → Task 2/3; check first, no network when present → Task 2 (`an existing binary costs no network call`); official version + sha256 → Task 2 `parseUpdateManifest`/`fetchUpdateManifest`; proxy setting (env var + field) → Task 1, Task 3, Task 4; install location `<DSH_HOME>/../tunnel/` → Task 2 `installTarget`; Windows signature gate → Task 2 `parseSignature` + the signature test; panel source/progress/failure/retry → Task 4; nothing installed on a mismatch → Task 2's checksum test; docs → Task 5.

**Placeholder scan:** no TBDs; every code step carries the code, every command its expected output.

**Type consistency:** `cloudflaredSetup` (`{state, path?, source?, version?, target?, error?, detail?}`) is produced in Task 2/3 and consumed only in Task 4; `installTarget(dshHome, platform)` is used by the module and by its tests; `ensure()` returns the status object it also records, and `setProxy()` returns the same shape; the reason codes (`manifest`, `download`, `checksum`, `signature`, `unsupported`) are written in Task 2 and read in Task 4.

**Length:** within budget, with the state machine and the network module in full because they carry the judgement.

---

## Deviations taken during execution

Both were forced by what the running app showed, not by preference.

1. **No path is written into the settings, ever** (the plan's "records which path that was"). The live app
   restarted twice during a host-half edit, so the second boot read back the path the first boot had
   recorded and reported the reader's own auto-discovery as `source: "manual"`, i.e. "path set by you"
   about a file they never chose. A value in `cloudflaredPath` now means only one thing: the reader picked
   that binary. Auto-discovery is left to the search, which already covers `<dsh home>/../tunnel/`, so the
   install target is found on the next load and reported as `found`.
2. **`findCloudflared` grew trailing `platform`, `env` and `execPath` parameters.** The installer threads
   its injectables through it, because the binary's name depends on the platform and a test faking a Linux
   machine must not search the real machine's `PATH`. The two-argument call sites are unchanged.

Also worth recording as measured, because it shaped the failure path: on this network the manifest read
succeeds and the *download* is what fails (`curl` exits 60, "self signed certificate in certificate
chain", from the poisoned `github.com`), which the installer reports as `error: "download"` with nothing
installed. With `cloudflaredProxy` set to `http://127.0.0.1:7890` the same run finished in about 12 s,
55,365,048 bytes, digest identical to the manifest's, Authenticode `Valid` by Cloudflare, Inc.
