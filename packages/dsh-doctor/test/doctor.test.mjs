/**
 * Checks for the diagnostics collector (lib/diagnostics.js): the log ring, the
 * shell-log tail reader, and the status document.
 *
 * Run from an installed plugin copy (the collector imports
 * `@deepseek-ai/dsh-app-boot` for the runtime version):
 *   node test/doctor.test.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiagnostics, createLogRing, readLogs } from "../lib/diagnostics.js";

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

/* ---------------------------------------------------------------- tail */

const dir = await mkdtemp(join(tmpdir(), "kit-doctor-"));

// A log larger than the read window: the tail reader must not return the whole
// file, and must drop the partial first line its byte window lands inside.
const bigPath = join(dir, "events.log");
const wide = `${Array.from({ length: 40000 }, (_, index) => `[00:00:00.000] line ${String(index)} padded with text to make this file bulky`).join("\n")}\n`;
await writeFile(bigPath, wide, "utf8");

const layout = { shellLogPath: bigPath };
const logs = await readLogs(layout, ring);
check(logs.source === "shell", "an existing shell log is preferred over the ring", logs.source);
check(logs.path === bigPath, "the shell log path is reported");
check(logs.lines.length > 0 && logs.lines.length <= 500, "the tail is line-capped", String(logs.lines.length));
check(logs.lines.every((line) => line.startsWith("[00:00:00.000] line ")), "no partial line survives the byte window", logs.lines[0]);
check(logs.lines.at(-1) === "[00:00:00.000] line 39999 padded with text to make this file bulky", "the tail ends at the last line", logs.lines.at(-1));

// A missing shell log (a bare `~/.dsh` setup) falls back to the ring.
const fallback = await readLogs({ shellLogPath: join(dir, "absent.log") }, ring);
check(fallback.source === "plugin", "a missing shell log falls back to the ring", fallback.source);
check(fallback.lines.length === 3, "the fallback returns the ring's lines");

await rm(dir, { recursive: true, force: true });

/* -------------------------------------------------------------- status */

const document = await collectDiagnostics({
	webServer: { port: 7481, host: "127.0.0.1" },
	sessions: { list: () => [{}, {}, {}] },
	layout: { profileName: "web", profileDir: "H:/home/profiles/web", dshHome: "H:/home", patchPath: "H:/home/profiles/web/cordis.patch.yml" }
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

// A profile without the sessions service must not break the snapshot.
const bare = await collectDiagnostics({ webServer: undefined, sessions: undefined, layout: { profileName: "p", profileDir: "d", dshHome: "h", patchPath: "p" } });
check(bare.sessions === undefined && bare.port === undefined, "missing services degrade to undefined instead of throwing");

/* ------------------------------------------------------------ reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nDOCTOR TEST PASS (${results.length} checks)` : `\nDOCTOR TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
