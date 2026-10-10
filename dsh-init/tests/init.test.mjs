/**
 * Checks for the `/init` command: what it registers, what it injects, and that
 * the injected message is one the current session format will actually accept.
 *
 * Run from an installed plugin copy (the module imports `@deepseek-ai/dsh-llm`
 * for the message factory):
 *   node tests/init.test.mjs
 *
 * The last section runs the runtime's own V4 admission on the produced message
 * when `@deepseek-ai/dsh-session-format-v3-to-v4` is resolvable, which is the
 * check that matters: a rejected message source registers fine, does nothing,
 * and fails the whole turn. It is skipped, with a note, where that package is
 * not installed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apply, inject, name } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const read = (path) => readFileSync(join(pkgDir, path), "utf8");
const manifest = JSON.parse(read("package.json"));

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });
/** Run `fn` and report whether it threw, so a probe can be proven able to fail. */
const throws = (fn) => {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
};

/* ------------------------------------------------------------- manifest */

check(manifest.name === "dsh-init", "the package is named dsh-init", manifest.name);
check(manifest.main === "lib/index.js", "the entry is lib/index.js", String(manifest.main));
check(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", "declares dsh.bundle.patch, or no layer is mounted at all", JSON.stringify(manifest.dsh?.bundle));
check(manifest.files.includes("lib") && manifest.files.includes("locale") && manifest.files.includes("cordis.patch.yml"), "ships its lib, locale and patch", JSON.stringify(manifest.files));
check(typeof manifest.exports?.["./locale/*.json"] === "string", "exposes locale files, or the plugin page shows only the package name", JSON.stringify(manifest.exports?.["./locale/*.json"]));
check(typeof manifest.exports?.["./package.json"] === "string", "exposes package.json, which the plugin page's metadata read needs");
check(manifest.private !== true, "is publishable (not private like the shell's preseed copy)");
check(manifest.peerDependencies?.["@deepseek-ai/dsh-llm"] !== undefined, "declares the harness package its message factory comes from", JSON.stringify(manifest.peerDependencies));
check(!manifest.dsh?.ui, "declares no hub feature: it is a command, with no panel to mount", JSON.stringify(manifest.dsh?.ui));

/* ---------------------------------------------------------------- patch */

const patch = read("cordis.patch.yml");
check(/^\s*- id: init$/mu.test(patch), "its row id is init", patch.match(/- id: \S+/u)?.[0]);
check(patch.includes("name: dsh-init"), "the row mounts the package by name");
check(/^\s*- insert:/mu.test(patch), "the row is an insert, the shape dsh-base composes with");

/* ------------------------------------------------------------- locales */

const zh = JSON.parse(read("locale/zh.json"));
const en = JSON.parse(read("locale/en.json"));
check(zh.meta?.title === "初始化", "the Chinese title is 初始化", String(zh.meta?.title));
check(en.meta?.title === "Init", "the English title is Init", String(en.meta?.title));
check(typeof zh.meta?.description === "string" && zh.meta.description.length > 0, "the Chinese description is present");
check(typeof en.meta?.description === "string" && en.meta.description.length > 0, "the English description is present");
check(!/—/u.test(zh.meta.description + en.meta.description), "the plugin page's own text carries no em dash");

/* --------------------------------------------------- the registered command */

/** Run an effect generator the way Cordis does, far enough for one `yield`. */
function runEffect(fn) {
	const iterator = fn();
	let step = iterator.next();
	while (!step.done) step = iterator.next(step.value);
	return step.value;
}

const registered = [];
const warnings = [];
const ctx = {
	effect(fn) {
		runEffect(fn);
	},
	commands: {
		register(definition) {
			registered.push(definition);
			return () => {};
		}
	},
	logger: { warn: (line) => warnings.push(line) }
};

check(name === "init" && inject.length === 1 && inject[0] === "commands", "the module exports the short name and injects the command registry", `${name} + [${inject.join(", ")}]`);
check(typeof apply === "function", "the module exports apply");

apply(ctx);

check(registered.length === 1, "applying registers exactly one command", String(registered.length));
const command = registered[0];
check(command?.name === "init", "the command is init", String(command?.name));
check(typeof command?.description === "string" && command.description.length > 0 && command.description.length <= 120, "the description is present and fits the palette", String(command?.description));
check(/^[\x20-\x7e]+$/u.test(command?.description ?? ""), "the description is ASCII English, like the palette's other commands", String(command?.description));
check(typeof command?.input?.hint === "string" && command.input.hint.length > 0, "the input hint is present", String(command?.input?.hint));
check(command?.input?.attachments === undefined, "declares no attachment flag it does not use");
check(typeof command?.handler === "function", "the command has a handler");
check(warnings.length === 0, "registration did not warn", warnings.join(" | "));

// A clash must degrade to a log line: an exception out of apply takes dsh down.
const clashing = [];
apply({
	effect(fn) {
		runEffect(fn);
	},
	commands: {
		register() {
			throw new Error('command "init" is already registered');
		}
	},
	logger: { warn: (line) => clashing.push(line) }
});
check(clashing.length === 1 && clashing[0].includes("already registered"), "a refused registration is reported, not thrown", clashing.join(" | "));

/* --------------------------------------------------------- what it injects */

const submitted = [];
const followup = (message) => submitted.push(message);
const invoke = (rawInput, cwd) => command.handler({
	rawInput,
	agent: { session: { header: cwd === undefined ? {} : { cwd } }, followup }
});

const extra = "关注 Windows 路径里的反斜杠";
const result = invoke(`  ${extra}  `, "H:/work/demo");
check(result?.kind === "success", "the handler reports success to the palette", JSON.stringify(result));
check(submitted.length === 1, "the handler submits exactly one message", String(submitted.length));
const message = submitted[0];
check(message.content?.[0]?.type === "text" && message.content[0].text.length > 200, "the message carries the prompt as text", String(message.content?.[0]?.type));
check(message.content[0].text.includes("H:/work/demo"), "the prompt names the session's workspace root");
check(message.content[0].text.includes(extra), "the prompt carries the text typed after /init, trimmed");
check(message.content[0].text.includes("AGENTS.md"), "the prompt names the target file");
check(message.content[0].text.includes("~/.dsh/AGENTS.md"), "the prompt tells the model which file it must not touch");
check(message.content[0].text.includes("CLAUDE.md"), "the prompt explains the harness's real instruction-loading chain");

check(message.source?.kind === "plugin:dsh-init", "the source is the package's own producer kind", String(message.source?.kind));
check(message.source?.kind !== "plugin", "the source is not the retired generic plugin wrapper");
check(message.source?.form === "notice", "the source asks for the collapsed context row", String(message.source?.form));
check(typeof message.source?.summary === "string" && message.source.summary.length <= 120, "the collapsed row's summary fits the convention", String(message.source?.summary));
check(message.source?.plugin === undefined, "the retired plugin field is gone, as the producer kind replaces it");

// No extra instructions, no workspace: the prompt still has to stand alone.
submitted.length = 0;
invoke("", undefined);
check(submitted[0].source.summary === "Create/update AGENTS.md workspace instructions", "without extra instructions the summary has no suffix", String(submitted[0].source.summary));
check(submitted[0].content[0].text.includes("(none supplied)"), "an empty /init says so instead of leaving a blank block");
check(submitted[0].content[0].text.includes("<workspace root"), "a session without a cwd falls back to a placeholder, not the string 'undefined'");
check(!submitted[0].content[0].text.includes("undefined"), "no undefined leaks into the prompt");

/* ------------------------------------------------- the static source shape */

const source = read("lib/index.js");
const visible = source.split(/\r?\n/u).filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line));
check(!visible.some((line) => /kind:\s*"plugin"\s*[,}]/u.test(line)), "no line hands the retired bare plugin kind to the factory");
check(!visible.some((line) => /kind:\s*"user"/u.test(line)), "the prompt is never submitted as a user message (it would render as a bubble)");

/* ------------------------------------ the runtime's own V4 admission probe */

let assertV4RowAdmission;
try {
	({ assertV4RowAdmission } = await import("@deepseek-ai/dsh-session-format-v3-to-v4"));
} catch {
	assertV4RowAdmission = undefined;
}

if (assertV4RowAdmission === undefined) {
	console.log("note: @deepseek-ai/dsh-session-format-v3-to-v4 is not resolvable here, so the V4 admission probe is skipped");
} else {
	const row = (candidate) => ({ type: "user/message", data: candidate });
	// The negative fixture first: a probe that cannot fail proves nothing.
	const retired = { ...message, source: { kind: "plugin", plugin: "dsh-init", form: "notice", summary: "x" } };
	check(throws(() => assertV4RowAdmission(row(retired))), "the probe rejects the retired kind:plugin source, so it can fail");
	check(!throws(() => assertV4RowAdmission(row(message))), "the submitted message passes dsh's V4 source admission");
}

/* ------------------------------------------------------------ reporting */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(failed.length === 0 ? `\nINIT TEST PASS (${results.length} checks)` : `\nINIT TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
