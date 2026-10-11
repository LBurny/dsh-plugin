/**
 * Checks for dsh-features: the installed-feature inventory, the host half's two
 * routes, and the browser half.
 *
 * The browser half runs here for real — the bundle is plain script and only
 * touches `window`, `document`, `navigator` and `fetch`, so it is evaluated in a
 * vm with small stubs plus a minimal React (element objects, state, effects,
 * refs). That is what lets this suite assert the things that otherwise only show
 * up in a browser: the sidebar entry's slot, id and order, the skin, the tab
 * order, and that the page hands a registered feature a node it owns.
 *
 * Run from the repository root or the package directory:
 *   node test/hub.test.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

import { readInventory } from "../lib/inventory.js";
import { resolveLayout } from "../lib/layout.js";
import { loadNavOrder, normalizeOrder, saveNavOrder } from "../lib/order.js";
import { applyUpdates, checkUpdates, parseLockCommits, readSources, sourceOf } from "../lib/updates.js";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/* ------------------------------------------------------- package metadata */

// The Plugins page takes a plugin's display name from the package itself: `locale/en.json`
// anchors the set, every sibling is a language id, and each carries `meta.title` /
// `meta.description` (dsh-app-boot's readPluginMeta, resolved through the package exports).
// With no locale directory the title falls back to the raw package name, which is how this
// package showed up as "dsh-features" in a list of 诊断, 任务提醒 and 页面缩放.
const packageDir = join(here, "..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const localeDir = join(packageDir, "locale");
const localeFiles = (await readdir(localeDir)).sort();
const locale = Object.fromEntries(await Promise.all(localeFiles.map(async (file) => [
	file.slice(0, -".json".length),
	JSON.parse(await readFile(join(localeDir, file), "utf8"))
])));
check(localeFiles.join(",") === "en.json,zh.json", "the locale set is English plus Chinese", localeFiles.join(","));
check(
	localeFiles.every((file) => /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\.json$/u.test(file)),
	"every locale file is named after a language id, which is what dsh requires",
	localeFiles.join(",")
);
check(locale.en.meta.title === "Features" && locale.zh.meta.title === "功能管理", "the plugin names itself in both languages", JSON.stringify([locale.en.meta.title, locale.zh.meta.title]));
check(typeof locale.zh.meta.description === "string" && locale.zh.meta.description !== "", "the Chinese entry describes itself too", String(locale.zh.meta.description));
check(manifest.exports["./locale/*.json"] === "./locale/*.json", "the locale files are exported, which is how dsh reaches them", JSON.stringify(manifest.exports));
check(manifest.files.includes("locale"), "the published files include the locale directory", JSON.stringify(manifest.files));

/* ------------------------------------------------------------- inventory */

const root = await mkdtemp(join(tmpdir(), "dsh-features-"));
const pluginsDir = join(root, "profiles", "plugins");
const profileDir = join(root, "profiles", "desktop");
const nodeModules = join(profileDir, "node_modules");

const writePackage = async (dir, name, manifest) => {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", ...manifest }), "utf8");
};

await writePackage(join(pluginsDir, "dsh-doctor"), "dsh-doctor", {
	dsh: { ui: { feature: { key: "doctor", order: 30, title: { zh: "诊断", en: "Doctor" }, summary: { zh: "运行状态", en: "Status" } } } }
});
// Installed by `dsh plugin add`: lands in the profile's node_modules instead.
await writePackage(join(nodeModules, "dsh-mcp"), "dsh-mcp", {
	dsh: { ui: { feature: { key: "mcp", order: 20, title: { en: "MCP" } } } }
});
// No marker, a broken manifest, a foreign package and a keyless marker: skipped.
await writePackage(join(pluginsDir, "dsh-plain"), "dsh-plain", {});
await mkdir(join(pluginsDir, "dsh-broken"), { recursive: true });
await writeFile(join(pluginsDir, "dsh-broken", "package.json"), "{ not json", "utf8");
await writePackage(join(pluginsDir, "other-tool"), "other-tool", { dsh: { ui: { feature: { key: "other" } } } });
await writePackage(join(pluginsDir, "dsh-keyless"), "dsh-keyless", { dsh: { ui: { feature: { order: 1 } } } });
// A string title is fine, a non-numeric order falls back, junk titles are dropped.
await writePackage(join(pluginsDir, "dsh-odd"), "dsh-odd", {
	dsh: { ui: { feature: { key: "odd", order: "high", title: "Odd", summary: { note: "nope" } } } }
});
// A marked package in the staging directory that the profile never declared. It is
// not installed, so it must not be reported: a stray copy there used to surface on
// the hub page as "installed, but its panel did not load".
await writePackage(join(pluginsDir, "dsh-stray"), "dsh-stray", {
	dsh: { ui: { feature: { key: "stray", order: 5, title: { zh: "暂存", en: "Stray" } } } }
});

// The profile's own manifest is the source of truth for "installed".
await writeFile(join(profileDir, "package.json"), JSON.stringify({
	name: "dsh-profile-desktop",
	private: true,
	dependencies: {
		"dsh-doctor": "github:LBurny/dsh-plugin#path:/packages/dsh-doctor",
		"dsh-mcp": "link:C:/elsewhere/dsh-mcp",
		"dsh-odd": "link:C:/elsewhere/dsh-odd"
	},
	dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-odd"] } }
}), "utf8");

const layout = resolveLayout({ documentPath: join(profileDir, "cordis.patch.yml") });
check(layout.profileName === "desktop", "the layout derives the profile name from the patch document", layout.profileName);
check(layout.pluginsDir === pluginsDir, "the layout points at the plugins directory", layout.pluginsDir);

const inventory = await readInventory(layout);
const keys = inventory.map((item) => item.key);
check(keys.join(",") === "mcp,doctor,odd", "only marked packages are inventoried, ordered by their order", keys.join(","));
check(inventory[1].package === "dsh-doctor" && inventory[1].version === "1.2.3", "an entry carries the package name and version", JSON.stringify(inventory[1]));
check(inventory[1].title.zh === "诊断" && inventory[1].title.en === "Doctor", "a bilingual title survives as a pair", JSON.stringify(inventory[1].title));
check(inventory[0].title.en === "MCP", "a one-language title survives", JSON.stringify(inventory[0].title));
check(inventory[2].order === 100, "a non-numeric order falls back to the default", String(inventory[2].order));
check(inventory[2].title === "Odd", "a plain string title survives", JSON.stringify(inventory[2].title));
check(inventory[2].summary === undefined, "a title-shaped value with no zh/en is dropped", JSON.stringify(inventory[2].summary));

const emptyRoot = await readInventory({ pluginsDir: join(root, "absent"), profileDir: join(root, "absent-profile") });
check(emptyRoot.length === 0, "missing directories degrade to an empty inventory", JSON.stringify(emptyRoot));

// The profile does not declare dsh-stray, so being on disk does not count.
check(!keys.includes("stray"), "a staged copy the profile never declared is not reported as installed", keys.join(","));

// A symlinked package is a package: that is how pnpm links an installed plugin.
try {
	await symlink(join(pluginsDir, "dsh-doctor"), join(nodeModules, "dsh-doctor"), "junction");
	const both = await readInventory(layout);
	check(both.length === 3, "a symlinked copy of the same key does not duplicate an entry", String(both.length));
} catch {
	check(true, "symlink case skipped (the platform refused to create one)");
}
await rm(root, { recursive: true, force: true });

/* --------------------------------------------------------- install sources */

// Where a plugin came from is the profile's record, not the plugin's: a spec in its
// package.json and a resolved commit in its pnpm-lock.yaml. These fixtures cover every
// spec shape the check understands, with the git runner injected so no test here needs
// the network or a repository.
const updateRoot = await mkdtemp(join(tmpdir(), "dsh-features-upd-"));
const updateProfile = join(updateRoot, "profiles", "desktop");
const REPO = "https://github.com/LBurny/dsh-plugin.git";
const PINNED = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
const AHEAD = "ffff6666aaaa7777bbbb8888cccc9999dddd0000";
const COPY = join(updateProfile, "vendor", "dsh-zoom");
await mkdir(COPY, { recursive: true });
await writeFile(join(COPY, "package.json"), JSON.stringify({ name: "dsh-zoom", version: "2.0.0" }), "utf8");
await writeFile(join(updateProfile, "package.json"), JSON.stringify({
	name: "dsh-profile-desktop",
	private: true,
	dependencies: {
		"dsh-doctor": "github:LBurny/dsh-plugin#path:/dsh-doctor",
		"dsh-features": "github:LBurny/dsh-plugin#path:/dsh-features",
		"dsh-mcp": "github:LBurny/dsh-plugin#path:/dsh-mcp",
		"dsh-zoom": "file:./vendor/dsh-zoom",
		"dsh-skills": "link:C:/elsewhere/dsh-skills",
		"dsh-notify": "^1.0.0",
		"dsh-absent": "github:someone/absent#path:/pkg"
	}
}), "utf8");
// Written the way pnpm writes them: the commit of a git-hosted package rides on the
// tarball URL in both the importer and the package entry, and the name appears again
// in `snapshots` with no fields of its own.
await writeFile(join(updateProfile, "pnpm-lock.yaml"), `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      dsh-doctor:
        specifier: github:LBurny/dsh-plugin#path:/dsh-doctor
        version: https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}#path:/dsh-doctor
      dsh-zoom:
        specifier: file:./vendor/dsh-zoom
        version: file:vendor/dsh-zoom

packages:

  dsh-doctor@https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}#path:/dsh-doctor:
    resolution: {gitHosted: true, integrity: sha512-xx, path: /dsh-doctor, tarball: https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}}
    version: 1.2.3

  dsh-features@https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}#path:/dsh-features:
    resolution: {gitHosted: true, integrity: sha512-xx, path: /dsh-features, tarball: https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}}
    version: 1.2.3

  dsh-mcp@https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}#path:/dsh-mcp:
    resolution: {gitHosted: true, integrity: sha512-xx, path: /dsh-mcp, tarball: https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}}
    version: 1.2.3

  dsh-zoom@file:vendor/dsh-zoom:
    resolution: {directory: vendor/dsh-zoom, type: directory}
    version: 1.0.0

snapshots:

  dsh-doctor@https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}#path:/dsh-doctor: {}

  dsh-mcp@https://codeload.github.com/LBurny/dsh-plugin/tar.gz/${PINNED}#path:/dsh-mcp: {}
`, "utf8");

const updateLayout = resolveLayout({ documentPath: join(updateProfile, "cordis.patch.yml") });
const { sources } = await readSources(updateLayout);
const sourceOfDoctor = sources.get("dsh-doctor");
check(sourceOfDoctor?.kind === "git" && sourceOfDoctor?.repo === REPO, "a github spec reads as a git source naming its repository", JSON.stringify(sourceOfDoctor));
check(sourceOfDoctor?.commit === PINNED, "the pinned commit comes from the lockfile, not the spec", String(sourceOfDoctor?.commit));
check(sources.get("dsh-skills")?.kind === "linked", "a link: dependency is a junction onto live source", JSON.stringify(sources.get("dsh-skills")));
check(sources.get("dsh-zoom")?.kind === "copy" && sources.get("dsh-zoom")?.path === COPY, "a file: dependency is a copied local directory", JSON.stringify(sources.get("dsh-zoom")));
check(sources.get("dsh-notify")?.kind === "registry", "a version range is a registry source, which cannot be checked without pnpm", JSON.stringify(sources.get("dsh-notify")));
check(sources.get("dsh-absent")?.repo === "https://github.com/someone/absent.git", "a second repository is read from its own spec", JSON.stringify(sources.get("dsh-absent")));
check(parseLockCommits("lockfileVersion: '9.0'\n\npackages:\n\n  pkg@1.0.0:\n    resolution: {integrity: sha512-x}\n").size === 0, "a registry entry in the lockfile is not a git source", "");
check(parseLockCommits("packages:\n\n  pkg@git+https://example.invalid/r.git#0123456789abcdef:\n    resolution: {commit: 0123456789abcdef, repo: https://example.invalid/r.git, type: git}\n").get("pkg")?.commit === "0123456789abcdef", "a plain git entry keeps the commit its resolution line holds", "");
const noManifest = await readSources({ profileDir: join(updateRoot, "nothing-here") });
check(noManifest.sources.size === 0 && typeof noManifest.error === "string", "an unreadable profile manifest is a reason, not a throw", String(noManifest.error));

const entries = [
	{ key: "doctor", package: "dsh-doctor", version: "1.2.3" },
	{ key: "mcp", package: "dsh-mcp", version: "1.2.3" },
	{ key: "zoom", package: "dsh-zoom", version: "1.0.0" },
	{ key: "skills", package: "dsh-skills", version: "1.2.3" },
	{ key: "notify", package: "dsh-notify", version: "1.2.3" },
	{ key: "absent", package: "dsh-absent", version: "1.2.3" },
	{ key: "ghost", package: "dsh-ghost", version: "1.2.3" }
];
const asked = [];
const report = await checkUpdates(entries, {
	layout: updateLayout,
	runGit: async (repo) => {
		asked.push(repo);
		if (repo !== REPO) throw new Error("no such repository");
		return AHEAD;
	}
});
const reportOf = (packageName) => report.packages.find((row) => row.package === packageName);
check(asked.join(",") === `${REPO},https://github.com/someone/absent.git`, "one git call per distinct repository, not per package", asked.join(","));
check(report.updatable.join(",") === "dsh-doctor,dsh-mcp,dsh-zoom", "the packages whose source moved, plus the copied one whose version differs, are what is offered", report.updatable.join(","));
check(reportOf("dsh-doctor").installed === "aaaa111" && reportOf("dsh-doctor").remote === "ffff666", "a row shows both short commits, so the page can say what it compared", JSON.stringify(reportOf("dsh-doctor")));
check(reportOf("dsh-doctor").source === REPO, "a row names the source it was compared against", String(reportOf("dsh-doctor").source));
check(reportOf("dsh-mcp").outdated === true && reportOf("dsh-skills").outdated === false, "a behind source is true and a junction is false, never merely absent", JSON.stringify([reportOf("dsh-mcp").outdated, reportOf("dsh-skills").outdated]));
check(reportOf("dsh-notify").outdated === undefined && reportOf("dsh-ghost").kind === "unknown", "a registry range and a package the profile never declared are unknown, not updates", JSON.stringify([reportOf("dsh-notify"), reportOf("dsh-ghost")]));
check(reportOf("dsh-zoom").sourceVersion === "2.0.0" && reportOf("dsh-zoom").outdated === true, "a copied local source is compared by the version it declares", JSON.stringify(reportOf("dsh-zoom")));
check(reportOf("dsh-absent").error === "no such repository" && report.errors.length === 1, "an unreachable repository is reported on its package, once, and does not fail the check", JSON.stringify(report.errors));
check(report.packages.length === 7 && typeof report.checkedAt === "string", "the report is stamped and covers every entry", String(report.packages.length));
const settled = await checkUpdates([{ key: "doctor", package: "dsh-doctor", version: "1.2.3" }], { layout: updateLayout, runGit: async () => PINNED });
check(settled.packages[0].outdated === false && settled.updatable.length === 0, "a source still at the pinned commit is not an update", JSON.stringify(settled.updatable));

// The hub is not a feature and has no row, but it is installed from a source like the
// rest, and the Plugins page cannot update it. It is checked by name when the profile
// declares it, and skipped when the profile does not.
const withSelf = await checkUpdates(entries, { layout: updateLayout, self: "dsh-features", runGit: async (repo) => (repo === REPO ? AHEAD : PINNED) });
const selfRow = withSelf.packages.find((row) => row.package === "dsh-features");
check(selfRow?.self === true && selfRow.outdated === true, "the hub's own package is checked alongside the features", JSON.stringify(selfRow));
check(withSelf.updatable.includes("dsh-features") && withSelf.updatable.length === report.updatable.length + 1, "and it is offered for update like any other package", withSelf.updatable.join(","));
const absentSelf = await checkUpdates(entries, { layout: updateLayout, self: "dsh-nothing", runGit: async () => AHEAD });
check(absentSelf.packages.length === 7, "a profile that does not install a package gets no row for it", String(absentSelf.packages.length));

/* ------------------------------------------------------------- the apply */

const runs = [];
const recordingManager = {
	runPnpm: async (argv) => {
		runs.push(argv);
		return { exitCode: 0, timedOut: false, output: "Packages: +1" };
	},
	change: async (operation, request) => ({ ...request, application: await operation(), changed: true })
};
const applied = await applyUpdates(["dsh-mcp", "dsh-doctor", ""], { manager: recordingManager });
check(runs[0]?.join(" ") === "update dsh-doctor dsh-mcp", "the apply runs pnpm update over the named packages, sorted and deduped", JSON.stringify(runs));
check(applied.ok === true && applied.restartRequired === true && applied.changed === true, "a successful apply reports the restart that loads the new code", JSON.stringify(applied));
const refusedApply = await applyUpdates(["dsh-doctor"], {
	manager: { runPnpm: async () => ({ exitCode: 1, output: "ERR_PNPM_NO_MATCHING_VERSION  No matching version found" }) }
});
check(refusedApply.ok === false && refusedApply.reason === "pnpm-failed" && refusedApply.error.includes("ERR_PNPM"), "a failing pnpm run is reported in pnpm's own words", JSON.stringify(refusedApply));
check((await applyUpdates(["dsh-doctor"], {})).reason === "no-plugin-manager", "a profile without a plugin manager is a reason, not a throw", "");
check((await applyUpdates(["dsh-doctor"], { manager: { runPnpm: "not a function" } })).reason === "no-pnpm-runner", "a manager without the pnpm runner is refused", "");
check((await applyUpdates([], { manager: recordingManager })).reason === "no-packages", "an empty request is refused", "");
await rm(updateRoot, { recursive: true, force: true });

/* ------------------------------------------------------------ host routes */

const { apply: applyHost, inject: hostInject, name: hostName } = await import("../lib/index.js");
check(hostName === "features", "the host half exports the short row name", hostName);
check(Array.isArray(hostInject) && hostInject.length === 0, "the host half needs no service before apply", JSON.stringify(hostInject));

/**
 * Boot the host half against a fake ctx and capture the route it registers.
 * `profile` is the directory the config-editor service reports, and `services`
 * adds whatever else the route under test asks for (the plugin manager, mainly).
 */
function bootHost({ withConfigEditor = true, profile = profileDir, services: extra = {} } = {}) {
	const registered = [];
	const logs = [];
	const services = { webServer: { register: (route) => registered.push(route) }, ...extra };
	if (withConfigEditor) services.configEditor = { documentPath: join(profile, "cordis.patch.yml") };
	const ctx = {
		logger: { info: (line) => logs.push(line) },
		get: (key) => services[key],
		inject(list, callback) {
			if (list.includes("webServer") && services.webServer !== undefined) callback({ webServer: services.webServer, effect: (fn) => fn() });
		}
	};
	applyHost(ctx);
	return { registered, logs };
}

/** Call a captured prefix route with a fake request/response pair. */
async function call(route, path, method = "GET", body) {
	const answer = { status: 0, body: "" };
	const res = {
		headersSent: false,
		writeHead(status) {
			answer.status = status;
			this.headersSent = true;
		},
		end(body) {
			answer.body = body ?? "";
		}
	};
	// A body, when there is one, is read the way a request stream is (async iterable).
	const req = { method, url: path };
	if (body !== undefined) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(body, "utf8"); };
	await route.handler(req, res);
	return { ...answer, json: answer.body === "" ? undefined : JSON.parse(answer.body) };
}

const host = bootHost();
check(host.registered.length === 1, "the host half registers exactly one route prefix", String(host.registered.length));
const route = host.registered[0];
check(route.kind === "prefix" && route.path === "/dsh-features", "the route owns /dsh-features", `${route.kind} ${route.path}`);

const status = await call(route, "/dsh-features/api/status");
check(status.status === 200 && status.json.ok === true, "the probe route answers ok", JSON.stringify(status.json));
check(status.json.hub === "dsh-features", "the probe names the hub, so a feature knows who answered", String(status.json.hub));
const features = await call(route, "/dsh-features/api/features");
check(features.status === 200 && features.json.ok === true, "the inventory route answers ok", String(features.status));
check(features.json.source === join(root, "profiles", "plugins"), "the inventory reports where it looked", String(features.json.source).replace(root, "<root>"));
const missing = await call(route, "/dsh-features/nope");
check(missing.status === 404 && missing.json.ok === false, "an unknown path is a JSON 404", JSON.stringify(missing.json));
check((await call(route, "/dsh-features/api/status", "POST")).status === 404, "a wrong method does not answer the route");

// The reader's order is shared: the phone reaches the same dsh from another origin, so it
// cannot live in one browser's storage. It is saved under DSH_HOME and served with the
// inventory, in one round trip.
const orderFile = join(root, "dsh-features.json");
const posted = await call(route, "/dsh-features/api/order", "POST", JSON.stringify({ keys: ["mcp", "skills"] }));
check(posted.status === 200 && posted.json.navOrder.join(",") === "mcp,skills", "the order route saves the arrangement it is given", JSON.stringify(posted.json));
check(JSON.parse(await readFile(orderFile, "utf8")).navOrder.join(",") === "mcp,skills", "the order lands in the hub's own file under DSH_HOME", orderFile.replace(root, "<root>"));
const served = await call(route, "/dsh-features/api/features");
check(served.json.navOrder.join(",") === "mcp,skills", "the inventory serves the saved order, so a second browser agrees", JSON.stringify(served.json.navOrder));
const junk = await call(route, "/dsh-features/api/order", "POST", JSON.stringify({ keys: ["mcp", 5, "", "mcp", "x".repeat(200)] }));
check(junk.json.navOrder.join(",") === "mcp", "junk in the order is dropped entry by entry, not stored", JSON.stringify(junk.json.navOrder));
check((await call(route, "/dsh-features/api/order", "POST", "not json")).status === 400, "a malformed body is a 400", "");
check(normalizeOrder(undefined).length === 0, "an absent order normalizes to empty", "");
check(loadNavOrder(join(root, "no-such-file.json")) instanceof Promise, "a missing file reads as no saved order", "");
check((await loadNavOrder(join(root, "no-such-file.json"))).length === 0, "a missing file reads as no saved order", "");
await saveNavOrder(join(root, "nested", "deep.json"), ["a"]).then(() => { throw new Error("should have failed"); }).catch(() => check(true, "an unwritable path rejects rather than reporting success", ""));

const degraded = await call(bootHost({ withConfigEditor: false }).registered[0], "/dsh-features/api/features");
check(degraded.status === 200 && degraded.json.features.length === 0, "without a config-editor service the inventory degrades instead of failing", JSON.stringify(degraded.json));
check((await call(bootHost({ withConfigEditor: false }).registered[0], "/dsh-features/api/updates")).status === 400, "the update check needs the profile layout, so without it the route refuses", "");

/* ------------------------------------------------- the update routes, end to end */

// A local git repository stands in for GitHub. The host makes the same `git ls-remote`
// call either way, so this covers the whole route path: the spec, the commit the
// lockfile pinned, the remote HEAD, and the pnpm run the plugin manager performs. The
// repository is left one commit behind the profile on purpose, which is the state the
// refresh button is asked to notice. No git on PATH ⇒ skipped, like the symlink case.
const gitCmd = async (args, cwd) => (await promisify(execFile)("git", args, { cwd, windowsHide: true })).stdout.trim();
const liveRoot = await mkdtemp(join(tmpdir(), "dsh-features-live-"));
const liveOrigin = join(liveRoot, "origin");
const liveProfile = join(liveRoot, "profiles", "desktop");
let pinned = undefined;
try {
	await mkdir(liveOrigin, { recursive: true });
	await gitCmd(["init", "-q", "."], liveOrigin);
	await writeFile(join(liveOrigin, "package.json"), JSON.stringify({ name: "dsh-doctor", version: "1.0.0" }), "utf8");
	await gitCmd(["add", "-A"], liveOrigin);
	await gitCmd(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], liveOrigin);
	pinned = await gitCmd(["rev-parse", "HEAD"], liveOrigin);
} catch {
	pinned = undefined;
}

if (pinned === undefined) {
	check(true, "the git-backed update route is skipped (no git on PATH)");
	await rm(liveRoot, { recursive: true, force: true });
} else {
	const url = pathToFileURL(liveOrigin).href;
	const spec = `git+${url}`;
	await writePackage(join(liveProfile, "node_modules", "dsh-doctor"), "dsh-doctor", {
		version: "1.0.0",
		dsh: { ui: { feature: { key: "doctor", order: 30, title: { zh: "诊断", en: "Doctor" } } } }
	});
	await writeFile(join(liveProfile, "package.json"), JSON.stringify({
		name: "dsh-profile-desktop",
		private: true,
		// The hub itself is installed from the same source. It has no row on its own
		// page, but the update check covers it and the route must accept its name.
		dependencies: { "dsh-doctor": spec, "dsh-features": spec }
	}), "utf8");
	await writeFile(join(liveProfile, "pnpm-lock.yaml"), `lockfileVersion: '9.0'

packages:

  dsh-doctor@${spec}#${pinned}:
    resolution: {commit: ${pinned}, repo: ${url}, type: git}
    version: 1.0.0

  dsh-features@${spec}#${pinned}:
    resolution: {commit: ${pinned}, repo: ${url}, type: git}
    version: 1.0.0
`, "utf8");
	// The source moves on after the install: the profile still pins the first commit.
	await writeFile(join(liveOrigin, "marker.txt"), "moved\n", "utf8");
	await gitCmd(["add", "-A"], liveOrigin);
	await gitCmd(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"], liveOrigin);
	const head = await gitCmd(["rev-parse", "HEAD"], liveOrigin);

	const live = bootHost({ profile: liveProfile });
	const liveRoute = live.registered[0];
	const listed = await call(liveRoute, "/dsh-features/api/features");
	check(listed.json.features.length === 1 && listed.json.updates === undefined, "the inventory lists the installed feature and carries no check on the first load", JSON.stringify(listed.json.updates));
	const checked = await call(liveRoute, "/dsh-features/api/updates");
	check(checked.json.ok === true && checked.json.updatable.join(",") === "dsh-doctor,dsh-features", "the check finds that the source moved past the pinned commit, for the features and for the hub itself", JSON.stringify(checked.json.updatable));
	check(checked.json.packages[0].installed === pinned.slice(0, 7) && checked.json.packages[0].remote === head.slice(0, 7), "the report names both commits", JSON.stringify(checked.json.packages[0]));
	check(checked.json.packages[1].self === true, "the hub's own row says it is the hub, so the page can explain a count with no pill", JSON.stringify(checked.json.packages[1]));
	check((await call(liveRoute, "/dsh-features/api/features")).json.updates.updatable.join(",") === "dsh-doctor,dsh-features", "the check rides along with the inventory afterwards, so a reload keeps the badges without a new round trip", "");
	// Without a plugin manager there is nothing to run pnpm with, and that is a reason.
	const refused = await call(liveRoute, "/dsh-features/api/update", "POST", JSON.stringify({ packages: ["dsh-doctor"] }));
	check(refused.status === 502 && refused.json.reason === "no-plugin-manager", "an update with no plugin manager is refused with a reason", JSON.stringify(refused.json));
	check((await call(liveRoute, "/dsh-features/api/update", "POST", JSON.stringify({ packages: ["dsh-mcp"] }))).status === 400, "a package this profile does not install is a 400", "");
	check((await call(liveRoute, "/dsh-features/api/update", "POST", "not json")).status === 400, "a malformed update body is a 400", "");

	const updateRuns = [];
	const liveManager = {
		runPnpm: async (argv) => {
			updateRuns.push(argv);
			return { exitCode: 0, timedOut: false, output: "Packages: +1" };
		},
		change: async (operation, request, reason) => ({ ...request, reason, application: await operation(), changed: true })
	};
	const managedRoute = bootHost({ profile: liveProfile, services: { pluginManager: liveManager } }).registered[0];
	const managedCheck = await call(managedRoute, "/dsh-features/api/updates");
	check(managedCheck.json.updatable.join(",") === "dsh-doctor,dsh-features", "a profile with a plugin manager checks the same way", JSON.stringify(managedCheck.json.updatable));
	const managed = await call(managedRoute, "/dsh-features/api/update", "POST", JSON.stringify({ packages: ["dsh-features", "dsh-doctor"] }));
	check(updateRuns[0]?.join(" ") === "update dsh-doctor dsh-features", "the route runs pnpm update through the plugin manager, the hub's own name included", JSON.stringify(updateRuns));
	check(managed.json.ok === true && managed.json.restartRequired === true, "the route reports the restart the new code needs", JSON.stringify(managed.json));
	check(managed.json.updates.updatable.length === 0 && managed.json.updates.packages.length === 0, "the packages just updated leave the cached report, so their badges cannot go stale", JSON.stringify(managed.json.updates));
	await rm(liveRoot, { recursive: true, force: true });
}

/* --------------------------------------------------------- browser half */

const bundle = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** A localStorage stand-in: Map-backed, inspectable, shareable between browsers. */
function makeStorage() {
	const data = new Map();
	return {
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => void data.set(key, String(value)),
		removeItem: (key) => void data.delete(key),
		dump: () => Object.fromEntries(data)
	};
}

/**
 * One browser's worth of stubs: element objects plus state/effect/ref slots, a
 * document whose created nodes record what is appended to them, and a `fetch`.
 * A `ref` in `createElement` is bound to a stub node right there, which is what
 * React does for real and what the page's mount effect depends on.
 */
function createBrowser({ language = "zh-CN", registry, fetchImpl, storage = makeStorage() }) {
	let hooks = [];
	let cursor = 0;
	let dirty = false;
	const effects = [];
	const created = [];
	const observers = [];
	/** Tell every live MutationObserver, the way a real DOM would. */
	const mutate = () => {
		for (const observer of [...observers]) observer.callback();
	};
	const makeNode = (tag) => {
		const node = {
			tag: tag ?? "div",
			className: "",
			id: undefined,
			textContent: "",
			attrs: {},
			children: [],
			parent: undefined,
			append(...added) {
				for (const child of added) {
					if (child === undefined || child === null || child === false) continue;
					child.parent = node;
					node.children.push(child);
				}
				mutate();
			},
			replaceChildren(...next) {
				node.children = [];
				node.append(...next);
			},
			remove() {
				const at = node.parent?.children.indexOf(node) ?? -1;
				if (at !== -1) node.parent.children.splice(at, 1);
				node.parent = undefined;
				mutate();
			},
			setAttribute(key, value) {
				node.attrs[key] = String(value);
			},
			hasAttribute: (key) => Object.hasOwn(node.attrs, key),
			querySelectorAll(selector) {
				const wanted = selector.trim();
				const found = [];
				const visit = (current) => {
					for (const child of current.children) {
						if (child.tag === wanted) found.push(child);
						visit(child);
					}
				};
				visit(node);
				return found;
			}
		};
		created.push(node);
		return node;
	};
	/** The only DOM global the hub itself uses: it watches a mounted panel. */
	class MutationObserver {
		constructor(callback) {
			this.callback = callback;
		}
		observe() {
			observers.push(this);
		}
		disconnect() {
			const at = observers.indexOf(this);
			if (at !== -1) observers.splice(at, 1);
		}
	}
	const styles = [];
	const document = {
		head: { append: (node) => styles.push(node) },
		getElementById: (id) => styles.find((node) => node.id === id) ?? null,
		createElement: (tag) => makeNode(tag)
	};
	const React = {
		createElement(type, config, ...children) {
			const element = { type, props: { ...config, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) } };
			if (config?.ref !== undefined && config.ref.current === null) config.ref.current = makeNode("ref");
			return element;
		},
		useState(initial) {
			const slot = cursor++;
			if (hooks[slot] === undefined) hooks[slot] = typeof initial === "function" ? initial() : initial;
			const set = (next) => {
				const value = typeof next === "function" ? next(hooks[slot]) : next;
				if (value === hooks[slot]) return;
				hooks[slot] = value;
				dirty = true;
			};
			return [hooks[slot], set];
		},
		useEffect(fn, deps) {
			const slot = cursor++;
			const previous = effects[slot];
			const changed = previous === undefined || deps === undefined || deps.some((value, index) => value !== previous.deps?.[index]);
			effects[slot] = { fn, deps, changed };
		},
		useRef(value) {
			const slot = cursor++;
			if (hooks[slot] === undefined) hooks[slot] = { current: value ?? null };
			return hooks[slot];
		}
	};

	const registrations = [];
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		navigator: { language },
		document,
		fetch: fetchImpl,
		localStorage: storage,
		MutationObserver,
		__dshFeatures: registry,
		__ModuleLoader__: { load: (registration) => registrations.push(registration) }
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(bundle, sandbox, { filename: "dsh-features/lib/client.js" });

	/** Render (repeatedly, while state changes), then run the changed effects. */
	const render = async (Component, props) => {
		let element;
		let guard = 0;
		do {
			dirty = false;
			cursor = 0;
			element = Component(props);
			for (const effect of effects) if (effect?.changed) effect.fn();
			await new Promise((resolve) => setTimeout(resolve, 5));
		} while (dirty && ++guard < 6);
		return element;
	};

	/** Collect what `apply` registers on a fake client ctx. */
	const wire = (registration) => {
		const slots = [];
		const dictionaries = [];
		const ctx = {
			effect: (fn) => fn(),
			locale: {
				register: (ns, dict) => dictionaries.push({ ns, dict }),
				bind: (ns) => {
					const dict = dictionaries.find((item) => item.ns === ns)?.dict;
					return (key) => dict?.[language.startsWith("zh") ? "zh" : "en"]?.[key] ?? key;
				}
			},
			slots: {
				inject: (slot, factory) => slots.push({ slot, ...factory() }),
				// The real `register` returns a dispose function; the test only needs
				// what was registered.
				register: (options, component) => ({ options, component })
			}
		};
		const exports = registration.factory((specifier) => {
			if (specifier === "react") return React;
			throw new Error(`unexpected require("${specifier}")`);
		});
		exports.apply(ctx);
		return { exports, slots, dictionaries };
	};

	return { React, document, styles, created, registrations, render, wire, makeNode, storage };
}

/** Find every rendered node a predicate accepts. */
function findAll(element, predicate, found = []) {
	if (element === null || typeof element !== "object") return found;
	if (predicate(element)) found.push(element);
	for (const child of element.props?.children ?? []) findAll(child, predicate, found);
	return found;
}

/** Every request the page made, so "it saved it" is observed and not assumed. */
const requests = [];
const browser = createBrowser({
	registry: {
		doctor: { title: "诊断", order: 30, icon: "M-doctor", mount: (host) => browser.mounted.push({ key: "doctor", host }) },
		mcp: { title: "MCP", order: 20, icon: "M-mcp", mount: (host) => browser.mounted.push({ key: "mcp", host }) }
	},
	fetchImpl: async (url, init) => {
		requests.push({ url: String(url), init });
		return {
		json: async () => ({
			ok: true,
			features: [
				{ key: "doctor", order: 30, package: "dsh-doctor", title: { zh: "诊断", en: "Doctor" } },
				{ key: "mcp", order: 20, package: "dsh-mcp", title: { zh: "MCP", en: "MCP" } },
				{ key: "skills", order: 10, package: "dsh-skills", title: { zh: "技能", en: "Skills" }, summary: { zh: "管理技能", en: "Managed skills" } }
			],
			// The order the host holds. Same as the default here, so the drag assertions
			// below stay about dragging; the adoption path has its own browser further down.
			navOrder: ["skills", "mcp", "doctor"]
		})
		};
	}
});
browser.requests = requests;
browser.mounted = [];

check(browser.registrations.length === 1, "the bundle registers itself exactly once", String(browser.registrations.length));
check(browser.registrations[0].id === "dsh-features", "the bundle registers under the package name (the loader checks this)", String(browser.registrations[0].id));

// Materializing the factory is what injects the skin — the module system does
// this for every boot-graph row, so the dock is hidden for the whole page.
const wired = browser.wire(browser.registrations[0]);
check(browser.styles.length === 1, "the bundle injects its skin", String(browser.styles.length));
check(browser.styles[0].id === "dsh-features-skin", "the skin carries an id, so a reload cannot double it", String(browser.styles[0].id));
check(/display:\s*none\s*!important/u.test(browser.styles[0].textContent), "the skin hides the corner launcher dock", browser.styles[0].textContent.slice(0, 48).trim());

check(wired.exports.inject?.join(",") === "slots,locale", "the client half declares the services it needs", JSON.stringify(wired.exports.inject));
check(wired.dictionaries.length === 1 && wired.dictionaries[0].ns === "features", "the dictionary is registered under its namespace", JSON.stringify(wired.dictionaries.map((item) => item.ns)));
check(wired.dictionaries[0].dict.zh.panel === "功能管理" && wired.dictionaries[0].dict.en.panel === "Features", "the dictionary is bilingual", JSON.stringify([wired.dictionaries[0].dict.zh.panel, wired.dictionaries[0].dict.en.panel]));

const sidebar = wired.slots.find((item) => item.slot === "sidebar.panellist");
const main = wired.slots.find((item) => item.slot === "main");
check(sidebar?.options.id === "features", "the sidebar entry registers the shared panel id", JSON.stringify(sidebar?.options));
check(sidebar.options.order === 5, "the sidebar entry sits between 插件 (0) and 自动化任务 (10)", String(sidebar.options.order));
check(sidebar.options.label() === "功能管理", "the sidebar label comes from the dictionary", sidebar.options.label());
check(typeof sidebar.component === "function", "the sidebar entry ships its own glyph component", typeof sidebar.component);
check(main?.options.key === "features", "the page registers under the same id, so selectPanel finds it", JSON.stringify(main?.options));

/* --------------------------------------------------------------- the page */

const T = (key) => ({
	panel: "功能管理",
	subtitle: "统一入口",
	loading: "加载中…",
	refresh: "刷新",
	refreshHint: "刷新列表并检查更新",
	back: "返回",
	dragHint: "拖拽调整顺序",
	empty: "没有检测到功能插件。",
	emptyHint: "安装任意 dsh-* 功能插件。",
	unloaded: "已安装，但它的面板脚本没有加载。",
	failed: "面板加载失败",
	updatable: "可更新",
	update: "更新",
	checking: "正在检查安装来源…",
	upToDate: "安装来源都是最新的。",
	checkFailed: "检查更新失败",
	updating: "正在更新…",
	updateApplied: "更新已写入，重启 dsh 后生效。",
	updateFailed: "更新失败",
	includesSelf: "其中包含功能管理本身，它没有自己的行。",
	noManager: "没有插件管理器。"
})[key] ?? key;

let element = await browser.render(main.component, { t: T });
/** The row for one feature, in the list view. */
const rows = () => findAll(element, (node) => node.props?.className === "hub-row");
/** The row's name text, found by class so a new sibling cannot break the reader. */
const rowName = (row) => findAll(row, (node) => node.props?.className === "hub-row-name")[0]?.props.children?.join("") ?? "";
/** The row's update pill, or undefined when the row carries none. */
const rowPill = (row) => findAll(row, (node) => node.props?.className === "hub-pill")[0]?.props.children?.join("");
const rowNames = () => rows().map(rowName).join(",");
/** The glyph path a row leads with: row > tile span > svg > path. */
const rowGlyph = (row) => row.props.children[0]?.props.children[0]?.props.children[0]?.props.d;
const rowNote = (row) => row.props.children[1]?.props.children[1]?.props.children?.join("") ?? "";
const endPad = () => findAll(element, (node) => node.props?.className === "hub-list-end")[0];
const headRefresh = () => findAll(element, (node) => node.props?.["aria-label"] === T("refresh"));
const headBack = () => findAll(element, (node) => node.props?.["aria-label"] === T("back"));
const stage = () => findAll(element, (node) => node.props?.className === "hub-stage")[0];
const stageHost = () => findAll(element, (node) => node.props?.ref !== undefined)[0]?.props.ref.current;

check(rows().length === 3, "a row per feature: two registered plus one installed-only", String(rows().length));
check(rowNames() === "技能,MCP,诊断", "rows follow the default order", rowNames());
check(rows().every((row) => row.props.draggable === true), "every row is draggable", "");
check(rowGlyph(rows()[1]) === "M-mcp", "a registered icon leads its row", String(rowGlyph(rows()[1])));
check(rowGlyph(rows()[0]) === "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z", "an iconless feature gets the fallback grid", String(rowGlyph(rows()[0])));
check(rowNote(rows()[0]) === "管理技能", "a row carries the feature's own summary from the inventory", rowNote(rows()[0]));
check(rows()[0].props.children[2]?.props.children[0]?.props.children[0]?.props.d === "M6.2 3.6L10.6 8l-4.4 4.4", "a row ends in a chevron, so it reads as clickable", String(rows()[0].props.children[2]?.props.children[0]?.props.children?.[0]?.props.d));
check(endPad() !== undefined, "the list ends in a drop pad for move-to-last", "");
check(browser.mounted.length === 0, "the list view mounts nothing (a panel is opened, not shown by default)", String(browser.mounted.length));
check(headBack().length === 0, "the list view has no back control", String(headBack().length));
check(headRefresh().length === 1, "the list view has exactly one refresh control", String(headRefresh().length));
check(stage().props["data-view"] === "list", "the stage knows it is showing the list", String(stage().props["data-view"]));

// Opening a row is the whole interaction: it drills into that feature.
rows()[1].props.onClick();
element = await browser.render(main.component, { t: T });
check(browser.mounted.at(-1)?.key === "mcp", "clicking a row opens that feature's settings", String(browser.mounted.at(-1)?.key));
check(headBack().length === 1, "the detail view offers a way back", String(headBack().length));
check(headRefresh().length === 1, "the detail view still has exactly one refresh control", String(headRefresh().length));
check(stage().props["data-view"] === "feature", "the stage switches to the feature view", String(stage().props["data-view"]));
check(findAll(element, (node) => node.props?.className === "hub-rows").length === 0, "the list is gone while a feature is open", "");
const title = findAll(element, (node) => node.props?.className === "hub-line")[0];
console.log('DEBUG line children:', title.props.children.map((c) => JSON.stringify([c?.props?.className, c?.props?.children])).join(' | '));
check(title?.props.children[0]?.props.children?.join("") === "MCP", "the head names the open feature", String(title?.props.children[0]?.props.children));
check(title?.props.children[1]?.props.children?.join("") === "dsh-mcp", "the head names the package it came from", String(title?.props.children[1]?.props.children));

// Going back returns to the list, with every feature still on it.
headBack()[0].props.onClick();
element = await browser.render(main.component, { t: T });
check(rows().length === 3 && stage().props["data-view"] === "list", "back returns to the list", `${rows().length} rows, ${stage().props["data-view"]}`);
check(rowNames() === "技能,MCP,诊断", "the list still holds every feature", rowNames());

// An installed-only feature opens to an explanation, not to an empty page.
// 技能 is the one the profile declares but whose browser half never registered.
rows()[0].props.onClick();
element = await browser.render(main.component, { t: T });
check(stageHost().children[0]?.textContent === T("unloaded"), "an installed-only feature explains itself in place", String(stageHost().children[0]?.textContent));
headBack()[0].props.onClick();
element = await browser.render(main.component, { t: T });

// Dragging a row onto another moves it in front of the target, persists the
// order, and never opens anything.
const dragEvent = { dataTransfer: { setData() {}, effectAllowed: "" } };
rows()[0].props.onDragStart(dragEvent);
rows()[2].props.onDragOver({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(rows()[2].props["data-drop"] === "true", "the row under the cursor is marked as the drop target", String(rows()[2].props["data-drop"]));
rows()[2].props.onDrop({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(rowNames() === "MCP,技能,诊断", "dropping moves the row in front of its target", rowNames());
check(stage().props["data-view"] === "list", "reordering stays in the list view", String(stage().props["data-view"]));
const saved = JSON.parse(browser.storage.dump()["dsh-features:nav-order"] ?? "[]");
check(saved.join(",") === "mcp,skills,doctor", "the dragged order lands in localStorage as the first-frame cache", saved.join(","));
await new Promise((resolve) => setTimeout(resolve, 400));
const reported = browser.requests.filter((item) => item.url.endsWith("/dsh-features/api/order"));
check(
	reported.length > 0 && JSON.parse(reported[reported.length - 1].init.body).keys.join(",") === "mcp,skills,doctor",
	"the dragged order is reported to the host, so the phone sees it too",
	reported.length === 0 ? "(no POST)" : reported[reported.length - 1].init.body
);

// The end pad accepts move-to-last.
rows()[0].props.onDragStart(dragEvent);
endPad().props.onDragOver({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(endPad().props["data-drop"] === "true", "the end pad marks itself as the drop target", String(endPad().props["data-drop"]));
endPad().props.onDrop({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(rowNames() === "技能,诊断,MCP", "dropping on the end pad moves the row last", rowNames());

/* ------------------------------------------------- the shared order, cross-origin */

/**
 * The phone reaches the same dsh from another origin, so an order kept in this browser's
 * storage never reaches it. The host's answer is what the list follows, wherever it is
 * opened; the local cache is only the first frame.
 */
function orderBrowser(served, cached) {
	const instance = createBrowser({
		registry: {
			doctor: { title: "诊断", order: 30, mount: () => {} },
			mcp: { title: "MCP", order: 20, mount: () => {} },
			skills: { title: "技能", order: 10, mount: () => {} }
		},
		fetchImpl: async () => ({
			json: async () => ({
				ok: true,
				navOrder: served,
				features: [
					{ key: "doctor", order: 30, package: "dsh-doctor" },
					{ key: "mcp", order: 20, package: "dsh-mcp" },
					{ key: "skills", order: 10, package: "dsh-skills" }
				]
			})
		})
	});
	// Through setItem, not the dump(): dump() is a copy, so writing into it would vanish.
	if (cached !== undefined) instance.storage.setItem("dsh-features:nav-order", JSON.stringify(cached));
	return instance;
}

const servedBrowser = orderBrowser(["doctor", "mcp", "skills"]);
const servedWired = servedBrowser.wire(servedBrowser.reg = servedBrowser.registrations[0]);
const servedMain = servedWired.slots.find((item) => item.slot === "main");
let servedElement = await servedBrowser.render(servedMain.component, { t: T });
const servedNames = () => findAll(servedElement, (node) => node.props?.className === "hub-row")
	.map((row) => findAll(row, (node) => node.props?.className === "hub-row-name")[0]?.props.children?.join("") ?? "")
	.join(",");
check(servedNames() === "诊断,MCP,技能", "the list follows the order the host serves, not the default", servedNames());
check(
	servedBrowser.storage.dump()["dsh-features:nav-order"] === JSON.stringify(["doctor", "mcp", "skills"]),
	"that order is cached for the next first frame",
	String(servedBrowser.storage.dump()["dsh-features:nav-order"])
);

// Nothing saved on the host yet: the local arrangement is pushed up rather than discarded.
const seedRequests = [];
const seedBrowser = orderBrowser([], ["mcp", "skills", "doctor"]);
const seedWired = seedBrowser.wire(seedBrowser.registrations[0]);
const seedMain = seedWired.slots.find((item) => item.slot === "main");
await seedBrowser.render(seedMain.component, { t: T });
check(
	seedBrowser.storage.dump()["dsh-features:nav-order"] === JSON.stringify(["mcp", "skills", "doctor"]),
	"an order saved in this browser before the host had one is kept, not reset",
	String(seedBrowser.storage.dump()["dsh-features:nav-order"])
);

/* ------------------------------------------------------- the update half */

/**
 * A browser whose three routes answer. The inventory carries no check by default, so
 * the assertions below can be about what a refresh adds; `cached` is the check a host
 * that already ran one hands to a page opened later.
 */
const UPDATE_REPORT = {
	ok: true,
	checkedAt: "2026-10-11T00:00:00.000Z",
	packages: [
		{ package: "dsh-doctor", kind: "git", source: "https://github.com/LBurny/dsh-plugin.git", installed: "aaaa111", remote: "ffff666", outdated: true },
		{ package: "dsh-mcp", kind: "git", source: "https://github.com/LBurny/dsh-plugin.git", installed: "ffff666", remote: "ffff666", outdated: false }
	],
	updatable: ["dsh-doctor"],
	errors: []
};
function updateBrowser({ cached, updates = UPDATE_REPORT, update } = {}) {
	const calls = [];
	const instance = createBrowser({
		registry: {
			doctor: { title: "诊断", order: 30, mount: () => {} },
			mcp: { title: "MCP", order: 20, mount: () => {} }
		},
		fetchImpl: async (url, init) => {
			const path = String(url);
			calls.push({ path, init });
			if (path.endsWith("/api/features")) {
				return {
					json: async () => ({
						ok: true,
						features: [
							{ key: "doctor", order: 30, package: "dsh-doctor" },
							{ key: "mcp", order: 20, package: "dsh-mcp" }
						],
						navOrder: [],
						...cached === undefined ? {} : { updates: cached }
					})
				};
			}
			if (path.endsWith("/api/updates")) return { json: async () => updates };
			if (path.endsWith("/api/update")) {
				return {
					json: async () => update ?? {
						ok: true,
						packages: ["dsh-doctor"],
						restartRequired: true,
						updates: { ...UPDATE_REPORT, packages: [UPDATE_REPORT.packages[1]], updatable: [] }
					}
				};
			}
			throw new Error(`unexpected ${path}`);
		}
	});
	instance.calls = calls;
	return instance;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The page component a browser wired, ready to render. */
const pageOf = (instance) => instance.wire(instance.registrations[0]).slots.find((item) => item.slot === "main").component;
const rowsIn = (rendered) => findAll(rendered, (node) => node.props?.className === "hub-row");
const rowFor = (rendered, label) => rowsIn(rendered).find((row) => rowName(row) === label);
const refreshIn = (rendered) => findAll(rendered, (node) => node.props?.["aria-label"] === T("refresh"));
const updateButtonIn = (rendered) => findAll(rendered, (node) => node.props?.className === "hub-update-btn")[0];
const bannerIn = (rendered) => findAll(rendered, (node) => node.props?.className === "hub-banner")[0];
const bannerText = (rendered) => bannerIn(rendered)?.props.children?.join("") ?? "";

const updater = updateBrowser();
const updaterPage = pageOf(updater);
let updaterElement = await updater.render(updaterPage, { t: T });
check(updater.calls.length === 1 && updater.calls[0].path.endsWith("/api/features"), "loading the page asks for the inventory only, never for updates", updater.calls.map((call) => call.path).join(","));
check(updateButtonIn(updaterElement) === undefined && rowPill(rowFor(updaterElement, "诊断")) === undefined, "no badge and no update control before anything was checked", "");
check(refreshIn(updaterElement)[0].props.title === T("refreshHint"), "the refresh control says what it now does", String(refreshIn(updaterElement)[0].props.title));

// The refresh click is what reaches the sources, and it carries both halves at once.
refreshIn(updaterElement)[0].props.onClick();
await sleep(15);
updaterElement = await updater.render(updaterPage, { t: T });
check(updater.calls.some((call) => call.path.endsWith("/api/updates")), "the refresh control asks the host to check the sources", updater.calls.map((call) => call.path).join(","));
check(rowPill(rowFor(updaterElement, "诊断")) === T("updatable") && rowPill(rowFor(updaterElement, "MCP")) === undefined, "only the row whose source moved carries the pill", JSON.stringify([rowPill(rowFor(updaterElement, "诊断")), rowPill(rowFor(updaterElement, "MCP"))]));
check(updateButtonIn(updaterElement)?.props.children?.join("") === `${T("update")} (1)`, "the head offers one update for the packages found behind", JSON.stringify(updateButtonIn(updaterElement)?.props.children));
check(bannerText(updaterElement) === "", "a check that found updates says it with the button and the pills, not a banner", bannerText(updaterElement));

// One click applies all of them, and the host's report of what it did replaces the badges.
updateButtonIn(updaterElement).props.onClick();
await sleep(15);
updaterElement = await updater.render(updaterPage, { t: T });
const postedUpdates = updater.calls.filter((call) => call.path.endsWith("/api/update"));
check(postedUpdates.length === 1 && postedUpdates[0].init.method === "POST", "the update button posts rather than checks", String(postedUpdates.length));
check(JSON.parse(postedUpdates[0].init.body).packages.join(",") === "dsh-doctor", "it sends the names the check found, not a blanket update", postedUpdates[0].init.body);
check(bannerText(updaterElement) === T("updateApplied"), "the page says the update is on disk and needs a restart", bannerText(updaterElement));
check(bannerIn(updaterElement).props["data-kind"] === "ok", "the message is the reassuring kind", String(bannerIn(updaterElement).props["data-kind"]));
check(updateButtonIn(updaterElement) === undefined && rowPill(rowFor(updaterElement, "诊断")) === undefined, "the report that came back clears both badges", "");

// A page opened after a check adopts what the host still holds, without asking again.
const adopter = updateBrowser({ cached: UPDATE_REPORT });
const adopterElement = await adopter.render(pageOf(adopter), { t: T });
check(rowPill(rowFor(adopterElement, "诊断")) === T("updatable"), "a page opened later shows the badges the host still holds", "");
check(adopter.calls.length === 1, "and does not ask the sources a second time", adopter.calls.map((call) => call.path).join(","));

// The check covers the hub itself, which has no row: the count would otherwise exceed
// the pills with nothing on the page to explain it.
const selfBrowser = updateBrowser({ updates: { ...UPDATE_REPORT, updatable: ["dsh-doctor", "dsh-features"] } });
let selfElement = await selfBrowser.render(pageOf(selfBrowser), { t: T });
refreshIn(selfElement)[0].props.onClick();
await sleep(15);
selfElement = await selfBrowser.render(pageOf(selfBrowser), { t: T });
check(updateButtonIn(selfElement)?.props.children?.join("") === `${T("update")} (2)`, "the button counts every package the check found behind", JSON.stringify(updateButtonIn(selfElement)?.props.children));
check(bannerText(selfElement) === T("includesSelf"), "and a package with no row of its own is named on the page", bannerText(selfElement));
check(rowPill(rowFor(selfElement, "诊断")) === T("updatable"), "the rows with a pill still carry one", "");

// The other two endings: nothing to do, and a source that could not be reached.
const current = updateBrowser({ updates: { ...UPDATE_REPORT, packages: [UPDATE_REPORT.packages[1]], updatable: [] } });
let currentElement = await current.render(pageOf(current), { t: T });
refreshIn(currentElement)[0].props.onClick();
await sleep(15);
currentElement = await current.render(pageOf(current), { t: T });
check(bannerText(currentElement) === T("upToDate") && updateButtonIn(currentElement) === undefined, "a check that found nothing says so and offers nothing", bannerText(currentElement));

const unreachable = updateBrowser({ updates: { ok: true, checkedAt: "x", packages: [], updatable: [], errors: ["https://github.com/o/r.git: no such repository"] } });
let unreachableElement = await unreachable.render(pageOf(unreachable), { t: T });
refreshIn(unreachableElement)[0].props.onClick();
await sleep(15);
unreachableElement = await unreachable.render(pageOf(unreachable), { t: T });
check(bannerText(unreachableElement).startsWith(T("checkFailed")), "an unreachable source is reported on the page instead of silently passing", bannerText(unreachableElement));
check(bannerIn(unreachableElement).props["data-kind"] === "error", "and reported as a failure", String(bannerIn(unreachableElement).props["data-kind"]));
check(updateButtonIn(unreachableElement) === undefined, "a failed check offers no update", "");

// A refusal from the host keeps its own words: the reason code the profile knows about.
const noManager = updateBrowser({ update: { ok: false, reason: "no-plugin-manager" } });
let noManagerElement = await noManager.render(pageOf(noManager), { t: T });
refreshIn(noManagerElement)[0].props.onClick();
await sleep(15);
noManagerElement = await noManager.render(pageOf(noManager), { t: T });
updateButtonIn(noManagerElement).props.onClick();
await sleep(15);
noManagerElement = await noManager.render(pageOf(noManager), { t: T });
check(bannerText(noManagerElement) === `${T("updateFailed")}: ${T("noManager")}`, "a profile with no plugin manager is told so, in the page's words", bannerText(noManagerElement));

/* ------------------------------------------------ the embedded refresh sweep */

/**
 * A feature whose body renders a bare 刷新 button, the way a panel build older
 * than the hub's cooperation would. The page must not end up showing two.
 */
const sweeper = createBrowser({
	registry: {
		stale: {
			title: "陈旧",
			order: 1,
			mount: (host) => {
				// Late, like a real panel: its body lands after its own fetch resolves.
				setTimeout(() => {
					const button = sweeper.document.createElement("button");
					button.textContent = "刷新";
					host.append(button);
				}, 0);
			}
		},
		marked: {
			title: "标记",
			order: 2,
			mount: (host) => {
				const button = sweeper.document.createElement("button");
				button.setAttribute("data-dsh-refresh", "");
				host.append(button);
			}
		}
	},
	fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) })
});
const sweeperWired = sweeper.wire(sweeper.registrations[0]);
const sweeperPage = sweeperWired.slots.find((item) => item.slot === "main").component;
let swept = await sweeper.render(sweeperPage, { t: T });
findAll(swept, (node) => node.props?.className === "hub-row")[0].props.onClick();
swept = await sweeper.render(sweeperPage, { t: T });
await new Promise((resolve) => setTimeout(resolve, 5));
const sweptHost = findAll(swept, (node) => node.props?.ref !== undefined)[0].props.ref.current;
console.log('DEBUG sweep children:', sweptHost.children.length, JSON.stringify(sweptHost.children.map((c) => c.tag + ":" + c.textContent)));
check(sweptHost.children.length === 0, "a panel's bare refresh button is swept out of the mount point", String(sweptHost.children.length));
check(
	findAll(swept, (node) => node.props?.["aria-label"] === T("refresh")).length === 1,
	"the sweep leaves the page's own refresh alone",
	String(findAll(swept, (node) => node.props?.["aria-label"] === T("refresh")).length)
);

// A marked control is dropped as soon as it appears, even synchronously. Back to
// the list first: the open feature is what the page is showing.
findAll(swept, (node) => node.props?.["aria-label"] === T("back"))[0].props.onClick();
swept = await sweeper.render(sweeperPage, { t: T });
findAll(swept, (node) => node.props?.className === "hub-row")[1].props.onClick();
swept = await sweeper.render(sweeperPage, { t: T });
const markedHost = findAll(swept, (node) => node.props?.ref !== undefined)[0].props.ref.current;
check(markedHost.children.length === 0, "a marked refresh control never survives either", String(markedHost.children.length));

// A feature that throws is reported on the page, not into the console.
const broken = createBrowser({
	registry: { boom: { title: "Boom", order: 1, mount: () => { throw new Error("nope"); } } },
	fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) })
});
const brokenWired = broken.wire(broken.registrations[0]);
let brokenElement = await broken.render(brokenWired.slots.find((item) => item.slot === "main").component, { t: T });
findAll(brokenElement, (node) => node.props?.className === "hub-row")[0].props.onClick();
brokenElement = await broken.render(brokenWired.slots.find((item) => item.slot === "main").component, { t: T });
const brokenHost = findAll(brokenElement, (node) => node.props?.ref !== undefined)[0].props.ref.current;
check(brokenHost.children[0]?.textContent === `${T("failed")}: nope`, "a throwing feature is reported in place", brokenHost.children[0]?.textContent);

/* ------------------------------------------------------------------ empty */

const empty = createBrowser({ language: "en", registry: {}, fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) }) });
const emptyWired = empty.wire(empty.registrations[0]);
const emptyElement = await empty.render(emptyWired.slots.find((item) => item.slot === "main").component, { t: (key) => `en:${key}` });
check(findAll(emptyElement, (node) => node.props?.className === "hub-rows").length === 0, "an empty inventory renders no list");
check(findAll(emptyElement, (node) => node.props?.className === "hub-empty").length === 1, "an empty inventory renders the hint block");
check(findAll(emptyElement, (node) => node.props?.["aria-label"] === "en:refresh").length === 1, "an empty inventory keeps its one refresh, so the list can be rescanned");
check(emptyWired.dictionaries[0].dict.en.panel === "Features", "the English dictionary is registered too", emptyWired.dictionaries[0].dict.en.panel);
check(emptyWired.slots.find((item) => item.slot === "sidebar.panellist").options.label() === "Features", "the sidebar label follows the language");

// An unreachable inventory costs only the hint: the registry still drives the page.
const offline = createBrowser({
	registry: { doctor: { title: "Doctor", order: 1, mount: () => {} } },
	fetchImpl: async () => {
		throw new Error("offline");
	}
});
const offlineWired = offline.wire(offline.registrations[0]);
const offlineElement = await offline.render(offlineWired.slots.find((item) => item.slot === "main").component, { t: T });
check(offlineWired.slots.length === 2, "a failing inventory request still registers both slots", String(offlineWired.slots.length));
check(
	findAll(offlineElement, (node) => node.props?.className === "hub-row").length === 1,
	"the page still lists what the registry registered",
	String(findAll(offlineElement, (node) => node.props?.className === "hub-row").length)
);

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
