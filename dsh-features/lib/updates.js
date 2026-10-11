/**
 * The update check behind `GET /dsh-features/api/updates`, and the apply behind
 * `POST /dsh-features/api/update`.
 *
 * Where a feature plugin came from is recorded in the profile, not in the plugin:
 * `<profile>/package.json` holds the install spec and `<profile>/pnpm-lock.yaml`
 * the commit pnpm resolved it to. This module reads both, asks every git source
 * for its current HEAD, and reports which packages are behind it.
 *
 * Two measured facts decided the shape of the apply (2026-10-11, pnpm 12.3.4, the
 * official app's runtime):
 *
 *   - `pnpm add <the same spec>` does NOT re-resolve. It prints "Lockfile is up to
 *     date, resolution step is skipped" and the installed commit stays put, so
 *     re-installing through `installBundle` cannot update anything.
 *   - `pnpm update <name>` does re-resolve a git spec, `#path:/<sub>` included, and
 *     moves both the lockfile entry and the installed files.
 *
 * So the apply is `pnpm update <names>`, run through the plugin manager's own pnpm
 * runner, and a restart is what puts the new code to work: plugins have no HMR.
 *
 * @module dsh-features/lib/updates
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long one `git ls-remote` may take before its source counts as unreachable. */
const GIT_TIMEOUT_MS = 20_000;
/** How much pnpm output is handed back to the page. */
const OUTPUT_TAIL = 4000;
/** Commit ids are abbreviated for display. */
const SHORT_COMMIT = 7;

/** `github:owner/repo` (with any `#...` suffix) and nothing else on the spec. */
const GITHUB_SPEC = /^github:([^#\s]+)/u;
/** A remote git address pnpm accepts verbatim. */
const GIT_URL_SPEC = /^(?:https?|ssh):\/\//u;

/** One error message, whatever was thrown. */
function messageOf(error) {
	return String(error?.message ?? error);
}

/** Abbreviate a commit for display; anything unexpected passes through. */
function short(commit) {
	return typeof commit === "string" ? commit.slice(0, SHORT_COMMIT) : undefined;
}

/** Run work that may fail, as a value instead of a throw. */
async function attempt(work) {
	try {
		return { value: await work() };
	} catch (error) {
		return { error: messageOf(error) };
	}
}

/** The commit id inside a lockfile key, when the key carries one. */
function commitIn(key) {
	const found = /(?:tar\.gz\/|#|commit:)([0-9a-f]{7,40})/u.exec(key);
	return found?.[1];
}

/** The resolution fields of one lockfile `resolution:` line. */
function resolutionFields(line) {
	const commit = /commit:\s*([0-9a-f]{7,40})/u.exec(line)?.[1] ?? /tar\.gz\/([0-9a-f]{7,40})/u.exec(line)?.[1];
	const repo = /repo:\s*([^,}]+)/u.exec(line)?.[1]?.trim();
	const path = /path:\s*([^,}]+)/u.exec(line)?.[1]?.trim();
	return { commit, repo, path };
}

/** The package name a lockfile key names, `@scope/name@1.0.0` included. */
function packageNameOf(key) {
	// The second `@` for a scoped name, the first for everything else: an
	// unversioned entry (`dsh-features@https://...`) still splits at its own `@`.
	const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
	if (at <= 0) return undefined;
	return key.slice(0, at);
}

/** Drop undefined fields, so a merge never loses a value already known. */
function defined(object) {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** The spec a profile records for one package, as a name to spec map. */
export function parseManifestDependencies(text) {
	try {
		const parsed = JSON.parse(text);
		const dependencies = parsed?.dependencies;
		if (dependencies === null || typeof dependencies !== "object") return {};
		return Object.fromEntries(Object.entries(dependencies).filter(([, spec]) => typeof spec === "string"));
	} catch {
		return {};
	}
}

/**
 * Every git-resolved package in a pnpm lockfile, by package name.
 *
 * The lockfile is not parsed as YAML: only the two shapes that carry a commit are
 * read. A package entry is a two-space indented `name@spec:` key, and its resolved
 * commit rides either on the key itself (a `codeload` tarball URL, or `#<sha>` for
 * a plain git address) or on the entry's own deeper-indented `resolution:` line.
 * A name that appears in both the `packages` and `snapshots` sections keeps the
 * fields of whichever section supplied them.
 * @param text - `pnpm-lock.yaml` contents.
 * @returns `Map<name, { commit, repo, path }>` for the git entries only.
 */
export function parseLockCommits(text) {
	const found = new Map();
	let current;
	for (const raw of String(text).split(/\r?\n/u)) {
		if (raw.startsWith("    ")) {
			// Four or more spaces: a key of the entry that is already open.
			if (current !== undefined && /^\s*resolution:/u.test(raw)) mergeInto(found, current, resolutionFields(raw));
			continue;
		}
		if (!raw.startsWith("  ") || raw.trim() === "") {
			current = undefined;
			continue;
		}
		const key = raw.slice(2).trim().replace(/^["']|["']$/gu, "");
		if (!key.endsWith(":")) {
			current = undefined;
			continue;
		}
		current = packageNameOf(key.slice(0, -1));
		if (current !== undefined) mergeInto(found, current, { commit: commitIn(key) });
	}
	for (const [name, entry] of found) if (entry.commit === undefined && entry.repo === undefined) found.delete(name);
	return found;
}

/** Merge one lockfile observation into the map, keeping values already known. */
function mergeInto(found, name, patch) {
	found.set(name, { ...defined(patch), ...defined(found.get(name) ?? {}) });
}

/**
 * What one profile dependency is installed from.
 * @param name - package name (the lockfile and manifest key).
 * @param spec - the spec the profile records for it.
 * @param lock - the lockfile entry for it, when it has one.
 * @param profileDir - the directory a relative `file:`/`link:` target resolves against.
 * @returns `{ name, spec, kind, repo?, path?, commit? }`, where `kind` is one of
 *   `git`, `linked` (a junction onto live source), `copy` (a copied local
 *   directory), `registry`, or `unknown`.
 */
export function sourceOf(name, spec, lock, profileDir) {
	const text = String(spec);
	const local = (kind, target) => ({ name, spec: text, kind, path: isAbsolute(target) ? resolve(target) : resolve(profileDir, target) });
	const github = GITHUB_SPEC.exec(text);
	if (github !== null) return { name, spec: text, kind: "git", repo: `https://github.com/${github[1]}.git`, commit: lock?.commit };
	if (text.startsWith("git+")) return { name, spec: text, kind: "git", repo: text.slice(4).split("#")[0], commit: lock?.commit };
	if (GIT_URL_SPEC.test(text)) return { name, spec: text, kind: "git", repo: text.split("#")[0], commit: lock?.commit };
	if (text.startsWith("link:")) return local("linked", text.slice(5));
	if (text.startsWith("file:")) return local("copy", text.slice(5));
	if (isAbsolute(text) || text.startsWith(".")) return local("copy", text);
	return { name, spec: text, kind: "registry" };
}

/**
 * Read every install source the active profile records.
 * @param layout - resolved path layout (see lib/layout.js).
 * @returns `{ sources, error }`: the map by package name, and why an unreadable
 *   profile manifest left it empty.
 */
export async function readSources(layout) {
	let manifest;
	try {
		manifest = await readFile(join(layout.profileDir, "package.json"), "utf8");
	} catch (error) {
		return { sources: new Map(), error: `profile manifest: ${messageOf(error)}` };
	}
	// A profile without a lockfile is one where nothing is pinned yet; every source
	// then reports an unknown commit rather than a failed check.
	const lock = await readFile(join(layout.profileDir, "pnpm-lock.yaml"), "utf8").catch(() => "");
	const commits = parseLockCommits(lock);
	const sources = new Map();
	for (const [name, spec] of Object.entries(parseManifestDependencies(manifest))) {
		sources.set(name, sourceOf(name, spec, commits.get(name), layout.profileDir));
	}
	return { sources, error: undefined };
}

/** The `version` a package.json declares, or undefined when it is not readable. */
async function versionOf(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return typeof parsed?.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/** The current HEAD commit of a git source, through the git the host already has. */
async function gitHead(repo) {
	const { stdout } = await execFileAsync("git", ["ls-remote", repo, "HEAD"], {
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
		// A private source would otherwise wait on a credential prompt until the timeout.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
	});
	const head = /^([0-9a-f]{7,40})\s/u.exec(String(stdout).trim());
	if (head === null) throw new Error("git ls-remote answered no HEAD");
	return head[1];
}

/**
 * Compare every installed feature plugin with the source it came from.
 *
 * One `git ls-remote` per distinct repository, not per package: the packages of a
 * monorepo share a source, so they share one answer. A repository that cannot be
 * reached is reported on each of its packages instead of failing the check.
 *
 * `self` names the hub's own package. It is not a feature and has no row on the
 * page, but it is installed from a source like any other package and the Plugins
 * page has no way to update it, so it is checked here whenever the profile
 * declares it. The page calls that out instead of letting the count exceed the
 * pills with no explanation. `selfVersion` is the version the hub's own manifest
 * declares: a `file:` install has no commit to compare, so the row would read
 * "unknown" forever without it, and with it the copy is correctly current or behind.
 *
 * @param entries - inventory entries (`{ package, version }`), the hub's own list.
 * @param options - `layout`, the hub's own package name and version, and the git
 *   runner to use (injected by tests).
 * @returns `{ checkedAt, packages, updatable, errors }`.
 */
export async function checkUpdates(entries, { layout, self, selfVersion, runGit = gitHead } = {}) {
	const { sources, error } = await readSources(layout);
	const errors = error === undefined ? [] : [error];
	const wanted = (entries ?? []).filter((entry) => typeof entry?.package === "string");
	if (typeof self === "string" && !wanted.some((entry) => entry.package === self)) {
		// A profile that does not install the hub gets no row for it: there would be
		// nothing to compare against, and nothing pnpm could update.
		if (sources.has(self)) wanted.push({ package: self, self: true, ...(typeof selfVersion === "string" ? { version: selfVersion } : {}) });
	}
	const rows = [];
	for (const entry of wanted) {
		const name = entry.package;
		const source = sources.get(name);
		const row = source === undefined
			? { package: name, kind: "unknown" }
			: {
				package: name,
				kind: source.kind,
				spec: source.spec,
				source: source.repo ?? source.path,
				installed: short(source.commit),
				...(entry.self === true ? { self: true } : {})
			};
		rows.push({ row, source, version: entry.version });
	}

	const repos = [...new Set(rows.filter((item) => item.source?.kind === "git").map((item) => item.source.repo))];
	const heads = new Map(await Promise.all(repos.map(async (repo) => [repo, await attempt(() => runGit(repo))])));

	const packages = [];
	for (const { row, source, version } of rows) {
		if (source?.kind === "git") {
			const head = heads.get(source.repo);
			if (head.error !== undefined) {
				row.error = head.error;
				if (!errors.includes(`${source.repo}: ${head.error}`)) errors.push(`${source.repo}: ${head.error}`);
			} else {
				row.remote = short(head.value);
				// An unknown commit on either side is not an update, it is an unknown.
				row.outdated = source.commit === undefined || head.value === undefined ? undefined : source.commit !== head.value;
			}
		} else if (source?.kind === "linked") {
			// A junction onto the source tree is the source: nothing newer exists.
			row.outdated = false;
		} else if (source?.kind === "copy") {
			// A copied local directory can only be compared by what it declares.
			const sourceVersion = await versionOf(join(source.path, "package.json"));
			row.sourceVersion = sourceVersion;
			row.outdated = sourceVersion === undefined || version === undefined ? undefined : sourceVersion !== version;
		}
		packages.push(row);
	}
	return {
		checkedAt: new Date().toISOString(),
		packages,
		updatable: packages.filter((row) => row.outdated === true).map((row) => row.package),
		errors
	};
}

/**
 * Bring packages up to date by re-resolving their install specs.
 *
 * `pnpm update <name>` is what moves a git spec (see the module note), and it is
 * run through the plugin manager's own runner so the profile's package manager
 * settings apply. Where the manager offers its transaction wrapper, the run is
 * taken inside it: that is the profile's file lock, so an update here cannot
 * interleave with an install from the Plugins page, and the profile-change event
 * that page listens for is emitted. The new files are on disk when this returns;
 * a restart is what loads them.
 *
 * @param names - the package names to update.
 * @param options - the `pluginManager` service, if the profile has one.
 * @returns `{ ok, ... }`: the outcome, pnpm's output tail, and whether a restart is required.
 */
export async function applyUpdates(names, { manager } = {}) {
	if (manager === undefined) return { ok: false, reason: "no-plugin-manager" };
	if (typeof manager.runPnpm !== "function") return { ok: false, reason: "no-pnpm-runner" };
	const wanted = [...new Set((names ?? []).filter((name) => typeof name === "string" && name.trim() !== ""))].sort();
	if (wanted.length === 0) return { ok: false, reason: "no-packages" };
	const argv = ["update", ...wanted];
	let output = "";
	/** Run pnpm and turn its failure modes into throws the wrapper understands. */
	const perform = async () => {
		const run = await manager.runPnpm(argv);
		output = String(run?.output ?? "").slice(-OUTPUT_TAIL);
		if (run?.timedOut === true) throw new Error(`pnpm ${argv.join(" ")} timed out`);
		if (run?.exitCode !== 0) throw new Error(output.trim() || `pnpm ${argv.join(" ")} exited with ${String(run?.exitCode)}`);
		return "restart-required";
	};
	if (typeof manager.change !== "function") {
		const outcome = await attempt(perform);
		return outcome.error === undefined
			? { ok: true, packages: wanted, output, restartRequired: true }
			: { ok: false, reason: "pnpm-failed", error: outcome.error, output };
	}
	const result = await manager.change(perform, { stage: "update", target: wanted.join(","), enabled: true }, "install");
	if (result?.application === "failed") return { ok: false, reason: "pnpm-failed", error: messageOf(result.error), output };
	if (result?.application === "cancelled") return { ok: false, reason: "cancelled", output };
	return { ok: true, packages: wanted, output, changed: result?.changed === true, restartRequired: true };
}
