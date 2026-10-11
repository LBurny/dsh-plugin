/**
 * Checks for the reminder pipeline: the SSE bus (lib/bus.js), the settings
 * document (lib/settings.js) and the bundled sound files (lib/sounds.js).
 *
 * Run from an installed plugin copy (the settings writer imports
 * `@deepseek-ai/dsh-atomic-write`):
 *   node test/notify.test.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotifyBus } from "../lib/bus.js";
import { focusCommand } from "../lib/focus.js";
import { resolveLayout } from "../lib/layout.js";
import { DEFAULT_SOUND, NOTIFY_KINDS, defaultConfig, loadConfig, mergeDeep, normalizeConfig, saveConfig } from "../lib/settings.js";
import { SILENT, SYSTEM_DEFAULT, listSounds, readSound } from "../lib/sounds.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/* ------------------------------------------------------------------ bus */

/** Minimal stand-in for the HTTP response the bus streams on. */
function fakeResponse() {
	const chunks = [];
	return {
		chunks,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		write(chunk) {
			chunks.push(String(chunk));
			return true;
		},
		on(event, handler) {
			this.listeners = { ...(this.listeners ?? {}), [event]: handler };
		}
	};
}

const bus = createNotifyBus();
check(bus.recent().length === 0, "the bus starts empty");

const stream = fakeResponse();
const detach = bus.attach(stream);
check(stream.status === 200, "the SSE stream answers 200", String(stream.status));
check(stream.headers["content-type"].startsWith("text/event-stream"), "the SSE content type is right");
check(stream.chunks.join("").includes("event: ready"), "the stream opens with a ready frame");
check(bus.size() === 1, "the bus counts the open stream");

const published = bus.publish({ kind: "turn_done", text: "done" });
check(typeof published.id === "number", "publishing assigns an id");
check(stream.chunks.join("").includes('"kind":"turn_done"'), "the reminder reaches the stream");
check(bus.recent().length === 1, "recent keeps published items");
check(bus.recent()[0].at !== undefined, "recent items are timestamped");

detach();
check(bus.size() === 0, "detaching removes the stream");
bus.publish({ kind: "question", text: "after detach" });
check(!stream.chunks.join("").includes("after detach"), "a detached stream receives nothing");
check(bus.recent().length === 2, "recent still records after a detach");

/* -------------------------------------------------------------- settings */

check(NOTIFY_KINDS.length === 4, "there are four reminder kinds", NOTIFY_KINDS.join(","));
check(defaultConfig().sound === DEFAULT_SOUND, "the default sound mirrors the desktop shell", DEFAULT_SOUND);
// The kinds that block the agent notify whatever the page is doing: a reader looking at the
// window is usually looking at another session, and a missed approval costs a stalled agent.
check(
	defaultConfig().approval.timing === "always" && defaultConfig().question.timing === "always",
	"the blocking kinds default to notifying always",
	`approval=${defaultConfig().approval.timing} question=${defaultConfig().question.timing}`
);
check(
	defaultConfig().turn_done.timing === "background" && defaultConfig().answer_done.timing === "background",
	"the completion kinds default to the background",
	`turn_done=${defaultConfig().turn_done.timing} answer_done=${defaultConfig().answer_done.timing}`
);
check(defaultConfig().browser === true, "browser notifications are on by default");

// The bug this guards: saving one rule must not reset the others.
const merged = mergeDeep(defaultConfig(), { question: { timing: "always" } });
check(merged.approval.enabled === true, "mergeDeep keeps the other rules");
check(merged.volume === 0.7, "mergeDeep keeps the volume");
check(merged.question.timing === "always", "mergeDeep applies the patched rule");

const coerced = normalizeConfig({ approval: { enabled: false, timing: "nonsense" }, volume: 3, browser: "yes" });
check(coerced.approval.enabled === false, "a rule can be turned off");
check(coerced.approval.timing === "background", "an unknown timing falls back to background", coerced.approval.timing);
check(coerced.volume === 1, "the volume clamps into 0..1", String(coerced.volume));
check(coerced.browser === true, "a non-false browser value means on");
check(normalizeConfig({ toast: false }).toast === false, "the in-page popup can be turned off");
check(normalizeConfig({ sound: "" }).sound === DEFAULT_SOUND, "an empty sound falls back to the default");
check(normalizeConfig({ question: "nope" }).question.enabled === true, "a malformed rule falls back to the default");

const dir = await mkdtemp(join(tmpdir(), "kit-notify-"));
const configPath = join(dir, "dsh-notify.json");
check((await loadConfig(configPath)).volume === 0.7, "a missing settings file yields the defaults");
await writeFile(configPath, "{ not json", "utf8");
check((await loadConfig(configPath)).volume === 0.7, "a corrupt settings file yields the defaults");
await saveConfig(configPath, normalizeConfig({ volume: 0.25 }));
check(JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(configPath, "utf8"))).volume === 0.25, "saveConfig round-trips");

/* ---------------------------------------------------------------- sounds */

const sounds = await listSounds();
check(sounds.length >= 10, "the bundled sound pack ships with the plugin", String(sounds.length));
check(!sounds.includes("silent") && !sounds.includes("default"), "the two pseudo-sounds are not files");
check(sounds.includes(DEFAULT_SOUND), "the default sound is present in the pack", DEFAULT_SOUND);
const wav = await readSound(DEFAULT_SOUND);
check(wav !== undefined && wav.length > 44, "a bundled sound reads back as bytes", `${String(wav?.length ?? 0)}B`);
check(wav.subarray(0, 4).toString("ascii") === "RIFF", "the sound really is a WAV container");
check((await readSound("../escape")) === undefined, "a traversing sound id is refused");
check((await readSound("no-such-sound")) === undefined, "an unknown sound id yields undefined");
check(SILENT === "silent" && SYSTEM_DEFAULT === "default", "the pseudo-sound ids are the ones the panel expects");

await rm(dir, { recursive: true, force: true });

/* ---------------------------------------------------------------- layout */

const layout = resolveLayout({ documentPath: join("H:", "home", "profiles", "web", "cordis.patch.yml") });
check(layout.configPath === join("H:", "home", "dsh-notify.json"), "settings live next to the DSH home", layout.configPath);

/* ------------------------------------------------------------ window raise */

// A clicked reminder asks the host half to raise the application window, because a page cannot
// do it. The command is built from the platform and this process's parent, and it is built
// without running anything, which is what these checks are about: the real activation is one
// `spawn` away and cannot be exercised in a test (it would raise whoever's window is up).
const windows = focusCommand("win32", 4321);
check(
	windows?.command === "powershell" && windows.args.join(" ").includes("4321"),
	"the window raise targets this process's parent on Windows",
	`${String(windows?.command)} ${windows?.args.slice(0, 3).join(" ")}…`
);
check(
	windows.args.at(-1).includes("SetForegroundWindow") && windows.args.at(-1).includes("AttachThreadInput"),
	"the raise attaches to the foreground thread, which is what Windows demands of a steal",
	"SetForegroundWindow + AttachThreadInput"
);
check(
	windows.args.at(-1).includes("SetWindowPos") && windows.args.at(-1).includes("-1"),
	"and falls back to a topmost round trip when the foreground rule still says no",
	"SetWindowPos TOPMOST then NOTOPMOST"
);
check(
	windows.args.includes("-WindowStyle") && windows.args.includes("Hidden"),
	"the raise runs hidden, so a click does not flash a console window",
	windows.args.slice(0, 5).join(" ")
);
check(
	focusCommand("darwin", 4321) === undefined && focusCommand("linux", 4321) === undefined && focusCommand("win32", 0) === undefined,
	"a platform without an implementation raises nothing instead of guessing",
	String(focusCommand("darwin", 4321))
);

/* ------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nNOTIFY TEST PASS (${results.length} checks)` : `\nNOTIFY TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
