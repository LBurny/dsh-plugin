/**
 * Checks for the zoom settings document (lib/settings.js) and the layout
 * derivation (lib/layout.js).
 *
 * Run from an installed plugin copy (the settings writer imports
 * `@deepseek-ai/dsh-atomic-write`):
 *   node test/zoom.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { resolveLayout } from "../lib/layout.js";
import { defaultConfig, loadConfig, mergeDeep, normalizeConfig, saveConfig } from "../lib/settings.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/* ------------------------------------------------------------- defaults */

check(defaultConfig().step === 0.02, "the default step is 0.02", String(defaultConfig().step));
check(defaultConfig().level === 1, "a fresh install is at 100%");
check(defaultConfig().in.code === "Equal" && defaultConfig().in.ctrl && defaultConfig().in.shift, "the default zoom-in shortcut mirrors the desktop shell");
check(defaultConfig().out.code === "Minus", "the default zoom-out shortcut mirrors the desktop shell");
check(defaultConfig().launcher === true, "the launcher is shown by default");

/* -------------------------------------------------------------- merging */

// The bug this guards: saving one field must not reset the others.
const merged = mergeDeep(defaultConfig(), { in: { ctrl: true, shift: false, alt: false, code: "KeyZ", key: "z" } });
check(merged.step === 0.02, "mergeDeep keeps the step when only one shortcut is patched", String(merged.step));
check(merged.min === 0.25 && merged.max === 5, "mergeDeep keeps the bounds");
check(merged.in.code === "KeyZ", "mergeDeep applies the patched field");
check(merged.out.code === "Minus", "mergeDeep leaves the other shortcut alone");

/* -------------------------------------------------------------- clamping */

const clamped = normalizeConfig({ level: 99, step: 5, min: 0.2, max: -1 });
check(clamped.level === clamped.max, "level clamps to max", String(clamped.level));
check(clamped.step === 0.25, "step clamps into 0.01..0.25", String(clamped.step));
check(clamped.max >= clamped.min, "max is raised to at least min", `${String(clamped.min)}..${String(clamped.max)}`);
check(normalizeConfig({ level: "big" }).level === 1, "a non-numeric level falls back to 1");
check(normalizeConfig({ in: "nope" }).in.code === "Equal", "a malformed shortcut falls back to the default");
check(normalizeConfig({ in: { code: "" } }).in.code === "Equal", "an empty shortcut code falls back");
check(normalizeConfig({ launcher: false }).launcher === false, "the launcher can be turned off");
check(normalizeConfig({ launcher: "no" }).launcher === true, "a non-false launcher value means on");

/* ------------------------------------------------------------- file i/o */

const dir = await mkdtemp(join(tmpdir(), "kit-zoom-"));
const configPath = join(dir, "dsh-zoom.json");
check((await loadConfig(configPath)).step === 0.02, "a missing settings file yields the defaults");
await writeFile(configPath, "{ not json", "utf8");
check((await loadConfig(configPath)).step === 0.02, "a corrupt settings file yields the defaults");
await saveConfig(configPath, normalizeConfig({ level: 1.5 }));
check(JSON.parse(await readFile(configPath, "utf8")).level === 1.5, "saveConfig round-trips");
await rm(dir, { recursive: true, force: true });

/* --------------------------------------------------------------- layout */

// The layout is derived from the profile patch document, so it is right whether
// dsh runs under the desktop shell or a bare CLI.
const layout = resolveLayout({ documentPath: join("H:", "home", "profiles", "web", "cordis.patch.yml") });
check(layout.dshHome === join("H:", "home"), "the DSH home is two levels above the patch document", layout.dshHome);
check(layout.profileName === "web", "the profile name comes from the directory segment");
check(layout.configPath === join("H:", "home", "dsh-zoom.json"), "settings live next to the DSH home", layout.configPath);

/* -------------------------------------------------- marked zoom surfaces */

// The browser half marks every body child that declares its own inline placement, and
// the stylesheet cancels the page factor on exactly that mark. The two live in one
// string and one file each: rename it on either side and the mark silently stops
// mattering, which puts the bug back — a panel mounted under <body> then draws its
// viewport-space `left`/`top` at `left * zoom` a second time, off the window.
const here = (name) => new URL(`../lib/${name}`, import.meta.url);
const clientJs = await readFile(here("client.js"), "utf8");
const clientCss = await readFile(here("client.css"), "utf8");
const attribute = /const SURFACE_ATTRIBUTE = "([^"]+)"/.exec(clientJs)?.[1];
check(attribute !== undefined, "the browser half declares the surface mark", String(attribute));
check(clientCss.includes(`body > [${attribute}] {`), "the stylesheet cancels the factor on the marked surface");
check(clientCss.includes(`body > [${attribute}] > *`), "the stylesheet gives the factor back to a marked surface's contents");
check(/boot\(\)[\s\S]*?watchSurfaces\(\);/.test(clientJs), "the mark is applied at boot, not only when the panel is opened");

// The predicate is the whole rule, so it is exercised rather than just grepped: it has
// to read React's own serialization of a placement and nothing that merely looks like
// one. `padding-left` and a custom property are the two near misses that would take a
// surface away from the factor it needs (a modal or a toast, both positioned by CSS).
const predicate = /const PLACEMENT = (\/.*?\/);/.exec(clientJs)?.[1];
const placement = predicate === undefined ? null : vm.runInNewContext(predicate);
check(placement?.test("left: 1024.11px; top: 720.406px;") === true, "an inline placement is a surface");
check(placement?.test("visibility: hidden; left: 0; top: 0") === true, "the measure pass is a surface too");
check(placement?.test("padding-left: 12px; border-top: 1px solid") === false, "a padding or border is not a placement");
check(placement?.test("--dsh-toast-hold: 2000ms;") === false, "a custom property alone is not a placement");
check(placement?.test("") === false, "an empty style is not a placement");

/* ------------------------------------------------------------ reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nZOOM TEST PASS (${results.length} checks)` : `\nZOOM TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
