/**
 * Checks for the diagnostics collector: the log ring, the in-process capture, the
 * plugin tree, the log-file tails, and the status document.
 *
 * Run from an installed plugin copy (the collector imports
 * `@deepseek-ai/dsh-app-boot` for the runtime version):
 *   node test/doctor.test.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachLogger, createRecordStore, redact } from "../lib/capture.js";
import { collectDiagnostics, createLogRing, readLogFiles } from "../lib/diagnostics.js";
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

await rm(dir, { recursive: true, force: true });

/* ------------------------------------------------------------- capture */

check(redact("plain line survives") === "plain line survives", "redaction leaves ordinary text alone");
check(redact("open http://127.0.0.1:29274/?token=abc123def now") === "open http://127.0.0.1:29274/?token=<redacted> now", "a token in a URL is masked", redact("open http://127.0.0.1:29274/?token=abc123def now"));
check(redact("see https://calm-river-1234.trycloudflare.com/?token=x") === "see <tunnel-url>", "a tunnel link is masked whole", redact("see https://calm-river-1234.trycloudflare.com/?token=x"));
check(redact("Authorization: Bearer abcdefghijklmnop") === "Authorization: Bearer <redacted>", "an authorization header value is masked", redact("Authorization: Bearer abcdefghijklmnop"));

const store = createRecordStore(3);
const message = (extra) => ({ ts: 1700000000000, name: "loader", type: "info", level: 1, args: ["%s plugin %C", "apply", "dsh-skills"], ...extra });
const first = store.add(message());
check(first.sn === 1 && first.name === "loader" && first.type === "info", "a record carries an id, a source and a level", JSON.stringify(first));
check(first.text === "apply plugin dsh-skills", "cordis's %C marker is mapped to %s, so its argument keeps its place", first.text);
store.add(message({ name: "doctor", type: "warn", level: 2, args: ["panel served"] }));
store.add(message({ type: "error", level: 0, args: [{ detail: "boom" }] }));
store.add(message({ args: ["fourth"] }));
const held = store.snapshot();
check(held.length === 3 && held[0].sn === 2, "the store keeps at most its limit, dropping the oldest", held.map((record) => record.sn).join(","));
check(held.at(-1).sn === 4 && store.lastSn === 4, "sn keeps counting past the window", String(store.lastSn));

// A count alone is the wrong bound on its own: one chatty minute would push out an hour of
// boot history, and an idle session would sit on stale lines forever. The ring also drops
// what has aged out, measured against the newest record so a replayed boot line keeps its
// own older timestamp without dragging the window back with it.
const timed = createRecordStore(10, 60 * 60 * 1000);
const at = (minutes) => ({ ts: 1700000000000 + minutes * 60_000, name: "loader", type: "info", level: 1, args: [`t+${String(minutes)}`] });
timed.add(at(0));
timed.add(at(30));
timed.add(at(90));
check(
	timed.snapshot().map((record) => record.text).join(",") === "t+30,t+90",
	"a record older than the age window is dropped, keeping the last hour of logged time",
	timed.snapshot().map((record) => record.text).join(",")
);
check(timed.snapshot().length === 2, "the count cap is not what limited it", String(timed.snapshot().length));
// The floor is one hour of logged time, so a burst inside the window is kept whole even
// when it lands in the same millisecond as everything else.
const burst = createRecordStore(100, 60 * 60 * 1000);
for (let i = 0; i < 5; i += 1) burst.add(at(1));
check(burst.snapshot().length === 5, "records inside the window are all kept", String(burst.snapshot().length));

const resumed = store.select(2);
check(resumed.reset === false && resumed.records.map((record) => record.sn).join(",") === "3,4", "a resumed read returns only what is newer", `${String(resumed.reset)}:${resumed.records.map((record) => record.sn).join(",")}`);
check(store.select(4).records.length === 0, "a client that is up to date gets nothing");
check(store.select(0).reset === true, "a read from before the window asks the client to replace it");
check(store.select(undefined).records.length === 3, "a full read returns the window");

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
const target = createRecordStore(10);
const attached = attachLogger(logger, target);
check(attached.attached === true && attached.boot === 2, "attaching replays the service's boot buffer", JSON.stringify({ attached: attached.attached, boot: attached.boot }));
check(target.snapshot()[1].text === "boot warning", "the replayed records are readable", target.snapshot()[1].text);
check(exporter?.levels?.default === 3, "the exporter asks for every level", JSON.stringify(exporter?.levels));
exporter.export({ ts: 3, name: "skills", type: "error", level: 0, args: ["import failed"] });
check(target.snapshot().at(-1).text === "import failed", "a record after attach lands in the store", target.snapshot().at(-1).text);
check(typeof attached.dispose === "function", "attaching hands back a disposer");

const noExporter = attachLogger({ buffer: [] }, createRecordStore(2));
check(noExporter.attached === false && typeof noExporter.reason === "string", "a logger without an exporter reports why", String(noExporter.reason));
const noLogger = attachLogger(undefined, createRecordStore(2));
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
	capture: { attached: true, boot: 12, store: createRecordStore(5) }
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

/* ------------------------------------------------------------ reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nDOCTOR TEST PASS (${results.length} checks)` : `\nDOCTOR TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
