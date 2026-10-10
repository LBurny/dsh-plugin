/**
 * Repository-wide checks for the 功能管理 hub contract.
 *
 * A package's own suite must stay runnable from an installed copy, where no
 * sibling package exists, so the cross-package agreement is checked here instead:
 * every feature plugin publishes itself to `window.__dshFeatures` under the same
 * key its package.json marker advertises, and the hub lists them in one page.
 *
 * Run from the repository root:
 *   node test/hub-contract.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/** The hub, plus every feature plugin it hosts, in tab order. */
const PACKAGES = ["dsh-features", "dsh-skills", "dsh-mcp", "dsh-doctor", "dsh-zoom", "dsh-notify", "dsh-remote"];
const FEATURES = PACKAGES.slice(1);
/** The two sidebar entries this hub must sit between (official plugins). */
const SIDEBAR_ORDER = { plugins: 0, schedules: 10, features: 5 };

const read = (path) => readFileSync(join(root, path), "utf8");
const manifestOf = (pkg) => JSON.parse(read(join(pkg, "package.json")));

/* ----------------------------------------------------------- every package */

const manifests = new Map();
for (const pkg of PACKAGES) {
	const manifest = manifestOf(pkg);
	manifests.set(pkg, manifest);
	check(manifest.name === pkg, `${pkg}: the package name matches its directory`, manifest.name);
	check(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", `${pkg}: declares dsh.bundle.patch`, JSON.stringify(manifest.dsh?.bundle));
	check(read(join(pkg, "cordis.patch.yml")).includes(`name: ${pkg}`), `${pkg}: its patch row mounts the package`, pkg);
	check(manifest.main === "lib/index.js", `${pkg}: the entry is lib/index.js`, String(manifest.main));
	check(manifest.files.includes("lib"), `${pkg}: ships its lib`, JSON.stringify(manifest.files));
}

/* ------------------------------------------------------------- the hub row */

const hub = manifests.get("dsh-features");
check(hub.dsh?.client?.platform === "web", "dsh-features: declares a web client half (this is what dsh serves)", JSON.stringify(hub.dsh?.client));
check(hub.exports["./client"] === "./lib/client.js", "dsh-features: exports ./client to the bundle file", String(hub.exports["./client"]));
check(hub.dsh?.ui === undefined, "dsh-features: is the hub, not a feature in its own list", JSON.stringify(hub.dsh?.ui));

const client = read(join("dsh-features", "lib", "client.js"));
check(client.includes('id: "dsh-features"'), "dsh-features: the bundle registers under the package name", "");
check(client.includes('ctx.slots.inject("sidebar.panellist"'), "dsh-features: registers the sidebar entry", "");
check(client.includes(`const ORDER = ${SIDEBAR_ORDER.features};`), "dsh-features: the sidebar order sits between 插件 (0) and 自动化任务 (10)", String(SIDEBAR_ORDER.features));
check(client.includes("order: ORDER,"), "dsh-features: the sidebar entry uses that order", "");
check(client.includes('ctx.slots.inject("main"'), "dsh-features: registers the page it opens", "");
check(client.includes('"dsh-features:nav-order"'), "dsh-features: the reader's drag order persists in localStorage", "");
check(client.includes("draggable:") && client.includes("onDragStart:") && client.includes("onDrop:"), "dsh-features: list rows are draggable", "");
check(client.includes('className: "row"') && client.includes('className: "tile"'), "dsh-features: the page is a list of rows, not a nav rail", "");
check(client.includes('"aria-label": t("back")'), "dsh-features: an opened feature can be left again", "");
check(client.includes("function stripDuplicateRefresh(node)"), "dsh-features: a duplicate refresh in an embedded panel is swept away", "");
// Nothing a reader sees may use an em dash: it reads as a typo in a UI. Only the
// dictionary values and code strings matter, so comment prose is exempt.
const visibleLines = (source) => source.split(/\r?\n/u).filter((line) => !/^\s*(\*|\/\/|\/\*)/u.test(line));
check(!visibleLines(client).some((line) => line.includes("—")), "dsh-features: no em dash in anything the page shows", "");
for (const pkg of FEATURES) {
	const visible = visibleLines(read(join(pkg, "lib", "client.js")));
	check(!visible.some((line) => line.includes("—")), `${pkg}: no em dash in anything the panel shows`, "");
}
check(client.includes("#dsh-launchers { display: none !important; }"), "dsh-features: the skin hides the corner launcher dock", "");
check(!/\bimport\s|\bexport\s/u.test(client.split("\n").filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")).join("\n")), "dsh-features: the bundle is a classic script, not a module", "");

const hostHalf = read(join("dsh-features", "lib", "index.js"));
check(hostHalf.includes('`${ROUTE_PREFIX}/api/status`'), "dsh-features: the host half serves the probe route", "");
check(hostHalf.includes('`${ROUTE_PREFIX}/api/features`'), "dsh-features: the host half serves the inventory route", "");

/* --------------------------------------------------------- every feature */

const seenOrders = new Set();
for (const pkg of FEATURES) {
	const manifest = manifests.get(pkg);
	const marker = manifest.dsh?.ui?.feature;
	check(marker !== undefined, `${pkg}: declares the dsh.ui.feature marker`, JSON.stringify(manifest.dsh?.ui));
	if (marker === undefined) continue;
	check(typeof marker.key === "string" && marker.key.length > 0, `${pkg}: the marker has a key`, JSON.stringify(marker.key));
	check(Number.isFinite(marker.order), `${pkg}: the marker has a numeric order`, String(marker.order));
	check(!seenOrders.has(marker.order), `${pkg}: the tab order is unique`, String(marker.order));
	seenOrders.add(marker.order);
	check(typeof marker.title?.zh === "string" && typeof marker.title?.en === "string", `${pkg}: the marker title is bilingual`, JSON.stringify(marker.title));
	check(typeof marker.summary?.zh === "string" && typeof marker.summary?.en === "string", `${pkg}: the marker summary is bilingual`, JSON.stringify(marker.summary));

	const panel = read(join(pkg, "lib", "client.js"));
	check(panel.includes("window.__dshFeatures = Object.assign(window.__dshFeatures ?? {}, {"), `${pkg}: publishes its panel to the hub registry`, "");
	check(panel.includes(`\t\t\t${marker.key}: {`), `${pkg}: registers under the marker's key`, marker.key);
	check(panel.includes(`order: ${marker.order},`), `${pkg}: registers the marker's tab order`, String(marker.order));
	check(/\t\t\t\ticon: "M/u.test(panel), `${pkg}: registers its nav icon`, "");
	check(panel.includes("mount: mountInline"), `${pkg}: registers an inline mount for the hub`, "");
	check(panel.includes("function buildChrome(host = document.body, inline = false)"), `${pkg}: can render into a host node instead of the document`, "");
	check(panel.includes('getJson("/dsh-features/api/status")'), `${pkg}: probes the hub before docking its own button`, "");
	check(panel.includes("if (await hubInstalled()) return;"), `${pkg}: leaves the floating panel to the hub when it is installed`, "");
	check(
		!panel.includes('text: T("refresh")') || panel.includes('inHub ? undefined : el("button", { "data-dsh-refresh": ""'),
		`${pkg}: an embedded panel hides its own refresh (the hub head owns the only one)`,
		""
	);
	// The standalone path must survive: the launcher conventions are still there.
	check(panel.includes("if (showLauncher()) buildLauncher();"), `${pkg}: still docks its own button without a hub`, "");
	check(panel.includes("function publishStackHeight(dock)"), `${pkg}: still publishes the launcher stack height`, "");
	const style = read(join(pkg, "lib", "client.css"));
	check(style.includes("#dsh-launchers {") && style.includes(".dsh-launch {"), `${pkg}: keeps the shared launcher styles`, "");
	check(style.includes(`#dsh-${marker.key}-root`), `${pkg}: its styles stay scoped to its own root`, "");
	// Colours prefer the shell's own theme tokens and keep the hardcoded fallback,
	// so a panel follows dsh's light/dark setting without breaking elsewhere.
	check(style.includes("var(--dsw-alias-bg-base, #ffffff)"), `${pkg}: prefers the shell's surface token`, "");
	check(style.includes("var(--dsw-alias-label-primary, #1c1f23)"), `${pkg}: prefers the shell's text token`, "");
	check(style.includes("var(--dsw-alias-border-l2, #e4e6eb)"), `${pkg}: prefers the shell's border token`, "");
	check(style.includes("var(--dsw-alias-bg-base, #1e2126)"), `${pkg}: keeps a dark-OS fallback for the token`, "");
	// Typography and controls mirror the official plugin page and settings form
	// (tokens extracted from dsh-client-ui-plugin-manager / -primitives), so an
	// opened feature reads as dsh's own page, not a bolted-on panel.
	check(style.includes("--dsh-accent: var(--dsw-alias-brand-primary,"), `${pkg}: the accent follows the shell's brand token`, "");
	check(style.includes("border: 0.5px solid var(--dsw-alias-border-l3,"), `${pkg}: buttons wear the shell's hairline outline`, "");
	check(style.includes("font-size: 14px;\n\tfont-weight: 500;\n\tline-height: 20px;"), `${pkg}: row titles use the official 14px/500 scale`, "");
	check(style.includes("-webkit-line-clamp: 2;") && style.includes("overflow-wrap: break-word;"), `${pkg}: long subtitles clamp to two lines at word boundaries`, "");
	check(!style.includes("overflow-wrap: anywhere") && !/\.row-(?:name|sub)\s*\{[^}]*word-break: break-all/u.test(style), `${pkg}: no mid-word breaking in row text`, "");
	check(style.includes("width: 36px;") && style.includes("translateX(16px)"), `${pkg}: the switch matches the official 36px control`, "");
	// The clamp hides the tail of a long text, so the full string rides on the
	// row's tooltip.
	check(panel.includes('el("div", { class: "row-name", text: name, title: name })'), `${pkg}: a clamped row name keeps its tooltip`, "");
	check(panel.includes('el("div", { class: "row-sub", text: subtitle, title: subtitle })'), `${pkg}: a clamped row subtitle keeps its tooltip`, "");
}

/* ------------------------------------------- one shared stylesheet block */

// All six panels share one stylesheet block up to the toast rule (only the
// package tails differ); after normalizing the header comment and the scope id
// the blocks must be byte-identical, so the design tokens cannot drift.
const sharedBlock = (pkg) => {
	const style = read(join(pkg, "lib", "client.css"));
	const upto = style.slice(0, style.indexOf("}", style.indexOf(".toast-title {")) + 1);
	return upto.replace(/^\/\*[\s\S]*?\*\//u, "/* header */").replaceAll(`#${pkg}-root`, "#SCOPE");
};
const canonicalBlock = sharedBlock(FEATURES[0]);
for (const pkg of FEATURES) {
	check(sharedBlock(pkg) === canonicalBlock, `${pkg}: shares the one panel stylesheet block`, "");
}

/* ------------------------------------------------------------- the skin */

check(client.includes("var(--dsw-alias-bg-base, #ffffff)") && client.includes("var(--dsw-alias-bg-base, #1e2126)"), "dsh-features: the hub skin follows the shell theme tokens too, with fallbacks", "");

/* -------------------------------------------------------------- the tab set */

const hubInventory = read(join("dsh-features", "lib", "inventory.js"));
check(hubInventory.includes('const PACKAGE_PREFIX = "dsh-"'), "the hub discovers packages by the dsh- prefix, never by a hardcoded list", "");

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
