/**
 * A persistent dsh sandbox, so testing the whole plugin set is one command.
 *
 * Why this exists: the expensive part of a sandbox is not the boot, it is rebuilding
 * the home. A profile that already exists is reused forever, and a package installed
 * from a local path becomes a pnpm `link:` — so after the first run, a code change
 * needs nothing but a restart of the process.
 *
 * Layout (inside the repository, so everything about testing sits in one place; `.sandbox/`
 * is in `.gitignore` and must never be committed — it is a whole dsh home with sessions,
 * storages and pnpm links in it):
 *   .sandbox/                      the sandbox home
 *     profiles/<profile>/          generated once from the app's own `web` template
 *     sandbox.state.json           pid, port, url and token of the running instance
 *     sandbox.log                  that instance's stdout/stderr
 *
 * Usage (run with the runtime's node, from the repository root):
 *   node tools/sandbox/sandbox.mjs up            # create if needed, install, boot, print the URL
 *   node tools/sandbox/sandbox.mjs up --restart  # restart the running instance (the usual loop)
 *   node tools/sandbox/sandbox.mjs url           # print the URL of the running instance
 *   node tools/sandbox/sandbox.mjs down          # stop it
 *
 * Flags: --port <n>, --profile <name>, --home <dir>, --dsh <path to dsh.cmd>, --no-install.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The carrier CLI of the official desktop app: the dsh it ships, without a symlink farm. */
const DEFAULT_DSH = "F:/Code/dsh/resources/runtime/cli/bin/dsh.cmd";
/** The sandbox home. Inside the repository so it is one place to look, and gitignored. */
const DEFAULT_HOME = join(repo, ".sandbox");
const DEFAULT_PROFILE = "sandbox";
/** The first port to try; a busy one moves up. */
const DEFAULT_PORT = 25499;

const argv = process.argv.slice(2);
const command = argv[0] ?? "up";
const flag = (name, fallback) => {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const has = (name) => argv.includes(`--${name}`);

const home = resolve(flag("home", DEFAULT_HOME));
const profile = flag("profile", DEFAULT_PROFILE);
const dsh = flag("dsh", DEFAULT_DSH);
const statePath = join(home, "sandbox.state.json");
const logPath = join(home, "sandbox.log");

/** Every `dsh-*` package in this repository, which is the set to install. */
function localPackages() {
	return readdirSync(repo, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-") && existsSync(join(repo, entry.name, "package.json")))
		.map((entry) => entry.name)
		.sort();
}

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

/** Run a command to completion with a live-enough timeout; returns `{ status, output }`. The
 *  sandbox home is forced through `DSH_HOME`, because a missing one makes the CLI write into the
 *  user's real `~/.dsh` without saying so. */
function run(file, args, timeoutMs = 180000) {
	const result = spawnSync(file, args, { shell: true, encoding: "utf8", timeout: timeoutMs, windowsHide: true, env: { ...process.env, DSH_HOME: home } });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Read the state file, or undefined when nothing is recorded. */
function readState() {
	if (!existsSync(statePath)) return undefined;
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return undefined;
	}
}

/** True when the recorded process is still alive. */
function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const result = spawnSync("tasklist", ["/FI", `PID eq ${String(pid)}`], { encoding: "utf8", windowsHide: true });
	return String(result.stdout ?? "").includes(String(pid));
}

/**
 * The pid listening on `port`, or undefined. This, not the spawn's pid, is the handle on a running
 * sandbox: `dsh.cmd` is a batch file, so the process this script spawns is a `cmd.exe` wrapper and
 * the dsh itself is its child.
 */
function portOwner(port) {
	const result = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
	for (const line of String(result.stdout ?? "").split(/\r?\n/u)) {
		if (!line.includes("LISTENING")) continue;
		const parts = line.trim().split(/\s+/u);
		if (parts[1]?.endsWith(`:${String(port)}`) === true) return Number(parts[4]);
	}
	return undefined;
}

/** Kill a process tree, tolerating a pid that is already gone. */
function kill(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (!alive(pid)) return false;
	spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
	return true;
}

/** Stop the recorded instance: both the dsh that owns the port and the wrapper that spawned it. */
function stop() {
	const state = readState();
	if (state === undefined) {
		console.log("sandbox: nothing recorded, nothing to stop");
		return;
	}
	const owner = portOwner(state.port);
	const killed = [kill(state.pid), kill(owner)].filter(Boolean).length;
	console.log(killed === 0 ? `sandbox: nothing was running on port ${String(state.port)}` : `sandbox: stopped ${String(killed)} process(es)`);
	rmSync(statePath, { force: true });
}

/** The first free port at or above `from`. */
function freePort(from) {
	for (let port = from; port < from + 20; port += 1) {
		if (portOwner(port) === undefined) return port;
	}
	throw new Error(`no free port in ${String(from)}..${String(from + 20)}`);
}

/** Generate the profile once. `--from-default-profile` creates it and then boots it, so this
 * waits for the directory to appear and stops that first instance: its only job was the files. */
async function ensureProfile() {
	const profileDir = join(home, "profiles", profile);
	if (existsSync(join(profileDir, "package.json"))) {
		console.log(`sandbox: profile "${profile}" already exists`);
		return;
	}
	console.log(`sandbox: generating profile "${profile}" from the app's web template`);
	mkdirSync(home, { recursive: true });
	const child = spawn(`"${dsh}" ${profile} --from-default-profile web`, { shell: true, stdio: "ignore", windowsHide: true, env: { ...process.env, DSH_HOME: home } });
	for (let waited = 0; waited < 60000; waited += 500) {
		if (existsSync(join(profileDir, "package.json"))) break;
		await sleep(500);
	}
	spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
	if (!existsSync(join(profileDir, "package.json"))) throw new Error(`the profile was not created under ${profileDir}`);
	console.log("sandbox: profile created");
}

/** Install every local package that the profile does not depend on yet. Installs are `link:`s,
 * so a later code change is picked up by a restart alone. */
function install() {
	const manifestPath = join(home, "profiles", profile, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const declared = Object.keys(manifest.dependencies ?? {});
	const missing = localPackages().filter((pkg) => !declared.includes(pkg));
	if (missing.length > 0) {
		for (const pkg of missing) {
			const { status, output } = run(`"${dsh}" plugin --profile ${profile} add "${join(repo, pkg)}"`);
			if (status !== 0) throw new Error(`installing ${pkg} failed:\n${output.trim()}`);
			console.log(`sandbox: installed ${pkg}`);
		}
	}
	// The install is the one step that can silently land somewhere else: without `DSH_HOME` the
	// CLI writes into the user's real home. Assert on the result rather than trusting the exit code.
	const after = JSON.parse(readFileSync(manifestPath, "utf8"));
	const deps = Object.keys(after.dependencies ?? {});
	const bundles = after.dsh?.profile?.bundles ?? [];
	const problems = localPackages().filter((pkg) => !deps.includes(pkg) || !bundles.includes(pkg));
	if (problems.length > 0) {
		throw new Error(`the profile at ${manifestPath} does not carry ${problems.join(", ")}; deps=${deps.join(",")} bundles=${bundles.join(",")}`);
	}
	console.log(`sandbox: all ${String(localPackages().length)} packages are in ${profile} (${manifestPath})`);
}

/** Boot the profile and wait for its ready line, which carries the local URL and token. */
async function boot() {
	const port = freePort(Number(flag("port", DEFAULT_PORT)));
	rmSync(logPath, { force: true });
	// The child writes the log itself, through an inherited descriptor. Piping it would keep a
	// handle on this script's event loop, so the command would never return while dsh runs.
	const fd = openSync(logPath, "w");
	const child = spawn(`"${dsh}" ${profile} --port ${String(port)} --no-open`, {
		shell: true,
		detached: true,
		stdio: ["ignore", fd, fd],
		windowsHide: true,
		env: { ...process.env, DSH_HOME: home }
	});
	child.unref();
	closeSync(fd);
	const log = () => {
		try {
			return readFileSync(logPath, "utf8");
		} catch {
			return "";
		}
	};
	for (let waited = 0; waited < 90000; waited += 500) {
		await sleep(500);
		const output = log();
		const ready = /dsh web: (http:\/\/\S+)/u.exec(output);
		if (ready !== null) {
			const url = ready[1];
			const token = /[?&]token=([^&\s]+)/u.exec(url)?.[1];
			// A row that failed to activate costs one function, not the boot: the ready line alone
			// is not evidence that the plugins loaded, so both are reported.
			const failed = /(\d+) entries? did not activate/u.exec(output);
			const owner = portOwner(port);
			writeFileSync(statePath, `${JSON.stringify({ pid: owner ?? child.pid, wrapper: child.pid, port, profile, url, token, startedAt: new Date().toISOString() }, null, 1)}\n`);
			console.log(`sandbox: ready on port ${String(port)} (pid ${String(owner ?? child.pid)})${failed === null ? ", no row failed to activate" : `, WARNING ${failed[0]}`}`);
			console.log(`sandbox: ${url}`);
			console.log(`sandbox: log ${logPath}`);
			return;
		}
		if (alive(child.pid) === false && waited > 3000) break;
	}
	console.error(`sandbox: it did not come up; last output:\n${log().slice(-2000)}`);
	process.exitCode = 1;
}

switch (command) {
case "up": {
	// A home outside the repository is almost certainly a mistake: the whole point is a local,
	// disposable sandbox, and the one path that must never be written to is the user's real
	// `~/.dsh`, which the running desktop app is using.
	if (!home.startsWith(repo) && !has("allow-foreign-home")) {
		throw new Error(`refusing to use ${home}: it is outside the repository. Pass --allow-foreign-home to mean it.`);
	}
	console.log(`sandbox: home ${home}, profile ${profile}`);
	await ensureProfile();
	if (!has("no-install")) install();
	if (has("restart")) stop();
	const state = readState();
	if (state !== undefined && portOwner(state.port) === state.pid && state.pid !== undefined) {
		console.log(`sandbox: already running on port ${String(state.port)}; use --restart to reload`);
	} else await boot();
	break;
}
	case "url": {
		const state = readState();
		if (state === undefined || !alive(state.pid)) console.log("sandbox: not running");
		else console.log(state.url);
		break;
	}
	case "down":
		stop();
		break;
	default:
		console.log("usage: sandbox.mjs up [--restart] [--port n] [--profile name] [--home dir] [--dsh path] [--no-install] | url | down");
		process.exitCode = 1;
}
