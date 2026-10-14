/**
 * Checks for the diagnostics collector: the log ring, the in-process capture, the
 * plugin tree, the log-file tails, and the status document.
 *
 * Run from an installed plugin copy (the collector imports
 * `@deepseek-ai/dsh-app-boot` for the runtime version):
 *   node test/doctor.test.mjs
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachLogger, createRecordStore, redact } from "../lib/capture.js";
import { collectDiagnostics, createLogRing, readLogFiles } from "../lib/diagnostics.js";
import {
	createPatchRuntime,
	listPatches,
	loadPatchState,
	normalizePatchState,
	PATCH_CATALOG,
	removePatch,
	savePatchState,
	setPatchEnabled
} from "../lib/patches.js";
import { createPickerWorkerNode } from "../lib/picker-worker.js";
import { collectRows, packageOf, REQUIRED_ROW_IDS, summarizeRows } from "../lib/rows.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/* ---------------------------------------------------------------- ring */

const ring = createLogRing(3);
check(ring.snapshot().length === 0, "a fresh ring is empty");
ring.add("one");
ring.add("two");
check(ring.snapshot().length === 2, "the ring records what is added");
check(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[dsh-doctor\] one$/u.test(ring.snapshot()[0]), "a line carries a local timestamp and the plugin tag", ring.snapshot()[0]);
ring.add("three");
ring.add("four");
const capped = ring.snapshot();
check(capped.length === 3, "the ring keeps at most its limit", String(capped.length));
check(!capped.join("\n").includes("one"), "the oldest line is dropped first");
check(capped[2].endsWith("four"), "the newest line is last");

/* ------------------------------------------------------------ log files */

const dir = await mkdtemp(join(tmpdir(), "dsh-doctor-"));

// A log larger than the read window: the tail reader must not return the whole
// file, and must drop the partial first line its byte window lands inside.
const bigPath = join(dir, "events.log");
const wide = `${Array.from({ length: 40000 }, (_, index) => `[00:00:00.000] line ${String(index)} padded with text to make this file bulky`).join("\n")}\n`;
await writeFile(bigPath, wide, "utf8");

const shell = await readLogFiles({ shellLogPath: bigPath });
check(shell.length === 1 && shell[0].source === "shell", "an existing shell log is the one source", shell.map((file) => file.source).join(","));
check(shell[0].path === bigPath, "the shell log path is reported");
check(shell[0].lines.length > 0 && shell[0].lines.length <= 200, "the tail is line-capped", String(shell[0].lines.length));
check(shell[0].lines.every((line) => line.startsWith("[00:00:00.000] line ")), "no partial line survives the byte window", shell[0].lines[0]);
check(shell[0].lines.at(-1) === "[00:00:00.000] line 39999 padded with text to make this file bulky", "the tail ends at the last line", shell[0].lines.at(-1));

// A missing log file is simply not a source: a bare `~/.dsh` setup has none of them,
// which is also the normal case on the official app.
const absent = await readLogFiles({ shellLogPath: join(dir, "absent.log") });
check(absent.length === 0, "a missing log file is not a source", String(absent.length));

// The home's own candidates: dsh's startup-failure report (newest wins) and the
// remote plugin's tunnel log.
const home = join(dir, "home");
await mkdir(join(home, "logs"), { recursive: true });
await writeFile(join(home, "logs", "startup-2026-10-10T00-00-00-000Z-old.log"), "old report\n", "utf8");
await new Promise((resolve) => setTimeout(resolve, 20));
await writeFile(join(home, "logs", "startup-2026-10-10T01-00-00-000Z-new.log"), "new report\n", "utf8");
await writeFile(join(home, "dsh-remote-tunnel.log"), "tunnel banner\n", "utf8");
const homeFiles = await readLogFiles({ shellLogPath: join(dir, "absent.log"), dshHome: home });
check(homeFiles.map((file) => file.source).join(",") === "startup,tunnel", "the home's own logs are found", homeFiles.map((file) => file.source).join(","));
check(homeFiles[0].path.endsWith("startup-2026-10-10T01-00-00-000Z-new.log"), "the newest startup report wins", homeFiles[0].path);
check(homeFiles[0].lines.join("") === "new report", "the startup report's tail is read", homeFiles[0].lines.join("|"));

// A candidate that cannot be *opened* has to be dropped like a missing one. `open` sits
// outside the try that guards `stat`, so a file that vanishes between the two calls (log
// rotation, the tunnel log being rewritten) or one that is locked used to reject the whole
// read, which answers the diagnostics route with a 500 instead of the files it does have.
// The race itself is microseconds wide, so this stages the same call path by taking read
// permission away.
const lockedPath = join(dir, "locked.log");
await writeFile(lockedPath, "cannot be read\n", "utf8");
let unreadable = false;
if (process.platform === "win32") {
	try {
		execFileSync("icacls", [lockedPath, "/deny", `${String(process.env.USERNAME)}:(R)`], { stdio: "ignore" });
		unreadable = true;
	} catch {
		unreadable = false;
	}
} else {
	unreadable = await chmod(lockedPath, 0o000).then(
		() => true,
		() => false
	);
}
if (unreadable) {
	const size = (await stat(lockedPath)).size;
	const denied = await readLogFiles({ shellLogPath: lockedPath });
	check(denied.length === 0, "a log that cannot be opened is not a source either", `${String(denied.length)} sources, file still stats at ${String(size)}b`);
	if (process.platform === "win32") {
		try {
			execFileSync("icacls", [lockedPath, "/remove:d", String(process.env.USERNAME)], { stdio: "ignore" });
		} catch {
			/* the temp directory goes either way */
		}
	}
} else {
	console.log("note: this machine will not deny read on a file, skipping the unreadable-log check");
}

await rm(dir, { recursive: true, force: true });

/* ------------------------------------------------------------- capture */

check(redact("plain line survives") === "plain line survives", "redaction leaves ordinary text alone");
check(redact("open http://127.0.0.1:29274/?token=abc123def now") === "open http://127.0.0.1:29274/?token=<redacted> now", "a token in a URL is masked", redact("open http://127.0.0.1:29274/?token=abc123def now"));
check(redact("see https://calm-river-1234.trycloudflare.com/?token=x") === "see <tunnel-url>", "a tunnel link is masked whole", redact("see https://calm-river-1234.trycloudflare.com/?token=x"));
check(redact("Authorization: Bearer abcdefghijklmnop") === "Authorization: Bearer <redacted>", "an authorization header value is masked", redact("Authorization: Bearer abcdefghijklmnop"));

// The ring is bounded by the memory it costs: each record is charged its text, its source
// name and a per-record overhead. A count would not track that (a line's size varies by
// orders of magnitude), and an age would throw away exactly the older history a bug hunt
// reaches for, which is the one thing this panel exists to keep.
const store = createRecordStore();
const message = (extra) => ({ ts: 1700000000000, name: "loader", type: "info", level: 1, args: ["%s plugin %C", "apply", "dsh-skills"], ...extra });
const first = store.add(message());
check(first.sn === 1 && first.name === "loader" && first.type === "info", "a record carries an id, a source and a level", JSON.stringify(first));
check(first.text === "apply plugin dsh-skills", "cordis's %C marker is mapped to %s, so its argument keeps its place", first.text);
store.add(message({ name: "doctor", type: "warn", level: 2, args: ["panel served"] }));
store.add(message({ type: "error", level: 0, args: [{ detail: "boom" }] }));
store.add(message({ args: ["fourth"] }));
const held = store.snapshot();
check(held.length === 4 && store.bytes > 0, "a ring inside its budget holds every record", `${String(held.length)}:${String(store.bytes)}`);
check(held.at(-1).sn === 4 && store.lastSn === 4, "sn keeps counting past the window", String(store.lastSn));

// Spending the budget drops the oldest first, and never the newest.
const small = createRecordStore(1024);
for (let i = 1; i <= 20; i += 1) small.add(message({ args: [`line ${String(i)}`] }));
check(small.bytes <= 1024, "the ring stays inside its byte budget", String(small.bytes));
check(small.count > 0 && small.count < 20, "records are dropped once the budget is spent", String(small.count));
check(small.snapshot().at(-1).sn === 20, "the newest record is never the one dropped", String(small.snapshot().at(-1).sn));
check(small.snapshot()[0].sn > 1, "the oldest record is the one that goes first", String(small.snapshot()[0].sn));
// A ring of tiny lines must not slip under the budget: the per-record overhead is charged
// too, so the bound is on memory rather than on characters.
const tiny = createRecordStore(1024);
for (let i = 0; i < 200; i += 1) tiny.add(message({ name: "x", args: [""] }));
check(tiny.bytes <= 1024 && tiny.count < 200, "a flood of one-character lines is bounded too", `${String(tiny.count)}:${String(tiny.bytes)}`);

const resumed = store.select(2);
check(resumed.reset === false && resumed.records.map((record) => record.sn).join(",") === "3,4", "a resumed read returns only what is newer", `${String(resumed.reset)}:${resumed.records.map((record) => record.sn).join(",")}`);
check(store.select(4).records.length === 0, "a client that is up to date gets nothing");
check(small.select(0).reset === true, "a read from before what the trimmed ring still holds asks the client to replace it");
check(store.select(undefined).records.length === 4, "a full read returns everything held");
check(store.select(undefined).reset === true, "a full read asks the client to replace, so a refresh never duplicates the window");

// Attaching: the service's own buffer is the boot history, the exporter is the live
// stream. Both a logger without an exporter and a missing service must degrade.
const boot = [{ ts: 1, name: "loader", type: "info", level: 1, args: ["boot line"] }, { ts: 2, name: "loader", type: "warn", level: 2, args: ["boot warning"] }];
let exporter;
const logger = {
	buffer: boot,
	exporter(registered) {
		exporter = registered;
		return () => {};
	}
};
const target = createRecordStore();
const attached = attachLogger(logger, target);
check(attached.attached === true && attached.boot === 2, "attaching replays the service's boot buffer", JSON.stringify({ attached: attached.attached, boot: attached.boot }));
check(target.snapshot()[1].text === "boot warning", "the replayed records are readable", target.snapshot()[1].text);
check(exporter?.levels?.default === 3, "the exporter asks for every level", JSON.stringify(exporter?.levels));
exporter.export({ ts: 3, name: "skills", type: "error", level: 0, args: ["import failed"] });
check(target.snapshot().at(-1).text === "import failed", "a record after attach lands in the store", target.snapshot().at(-1).text);
check(typeof attached.dispose === "function", "attaching hands back a disposer");

const noExporter = attachLogger({ buffer: [] }, createRecordStore());
check(noExporter.attached === false && typeof noExporter.reason === "string", "a logger without an exporter reports why", String(noExporter.reason));
const noLogger = attachLogger(undefined, createRecordStore());
check(noLogger.attached === false && noLogger.boot === 0, "a missing logger service does not throw", String(noLogger.reason));

/* ---------------------------------------------------------------- rows */

check(collectRows(undefined).available === false, "a profile without the loader reports the tree as unavailable");
check(packageOf("@deepseek-ai/dsh-base/web") === "@deepseek-ai/dsh-base", "a scoped subpath resolves to its package", packageOf("@deepseek-ai/dsh-base/web"));
check(packageOf("dsh-skills/lib/index.js") === "dsh-skills", "a subpath resolves to its package", packageOf("dsh-skills/lib/index.js"));
check(packageOf("H:/My_Software/dsh-plugin/dsh-init") === "H:/My_Software/dsh-plugin/dsh-init", "a row mounted from a local path keeps its path", packageOf("H:/My_Software/dsh-plugin/dsh-init"));

const tree = collectRows({
	*entries() {
		yield { id: "webserver", options: { id: "webserver", name: "@deepseek-ai/dsh-webserver" }, disabled: false, fiber: { state: 2 } };
		yield { id: "skills", options: { id: "skills", name: "dsh-skills" }, disabled: false, fiber: { state: 2 } };
		yield { id: "broken", options: { id: "broken", name: "dsh-broken" }, disabled: false, fiber: { state: 3 } };
		yield { id: "off", options: { id: "off", name: "dsh-off" }, disabled: true, fiber: { state: 0 } };
		yield { id: "group", options: { id: "group", group: true }, disabled: false, fiber: { state: 2 } };
	}
});
check(tree.available === true && tree.rows.length === 5, "every row of the tree is listed", String(tree.rows.length));
check(tree.rows[0].state === "active" && tree.rows[0].required === true, "an active required row is named as such", JSON.stringify(tree.rows[0]));
check(tree.rows[2].state === "failed", "a failed row reads as failed", tree.rows[2].state);
check(tree.rows[3].disabled === true && tree.rows[3].state === "pending", "a disabled row is flagged and not loaded", JSON.stringify(tree.rows[3]));
check(tree.rows[4].group === true && tree.rows[4].package === "", "a group row is marked and has no package", JSON.stringify(tree.rows[4]));
check(REQUIRED_ROW_IDS.length === 7, "the seven required row ids are the ones dsh-app-boot refuses to lose", String(REQUIRED_ROW_IDS.length));
const summary = summarizeRows(tree);
check(summary.includes("3/5 rows active") && summary.includes("failed: broken"), "the tree summary counts active rows and names the failed ones", summary);

// A disabled row in a real profile has no fiber at all, which is why its state cannot
// be read the same way as a row that was meant to load.
const tidy = collectRows({
	*entries() {
		yield { id: "tool-bash", options: { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }, disabled: true };
	}
});

check(tidy.rows[0].state === "not-loaded", "a switched-off row that never got a fiber reads as not loaded", tidy.rows[0].state);
check(collectRows({ entries() { throw new Error("tree exploded"); } }).available === false, "a loader that throws mid-walk reports unavailable instead of failing the request");

/* -------------------------------------------------------------- status */

const document = await collectDiagnostics({
	webServer: { port: 7481, host: "127.0.0.1" },
	sessions: { list: () => [{}, {}, {}] },
	layout: { profileName: "web", profileDir: "H:/home/profiles/web", dshHome: "H:/home", patchPath: "H:/home/profiles/web/cordis.patch.yml" },
	loader: {
		*entries() {
			yield { id: "webserver", options: { id: "webserver", name: "@deepseek-ai/dsh-webserver" }, disabled: false, fiber: { state: 2 } };
			yield { id: "doctor", options: { id: "doctor", name: "dsh-doctor" }, disabled: false, fiber: { state: 2 } };
		}
	},
	capture: { attached: true, boot: 12, store: createRecordStore() }
});
check(typeof document.version === "string" && document.version.length > 0, "the runtime version is reported", document.version);
check(document.node === process.version, "the node version is reported");
check(document.pid === process.pid, "the pid is reported");
check(Number.isInteger(document.uptimeSeconds) && document.uptimeSeconds >= 0, "uptime is a whole number of seconds");
check(Number.isInteger(document.memoryMb) && document.memoryMb > 0, "resident memory is reported in MB");
check(document.port === 7481 && document.host === "127.0.0.1", "the web server's address is reported");
check(document.profile === "web" && document.dshHome === "H:/home", "the profile facts are reported");
check(document.patchPath.endsWith("cordis.patch.yml"), "the patch document's path is reported");
check(document.sessions === 3, "the session count comes from the registry");
check(document.rows.length === 2 && document.rowsSummary.includes("2/2 rows active"), "the plugin tree rides along with the status", document.rowsSummary);
check(document.requiredRowIds.length === 7, "the required row ids ride along too", String(document.requiredRowIds.length));
check(Array.isArray(document.logFiles), "the log files that exist are listed", JSON.stringify(document.logFiles));
check(document.capture.attached === true && document.capture.boot === 12 && document.capture.records === 0, "the capture state is reported", JSON.stringify(document.capture));

// A profile without the sessions service must not break the snapshot.
const bare = await collectDiagnostics({ webServer: undefined, sessions: undefined, layout: { profileName: "p", profileDir: "d", dshHome: "h", patchPath: "p" } });
check(bare.sessions === undefined && bare.port === undefined, "missing services degrade to undefined instead of throwing");
check(bare.rowsAvailable === false && bare.rows.length === 0, "a missing loader degrades to an empty tree", String(bare.rowsAvailable));
check(bare.capture === undefined, "a missing capture is reported as undefined, not as a broken one");

/* ------------------------------------------------------------ patches */

// The catalog is the fix itself, so it is pinned here: one patch, and it drops the one
// variable the desktop app leaks into the harness host. A second entry, or a different
// variable, has to be a deliberate change to this suite rather than a quiet one.
check(PATCH_CATALOG.length === 1, "the catalog carries exactly one patch", String(PATCH_CATALOG.length));
check(PATCH_CATALOG[0].id === "electron-run-as-node" && PATCH_CATALOG[0].variable === "ELECTRON_RUN_AS_NODE", "the patch drops ELECTRON_RUN_AS_NODE", PATCH_CATALOG[0].variable);

// Installing the plugin is the decision to fix the defect: a patch with no entry is on,
// and only a deliberate `enabled: false` turns it off.
const fresh = normalizePatchState(undefined);
check(listPatches(fresh).length === 1 && listPatches(fresh)[0].enabled === true, "a patch with no decision is enabled", JSON.stringify(listPatches(fresh)));
const off = normalizePatchState({ patches: { "electron-run-as-node": { enabled: false } } });
check(listPatches(off)[0].enabled === false, "a recorded off survives normalization");
check(Object.keys(normalizePatchState({ patches: { "electron-run-as-node": { enabled: true } } }).patches).length === 0, "an explicit on is stored as the default, not as an entry");
check(listPatches(normalizePatchState({ patches: { "electron-run-as-node": { removed: true } } })).length === 0, "a removed patch leaves the list");
check(Object.keys(normalizePatchState({ patches: { gone: { enabled: false } } }).patches).length === 0, "an entry for an id no longer in the catalog is dropped");
check(listPatches(normalizePatchState({ patches: [] }))[0].enabled === true, "a malformed file falls back to the defaults", JSON.stringify(normalizePatchState({ patches: [] })));
check(listPatches(normalizePatchState("nonsense"))[0].enabled === true, "a file that is not an object falls back to the defaults");

const toggledOff = setPatchEnabled(fresh, "electron-run-as-node", false);
check(listPatches(toggledOff)[0].enabled === false, "toggling off is recorded");
const toggledBack = setPatchEnabled(toggledOff, "electron-run-as-node", true);
check(Object.keys(toggledBack.patches).length === 0, "toggling back on clears the record");
check(listPatches(setPatchEnabled(removePatch(fresh, "electron-run-as-node"), "electron-run-as-node", true)).length === 0, "a removed patch has no switch to press");
check(Object.keys(setPatchEnabled(fresh, "not-a-patch", false).patches).length === 0, "an unknown id changes nothing");

const patchFile = join(dir, "dsh-doctor.json");
const saved = await savePatchState(patchFile, off);
check(saved.patches["electron-run-as-node"].enabled === false, "saving reports the normalized state");
check(listPatches(await loadPatchState(patchFile))[0].enabled === false, "a decision survives a round trip");
await writeFile(patchFile, "{ not json", "utf8");
check(listPatches(await loadPatchState(patchFile))[0].enabled === true, "a corrupt decision file falls back to the defaults");
check(listPatches(await loadPatchState(join(dir, "absent.json")))[0].enabled === true, "a missing decision file falls back to the defaults");

// The runtime edits an environment. `PATH` rides along to prove nothing else is touched.
const env = { ELECTRON_RUN_AS_NODE: "1", PATH: "C:\\Windows" };
const runtime = createPatchRuntime(env);
check(runtime.present("electron-run-as-node") === true, "a process that carried the variable is reported as affected");
check(runtime.settle(fresh).join(",") === "electron-run-as-node", "settling applies the patch", runtime.settle(fresh).join(","));
check(!("ELECTRON_RUN_AS_NODE" in env) && env.PATH === "C:\\Windows", "applying drops the variable and leaves the rest alone", JSON.stringify(env));
check(runtime.settle(fresh).length === 0, "settling twice changes nothing", "second settle reported a change");
const restored = runtime.settle(off);
check(restored.join(",") === "electron-run-as-node", "disabling the patch reverts it", restored.join(","));
check(env.ELECTRON_RUN_AS_NODE === "1", "reverting puts the value back as this process found it", JSON.stringify(env));
runtime.settle(fresh);
check(runtime.settle(removePatch(fresh, "electron-run-as-node")).join(",") === "electron-run-as-node", "removing a patch reverts it too");
check(env.ELECTRON_RUN_AS_NODE === "1", "a removed patch leaves no trace", JSON.stringify(env));

// A bare CLI harness (and the sandbox) never sets the variable, so the patch has nothing
// to drop there. The panel says that out loud instead of offering a fix that does nothing.
const clean = { PATH: "C:\\Windows" };
const cleanRuntime = createPatchRuntime(clean);
check(cleanRuntime.present("electron-run-as-node") === false, "an environment that never carried the variable is reported as unaffected");
check(cleanRuntime.settle(fresh).length === 0, "settling against a clean environment changes nothing");
check(cleanRuntime.settle(off).length === 0, "reverting a patch that never applied changes nothing");

/* ------------------------------------------- the folder-dialog worker */

// The patch drops ELECTRON_RUN_AS_NODE for the whole process. The Win32 folder chooser that
// a phone or LAN browser asks for is the one child that needs it: dsh spawns that worker as
// this same executable with `env: { ...process.env }`, measured on the app at 277ms to exit
// with no result once the variable is gone (it boots a second copy of the desktop app, loses
// the single-instance lock and quits), which the pick answers as "win32 folder dialog worker
// exited before reporting a result". The wrap lends the variable for that call alone.
const workerEnv = { ELECTRON_RUN_AS_NODE: "1", PATH: "C:\\Windows" };
const workerPatches = createPatchRuntime(workerEnv);
workerPatches.settle(fresh);
check(workerPatches.applied("electron-run-as-node") === true, "the runtime reports a patch it carried out", String(workerPatches.applied("electron-run-as-node")));
check(workerPatches.carried("electron-run-as-node") === "1", "and remembers the value it took", String(workerPatches.carried("electron-run-as-node")));

let spawned;
const nativeCapability = { kind: "native", pick: () => { spawned = workerEnv.ELECTRON_RUN_AS_NODE; return Promise.resolve("C:\\picked"); } };
const picker = { capability: () => nativeCapability };
const workerNode = createPickerWorkerNode(workerPatches, { env: workerEnv });
const detach = workerNode.attach(picker);
check(typeof detach === "function", "the wrap attaches to a mounted picker", typeof detach);
check(await picker.capability().pick() === "C:\\picked", "the wrapped pick still returns the backend's answer");
check(spawned === "1", "the dialog worker is spawned with the variable the patch took", String(spawned));
check(picker.capability() === nativeCapability, "the capability the controller reads is still the backend's own object");
check(!("ELECTRON_RUN_AS_NODE" in workerEnv) && workerEnv.PATH === "C:\\Windows", "and the environment is patched again the moment the call returns", JSON.stringify(workerEnv));

// The window has to close on the failure path too, or one refused pick would leave the
// variable in place for every later spawn.
const failing = { kind: "native", pick: () => { throw new Error("no chooser"); } };
const failingPicker = { capability: () => failing };
workerNode.attach(failingPicker);
let threw = false;
try {
	failingPicker.capability().pick();
} catch {
	threw = true;
}
check(threw, "a pick that fails still throws to its caller");
check(!("ELECTRON_RUN_AS_NODE" in workerEnv), "and the environment is put back after the failure as well", JSON.stringify(workerEnv));

// A bare CLI harness never carried the variable, so the patch has nothing to drop and the
// wrap must not put anything into this process's environment.
const cleanEnv = { PATH: "C:\\Windows" };
const cleanPatches = createPatchRuntime(cleanEnv);
cleanPatches.settle(fresh);
let cleanSpawned;
const cleanPicker = { capability: () => ({ kind: "native", pick: () => { cleanSpawned = "ELECTRON_RUN_AS_NODE" in cleanEnv; return Promise.resolve(null); } }) };
createPickerWorkerNode(cleanPatches, { env: cleanEnv }).attach(cleanPicker);
check(await cleanPicker.capability().pick() === null, "a cancel still resolves as null through the wrap");
check(cleanSpawned === false && !("ELECTRON_RUN_AS_NODE" in cleanEnv), "a process the patch never applied to lends nothing", JSON.stringify(cleanEnv));

// Switching the patch off puts the variable back and stops the wrap from touching anything.
workerPatches.settle(off);
check(workerPatches.applied("electron-run-as-node") === false, "and reports it as no longer in force once the reader switches it off");

// Shapes a patch has to survive: nothing mounted, no pick to wrap, and a sealed capability.
check(createPickerWorkerNode(workerPatches, { env: workerEnv }).attach(undefined) === undefined, "a profile with no picker is nothing to wrap");
check(createPickerWorkerNode(workerPatches, { env: workerEnv }).attach({ capability: 5 }) === undefined, "a service with no capability method is nothing to wrap");
const browsePicker = { capability: () => ({ kind: "browse" }) };
check(typeof createPickerWorkerNode(workerPatches, { env: workerEnv }).attach(browsePicker) === "function" && browsePicker.capability().pick === undefined, "a browse capability has no pick to wrap");
const sealed = Object.freeze({ kind: "native", pick: () => "sealed" });
const sealedPicker = { capability: () => sealed };
createPickerWorkerNode(workerPatches, { env: workerEnv }).attach(sealedPicker);
check(sealedPicker.capability().pick() === "sealed", "a sealed capability keeps working, just without the correction");

// Attaching is tied to the service's lifetime, so a reloaded picker does not stay wrapped.
const reloaded = { capability: () => ({ kind: "native", pick: () => null }) };
const reloadedOriginal = reloaded.capability;
const reloadDetach = createPickerWorkerNode(workerPatches, { env: workerEnv }).attach(reloaded);
check(reloaded.capability !== reloadedOriginal, "attaching takes over the service's capability");
reloadDetach();
check(reloaded.capability === reloadedOriginal, "detaching puts the backend's own capability back");

/* ------------------------------------------------------------ reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nDOCTOR TEST PASS (${results.length} checks)` : `\nDOCTOR TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
