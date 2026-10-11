#!/usr/bin/env node
/**
 * Hot reload for the installed desktop app: edit this working tree, see it in the running dsh.
 *
 * Why a tool is needed, measured 2026-10-11 against the app's own runtime (dsh 0.2.0-rc.2, the
 * `dsh-desktop-host` child process that owns the web port):
 *
 *   - **The install is a copy.** The app installs a plugin as a pnpm git tarball at one commit, so
 *     `<home>/profiles/<profile>/node_modules/dsh-*` is a plain directory and editing this working
 *     tree changes nothing the app can see. This tool mirrors the working tree into those copies,
 *     and keeps mirroring while it runs.
 *   - **The client half is already hot.** `@deepseek-ai/dsh-web-app` mounts `@deepseek-ai/dsh-client-hmr`,
 *     which stat-polls every client bundle every 500ms, recomputes its rev and pushes a `rebuilt`
 *     frame over `/plugins/events`; the browser applies the new bundle in place. Verified on the
 *     running app: appending one byte to an installed `lib/client.js` produced
 *     `{"type":"rebuilt","id":"dsh-features",...}`. Nothing else is needed for a `client.js` edit,
 *     except that the open panel is dropped when the module is re-registered, so reopen it.
 *   - **The host half is not.** `@deepseek-ai/dsh-base` mounts `@deepseek-ai/dsh-hmr` with `root: []`
 *     ("Profile configuration reloads by default; module roots are opt-in"), and the service refuses
 *     to start without Node internals: `cordis-plugin-loader` only sets `loader.internal` when
 *     `process.execArgv` contains `--expose-internals`. The app's launcher passes no such flag, so as
 *     launched for you that row cannot watch modules at all. `restart` below relaunches it WITH the
 *     flag, and the block below opts the roots in, so the row does log `watching [...]` there. It
 *     still reloaded nothing: with the watch installed and a file-URL `base`, ten seconds of polls
 *     after a module write showed the app serving the old code, while the same block on the same
 *     runtime under a CLI launcher (the sandbox) reloaded in place. So the app gets a process
 *     restart on a host edit, debounced, unless `--no-restart`.
 *   - **A `cordis.patch.yml` change is hot** whenever `dsh-hmr` is alive (that is its default job),
 *     which is why writing the block below needs no restart of its own.
 *
 * Usage (any Node 22+):
 *   node tools/hotreload/hotreload.mjs up               # mirror, write the block, watch in this terminal
 *   node tools/hotreload/hotreload.mjs up --background  # same, detached, into .hotreload/<target>.log
 *   node tools/hotreload/hotreload.mjs status           # what is running, and whether the copies are in sync
 *   node tools/hotreload/hotreload.mjs sync             # mirror once and exit (no watch, no patch change)
 *   node tools/hotreload/hotreload.mjs down             # stop watching, remove the block it wrote
 *   node tools/hotreload/hotreload.mjs restart          # quit and relaunch the app (with --expose-internals)
 *
 * Flags: --home <dir> (default $DSH_HOME or ~/.dsh), --profile <name> (default desktop),
 *        --packages a,b (default: every dsh-* package in this repository the profile declares),
 *        --app <exe>, --interval <ms> (default 600), --no-restart, --dry-run.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(import.meta.url);
const repo = resolve(dirname(here), "..", "..");

const argv = process.argv.slice(2);
const command = argv[0] ?? "up";
const flag = (name, fallback) => {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? fallback : argv[at + 1] ?? fallback;
};
const has = (name) => argv.includes(`--${name}`);

const home = resolve(flag("home", process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh")));
const profile = flag("profile", "desktop");
const appExe = resolve(flag("app", "F:/Code/dsh/DeepSeek Harness.exe"));
const appName = "DeepSeek Harness";
const interval = Math.max(Number(flag("interval", 600)), 100);
const restartOnHost = !has("no-restart");
const dryRun = has("dry-run");
const only = flag("packages", null)?.split(",").map((name) => name.trim()).filter(Boolean);

const profileDir = join(home, "profiles", profile);
const patchPath = join(profileDir, "cordis.patch.yml");
const modulesDir = join(profileDir, "node_modules");
const stateDir = join(repo, ".hotreload");
/** One state file and one log per target, so the app and a sandbox can both be watched at once. */
const targetKey = `${home}|${profile}`.replace(/[^A-Za-z0-9]+/gu, "-");
const statePath = join(stateDir, `${targetKey}.state.json`);
const logPath = join(stateDir, `${targetKey}.log`);

/** The target, as the two paths a reader can check. */
const targetLabel = () => join(home, "profiles", profile);

/** The block this tool owns inside the profile's patch. Marked so `down` can lift it out again. */
const MARK_START = "# >>> dsh-hotreload >>>";
const MARK_END = "# <<< dsh-hotreload <<<";
/** Never mirrored: nothing dsh loads lives in these. */
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", ".trash"]);

/* ------------------------------------------------------------------- helpers */

const log = (line) => console.log(line);

/** A recursive file list of one directory, as paths relative to it. */
function walk(root, at = root, found = []) {
	let entries;
	try {
		entries = readdirSync(at, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(at, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(root, path, found);
		} else if (entry.isFile()) {
			found.push(relative(root, path));
		}
	}
	return found;
}

/** Whether the installed copy already holds exactly what the source holds. */
function sameContent(from, to) {
	try {
		if (statSync(from).size !== statSync(to).size) return false;
		return readFileSync(from).equals(readFileSync(to));
	} catch {
		return false;
	}
}

/** Every `dsh-*` package in this repository. */
function localPackages() {
	return readdirSync(repo, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-") && existsSync(join(repo, entry.name, "package.json")))
		.map((entry) => entry.name)
		.sort();
}

/** The packages the target profile installs: its dependencies plus the bundles it mounts. */
function declaredPackages() {
	const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
	const names = new Set(Object.keys(manifest.dependencies ?? {}));
	for (const bundle of manifest.dsh?.profile?.bundles ?? []) if (typeof bundle === "string") names.add(bundle);
	return names;
}

/** The packages to mirror: this repository's, limited to what the profile declares (and `--packages`). */
function targets() {
	if (!existsSync(join(profileDir, "package.json"))) {
		log(`hotreload: no profile at ${profileDir}; is the app installed with home ${home}?`);
		process.exit(1);
	}
	const declared = declaredPackages();
	const wanted = only ?? localPackages();
	const chosen = wanted.filter((name) => declared.has(name));
	const skipped = wanted.filter((name) => !declared.has(name));
	return { chosen, skipped };
}

/* ------------------------------------------------------------------ the mirror */

/**
 * Mirror one package into the installed copy.
 *
 * A package the profile installed from a local path is a junction onto the source itself: it is
 * already live and nothing is copied. Otherwise the installed directory is a copy, and every file
 * whose content differs (size first, then bytes) is replaced, and the fresh write is what tells dsh
 * the bundle changed. Files the source no longer has are removed, so a deleted module cannot keep
 * loading. Content, not timestamps: a copy that only differs by sub-millisecond mtime would look
 * stale forever on NTFS and be rewritten on every tick.
 *
 * @param name - package name.
 * @returns `{ linked, copied, removed }` with paths relative to the package.
 */
function syncPackage(name) {
	const source = join(repo, name);
	const dest = join(modulesDir, name);
	let destStat;
	try {
		destStat = lstatSync(dest);
	} catch {
		return { linked: false, copied: [], removed: [], missing: true };
	}
	if (destStat.isSymbolicLink()) return { linked: true, copied: [], removed: [] };
	const copied = [];
	const removed = [];
	const wanted = new Set(walk(source));
	for (const rel of wanted) {
		const from = join(source, rel);
		const to = join(dest, rel);
		if (sameContent(from, to)) continue;
		if (dryRun) {
			copied.push(rel);
			continue;
		}
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
		copied.push(rel);
	}
	for (const rel of walk(dest)) {
		if (wanted.has(rel)) continue;
		if (dryRun) {
			removed.push(rel);
			continue;
		}
		rmSync(join(dest, rel), { force: true });
		removed.push(rel);
	}
	return { linked: false, copied, removed, missing: false };
}

/** What a changed file means for the running app. */
function effectOf(rel) {
	if (/(^|\/)client\.(js|css)$/u.test(rel) || rel.startsWith("assets")) {
		return { kind: "client", note: "client half: the browser takes it by itself (<=0.5s), reopen the panel if one is open" };
	}
	if (rel.startsWith("locale")) return { kind: "meta", note: "display metadata: the next page that reads it sees it" };
	return { kind: "host", note: "host half: needs the module watch, otherwise the app restarts" };
}

/* ------------------------------------------------------------------ the patch */

/**
 * The marked block: module roots for dsh-hmr.
 *
 * `base` is set explicitly and the roots are relative to it, because with no `base` dsh resolves them
 * against its loader's `baseUrl`, which is not ours to know. The value has to be a **file URL**: dsh
 * runs `fileURLToPath(new URL(base, ctx.baseUrl))`, so a Windows path turns into an `h:` URL and the
 * row throws `ERR_INVALID_URL_SCHEME` while it constructs, taking the whole watch with it (measured
 * 2026-10-11, on the sandbox's own log). The `ignored` list replaces the default, which excludes any
 * node_modules directory, exactly where an installed plugin lives.
 */
function block(names) {
	const roots = names.map((name) => `      - node_modules/${name}`).join("\n");
	return `${MARK_START}
# Module watch for these packages (dsh-hmr's root is opt-in; empty in @deepseek-ai/dsh-base).
- id: hmr
  config:
    base: ${pathToFileURL(profileDir).href}
    root:
${roots}
    ignored:
      - "**/tests/**"
      - "**/.git/**"
${MARK_END}`;
}

/** Read the profile patch, or an empty document when the profile has none. */
function readPatch() {
	try {
		return readFileSync(patchPath, "utf8");
	} catch {
		return "";
	}
}

/** Strip the block this tool wrote, leaving every other entry exactly as it was. */
function stripBlock(text) {
	const from = text.indexOf(MARK_START);
	if (from === -1) return text;
	const to = text.indexOf(MARK_END, from);
	const end = to === -1 ? text.length : to + MARK_END.length;
	return `${text.slice(0, from)}${text.slice(end)}`.replace(/\n{3,}/gu, "\n\n").trimEnd() + "\n";
}

/** Write the block, replacing any previous one. Refuses to fight a hand-written `hmr` entry. */
function writeBlock(names) {
	const text = readPatch();
	const withoutBlock = stripBlock(text);
	const handWritten = withoutBlock
		.split(/\r?\n/u)
		.some((line) => /^\s*-\s*id:\s*hmr\s*$/u.test(line) || /^\s*id:\s*hmr\s*$/u.test(line));
	if (handWritten) {
		log(`hotreload: ${patchPath} already has its own \`hmr\` entry; add these roots to it by hand:`);
		log(block(names).split("\n").slice(2, -1).join("\n"));
		process.exitCode = 1;
		return false;
	}
	const next = `${withoutBlock}${withoutBlock.trimEnd() === "" ? "" : "\n"}\n${block(names)}\n`;
	if (dryRun) {
		log(`hotreload: would write this block into ${patchPath}:`);
		log(block(names));
		return true;
	}
	mkdirSync(dirname(patchPath), { recursive: true });
	writeFileSync(patchPath, next, "utf8");
	return true;
}

/** Remove the block, if any. */
function removeBlock() {
	const text = readPatch();
	if (!text.includes(MARK_START)) return false;
	if (dryRun) {
		log(`hotreload: would remove the block from ${patchPath}`);
		return true;
	}
	writeFileSync(patchPath, stripBlock(text), "utf8");
	return true;
}

/* ------------------------------------------------------------------- the app */

/** The app's processes, so "is it running" and the restart can both work by name. */
function appProcesses() {
	const result = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${appName}.exe`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
	return String(result.stdout ?? "")
		.split(/\r?\n/u)
		.filter((line) => line.includes(appName))
		.map((line) => Number(line.split('","')[1]?.replaceAll('"', "")))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Quit the app and start it again, with `--expose-internals` in argv.
 *
 * The flag is what lets `dsh-hmr` construct at all (`cordis-plugin-loader` looks for it in
 * `process.execArgv`), so it is the difference between "module roots can be watched" and "they
 * cannot". The app forwards its own argv to the `dsh-desktop-host` child that holds the web port,
 * which is why launching the app with the flag reaches the dsh.
 */
function restartApp() {
	if (dryRun) {
		log(`hotreload: would quit ${appName} and relaunch ${appExe} --expose-internals`);
		return;
	}
	for (const pid of appProcesses()) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
	const child = spawn(appExe, ["--expose-internals"], { detached: true, stdio: "ignore", windowsHide: false });
	child.unref();
	log(`hotreload: relaunched ${appName} with --expose-internals`);
}

/* --------------------------------------------------------------------- state */

const alive = (pid) => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const result = spawnSync("tasklist", ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
	return String(result.stdout ?? "").includes(String(pid));
};

const readState = () => {
	if (!existsSync(statePath)) return undefined;
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return undefined;
	}
};

/* ------------------------------------------------------------------- commands */

/** `up` and `sync` differ only in what they leave behind: a watcher, or nothing. */
function mirror(names, { quiet = false } = {}) {
	for (const name of names) {
		const result = syncPackage(name);
		if (result.missing === true) {
			log(`hotreload: ${name} is not installed in this profile, skipped`);
			continue;
		}
		if (result.linked) {
			if (!quiet) log(`hotreload: ${name} is a local link already, nothing to mirror`);
			continue;
		}
		const count = result.copied.length + result.removed.length;
		if (count > 0 || !quiet) {
			log(`hotreload: ${name}: ${String(result.copied.length)} updated, ${String(result.removed.length)} removed`);
		}
	}
}

/** One watch tick: mirror everything, report what moved, restart the app if a host half moved. */
function tick(names, runtime) {
	let hostChanged = false;
	for (const name of names) {
		const result = syncPackage(name);
		if (result.missing === true || result.linked) continue;
		for (const rel of [...result.copied, ...result.removed]) {
			const effect = effectOf(rel.replaceAll("\\", "/"));
			if (effect.kind === "host") hostChanged = true;
			log(`hotreload: ${new Date().toLocaleTimeString()} ${name}/${rel.replaceAll("\\", "/")}  ${effect.note}`);
		}
	}
	if (!hostChanged || !restartOnHost) return;
	const now = Date.now();
	if (now - runtime.lastRestart < 15000) return;
	runtime.lastRestart = now;
	if (appProcesses().length === 0) {
		log("hotreload: host half changed, the app is not running: the next launch loads it");
		return;
	}
	log("hotreload: host half changed, restarting the app so it loads");
	restartApp();
}

function watch(names) {
	writeFileSync(statePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), home, profile, packages: names, interval }, null, 1));
	log(`hotreload: watching ${String(names.length)} package(s) every ${String(interval)}ms; Ctrl+C to stop`);
	const runtime = { lastRestart: 0 };
	const timer = setInterval(() => {
		try {
			tick(names, runtime);
		} catch (error) {
			log(`hotreload: sync failed: ${String(error?.message ?? error)}`);
		}
	}, interval);
	const stop = () => {
		clearInterval(timer);
		rmSync(statePath, { force: true });
		log("hotreload: stopped watching");
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

function up() {
	if (!existsSync(join(profileDir, "package.json"))) {
		log(`hotreload: no profile at ${profileDir}; is the app installed with home ${home}?`);
		process.exitCode = 1;
		return;
	}
	const { chosen, skipped } = targets();
	if (chosen.length === 0) {
		log(`hotreload: none of this repository's packages are in profile "${profile}"`);
		process.exitCode = 1;
		return;
	}
	log(`hotreload: home ${home}, profile ${profile}`);
	if (skipped.length > 0) log(`hotreload: not in this profile, skipped: ${skipped.join(", ")}`);
	if (!writeBlock(chosen)) return;
	mirror(chosen);
	if (dryRun) return;
	if (!has("background")) {
		watch(chosen);
		return;
	}
	mkdirSync(stateDir, { recursive: true });
	const fd = openSync(logPath, "a");
	const child = spawn(process.execPath, [here, "watch", "--home", home, "--profile", profile, "--interval", String(interval), ...(only === undefined ? [] : ["--packages", only.join(",")])], {
		detached: true,
		stdio: ["ignore", fd, fd],
		windowsHide: true
	});
	child.unref();
	closeSync(fd);
	writeFileSync(statePath, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), home, profile, packages: chosen, interval }, null, 1));
	log(`hotreload: watching ${targetLabel()} in the background (pid ${String(child.pid)}); log ${logPath}`);
	log("hotreload: your edits are live: a client.js change shows up on its own, a host half restarts the app");
}

function status() {
	const state = readState();
	if (state === undefined || !alive(state.pid)) {
		log(`hotreload: not watching ${targetLabel()}${state === undefined ? "" : " (stale state file)"}`);
	} else {
		log(`hotreload: watching ${targetLabel()} (pid ${String(state.pid)}) since ${state.startedAt}, every ${String(state.interval)}ms`);
	}
	if (existsSync(stateDir)) {
		const others = readdirSync(stateDir).filter((entry) => entry.endsWith(".state.json") && entry !== `${targetKey}.state.json`);
		for (const entry of others) {
			const other = (() => {
				try {
					return JSON.parse(readFileSync(join(stateDir, entry), "utf8"));
				} catch {
					return undefined;
				}
			})();
			if (other !== undefined) log(`hotreload: also recorded: ${join(other.home, "profiles", other.profile)} (pid ${String(other.pid)}${alive(other.pid) ? "" : ", not running"})`);
		}
	}
	const text = readPatch();
	log(`hotreload: the module-root block is ${text.includes(MARK_START) ? "in" : "not in"} ${patchPath}`);
	const running = appProcesses();
	log(`hotreload: the app is ${running.length === 0 ? "not running" : `running (${String(running.length)} processes)`}`);
	const { chosen, skipped } = targets();
	for (const name of chosen) {
		const dest = join(modulesDir, name);
		if (!existsSync(dest)) {
			log(`  ${name}: not installed here`);
			continue;
		}
		if (lstatSync(dest).isSymbolicLink()) {
			log(`  ${name}: local link, always live`);
			continue;
		}
		const drift = walk(join(repo, name)).filter((rel) => !sameContent(join(repo, name, rel), join(dest, rel)));
		const extra = walk(dest).filter((rel) => !existsSync(join(repo, name, rel)));
		log(`  ${name}: ${drift.length === 0 && extra.length === 0 ? "in sync" : `${String(drift.length)} file(s) differ, ${String(extra.length)} extra`}`);
	}
	if (skipped.length > 0) log(`  skipped (not in this profile): ${skipped.join(", ")}`);
}

function down() {
	const state = readState();
	if (state !== undefined && alive(state.pid)) {
		spawnSync("taskkill", ["/PID", String(state.pid), "/T", "/F"], { windowsHide: true });
		log(`hotreload: stopped watching (pid ${String(state.pid)})`);
	} else {
		log("hotreload: nothing was watching");
	}
	rmSync(statePath, { force: true });
	log(removeBlock() ? "hotreload: removed the module-root block" : "hotreload: no block to remove");
}

/* ----------------------------------------------------------------------- main */

if (command === "up") up();
else if (command === "sync") mirror(targets().chosen, { quiet: false });
else if (command === "watch") watch(targets().chosen);
else if (command === "status") status();
else if (command === "down") down();
else if (command === "restart") restartApp();
else {
	log(`hotreload: unknown command "${command}"; use up, sync, watch, status, down or restart`);
	process.exitCode = 1;
}
