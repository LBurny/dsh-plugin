#!/usr/bin/env node
/**
 * Visual harness for dsh client UI work.
 *
 * Drives a headless Edge/Chrome over CDP against a running dsh web instance, so a
 * change to a panel stylesheet can be *looked at* instead of inferred from computed
 * styles: for every combination of viewport size / zoom / host attribute it writes a
 * PNG plus a geometry report.
 *
 *   node tools/visual/shot.mjs --url "http://127.0.0.1:7411/?token=<t>" \
 *        --sizes 1280x900,1000x700 --zooms 1,1.5,2 --name sidebar
 *
 * Options
 *   --url <url>        dsh web URL, token included (required)
 *   --out <dir>        where PNGs and reports land (default tools/visual/shots)
 *   --sizes <list>     WxH pairs, default 1280x900
 *   --zooms <list>     css zoom levels, default 1
 *   --titlebar <on|off|keep>  toggles html[data-windows-titlebar] (default keep)
 *   --click <text>     click the element whose trimmed text equals it, before shooting
 *   --eval <js>        run raw JS after the size/zoom/attribute step
 *   --css <file>       inject a stylesheet (repeatable) to preview a fix live
 *   --settle <ms>      wait after each change (default 500)
 *   --port <n>         CDP port for the browser it launches (default 9400)
 *   --keep             leave the browser running
 *   --json             print only the report
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const at = argv.indexOf(`--${name}`);
	if (at === -1) return fallback;
	const next = argv[at + 1];
	return next === undefined || next.startsWith("--") ? true : next;
};
const all = (name) => {
	const found = [];
	argv.forEach((item, at) => {
		if (item === `--${name}` && argv[at + 1] && !argv[at + 1].startsWith("--")) found.push(argv[at + 1]);
	});
	return found;
};
const flag = (name) => argv.includes(`--${name}`);

const url = arg("url", null);
if (!url || url === true) {
	console.error("shot.mjs: --url <dsh web url with token> is required");
	process.exit(2);
}
const outDir = resolve(String(arg("out", join(here, "shots"))));
const sizes = String(arg("sizes", "1280x900"))
	.split(",")
	.map((pair) => pair.split("x").map(Number))
	.filter(([w, h]) => w > 0 && h > 0);
const zooms = String(arg("zooms", "1"))
	.split(",")
	.map(Number)
	.filter((z) => Number.isFinite(z) && z > 0);
const titlebar = String(arg("titlebar", "keep"));
const clickText = arg("click", null);
const evalScript = arg("eval", null);
const cssFiles = all("css").map(String);
const settle = Number(arg("settle", 500));
const browserPort = Number(arg("port", 9400));
const name = String(arg("name", "shot"));
const quiet = flag("json");

/* -------------------------------------------------------------- the browser */

const BROWSERS = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];
const browserPath = BROWSERS.find((candidate) => existsSync(candidate));
if (!browserPath) {
	console.error("shot.mjs: no Edge or Chrome found");
	process.exit(2);
}

const profileDir = join(outDir, "..", "browser-profile");
mkdirSync(outDir, { recursive: true });
const child = spawn(
	browserPath,
	[
		"--headless=new",
		`--remote-debugging-port=${browserPort}`,
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--hide-scrollbars",
		"--window-size=1280,900",
		url
	],
	{ stdio: "ignore", windowsHide: true }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the page target the browser opened for our URL. */
async function findTarget(timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
			const page = list.find((t) => t.type === "page" && /^https?:/.test(String(t.url)));
			if (page) return page;
		} catch {}
		await sleep(300);
	}
	throw new Error("no browser page target appeared");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = (e) => reject(new Error(`cdp socket failed: ${e?.message ?? e}`));
});

let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (!msg.id || !pending.has(msg.id)) return;
	const { resolve, reject } = pending.get(msg.id);
	pending.delete(msg.id);
	msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
};
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});

const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
	}
	return result.result.value;
};

await send("Page.enable");
await send("Runtime.enable");

/* Wait for the app shell, not just the document: the SPA renders after load. */
for (let attempt = 0; attempt < 60; attempt++) {
	const ready = await evaluate('!!document.querySelector(\'[class*="_frame"], [class*="_sidebarCol"]\')');
	if (ready) break;
	await sleep(500);
}
if (titlebar === "on" || titlebar === "off") {
	await evaluate(
		`document.documentElement.${titlebar === "on" ? "setAttribute" : "removeAttribute"}("data-windows-titlebar","")`
	);
}
for (const file of cssFiles) {
	await evaluate(
		`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(
			readFileSync(String(file), "utf8")
		)}; document.head.append(s); })()`
	);
}

/* --------------------------------------------------------------- measurement */

const REPORT = `(() => {
	const seen = new Set();
	const pick = (needle) => {
		const el = document.querySelector('[class*="' + needle + '"]');
		if (!el) return null;
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			cls: [...el.classList].join("."),
			top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), height: +r.height.toFixed(1),
			scrollH: el.scrollHeight, clientH: el.clientHeight,
			grow: cs.flexGrow, overflow: cs.overflowY
		};
	};
	const rows = [...document.querySelectorAll('[class*="_panelRow"]')].map((el) => el.textContent.trim().slice(0, 12));
	const vh = window.innerHeight;
	// The sidebar column is the only non-shrinkable stack in the shell: its children are
	// flex:none except the session region, which collapses to zero. Forcing a zoom that
	// overflows therefore makes col.scrollHeight report the exact height the column needs
	// in layout px, independent of zoom - the number the adaptive ceiling divides by.
	const col = document.querySelector('[class*="_sidebarCol"]');
	const sidebarRequired = (() => {
		if (!col) return null;
		const html = document.documentElement;
		const keep = html.style.zoom;
		html.style.zoom = "6";
		const need = col.scrollHeight;
		html.style.zoom = keep;
		return need;
	})();
	// Cross-check: the same number summed from the sidebar root's uncompressed children.
	const root = (() => {
		const foot = document.querySelector('[class*="_footArea"]');
		return foot ? foot.parentElement : null;
	})();
	const sidebarRequiredAlt = (() => {
		if (!root) return null;
		const rcs = getComputedStyle(root);
		let sum = parseFloat(rcs.paddingTop) + parseFloat(rcs.paddingBottom);
		for (const kid of root.children) {
			const cs = getComputedStyle(kid);
			if (Number(cs.flexGrow) > 0) continue;
			sum += kid.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
		}
		return +sum.toFixed(1);
	})();
	const clipped = [];
	const foot = pick("_footArea");
	for (const el of document.querySelectorAll("body *")) {
		if (seen.has(el)) continue;
		seen.add(el);
		const cs = getComputedStyle(el);
		if (cs.overflowY !== "hidden" && cs.overflowY !== "clip") continue;
		if (el.scrollHeight <= el.clientHeight + 1) continue;
		const r = el.getBoundingClientRect();
		if (r.height < 40 || r.width < 40) continue;
		clipped.push({ cls: [...el.classList].join(".").slice(0, 40), need: el.scrollHeight, have: el.clientHeight });
	}
	return JSON.stringify({
		inner: vh, doc: document.documentElement.clientHeight,
		titlebar: document.documentElement.hasAttribute("data-windows-titlebar"),
		zoom: document.documentElement.style.zoom || "1",
		frame: pick("_frame"), sidebarCol: pick("_sidebarCol"), sidebarRoot: pick("_root"),
		topStrip: pick("_topStrip"), logoRow: pick("_logoRow"), newSession: pick("_newSession"),
		panelList: pick("_panelList"), regionArea: pick("_regionArea"),
		footArea: foot,
		panelRows: rows, sidebarRequired, sidebarRequiredAlt,
		rootKids: root
			? [...root.children].map((kid) => {
					const cs = getComputedStyle(kid);
					return {
						c: [...kid.classList].join(".").slice(0, 26),
						h: kid.offsetHeight,
						grow: cs.flexGrow,
						m: cs.marginTop + "/" + cs.marginBottom
					};
				})
			: null,
		// Layout px the column has at the current zoom; compare with required.
		colLayout: col ? col.clientHeight : null,
		footerBottom: foot ? foot.bottom : null,
		footerClipped: foot ? foot.bottom > vh + 1 : null,
		clipped: clipped.slice(0, 6)
	});
})()`;

/** Click the deepest clickable element whose trimmed text equals `text`. */
async function clickByText(text) {
	const box = await evaluate(`(() => {
		const wanted = ${JSON.stringify(text)};
		const hits = [...document.querySelectorAll("button,[role=button],a,div")].filter(
			(el) => (el.textContent || "").trim() === wanted
		);
		const el = hits[hits.length - 1];
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	})()`);
	if (!box) return false;
	for (const type of ["mousePressed", "mouseReleased"]) {
		await send("Input.dispatchMouseEvent", {
			type,
			x: box.x,
			y: box.y,
			button: "left",
			clickCount: 1
		});
		await sleep(60);
	}
	await sleep(settle);
	return true;
}

/* -------------------------------------------------------------------- capture */

const report = [];
for (const [width, height] of sizes) {
	for (const zoom of zooms) {
		await send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: false
		});
		await evaluate(`document.documentElement.style.zoom = ${JSON.stringify(String(zoom))}`);
		await sleep(settle);
		if (typeof clickText === "string") await clickByText(clickText);
		if (typeof evalScript === "string") await evaluate(evalScript);
		if (typeof clickText === "string" || typeof evalScript === "string") await sleep(300);

		const shot = await send("Page.captureScreenshot", { format: "png" });
		const label = `${name}-z${zoom}-${width}x${height}${typeof clickText === "string" ? "-click" : ""}`;
		const file = join(outDir, `${label}.png`);
		writeFileSync(file, Buffer.from(shot.data, "base64"));
		const state = JSON.parse(await evaluate(REPORT));
		report.push({ label, file, ...state });
		if (!quiet) {
			// The same arithmetic the plugin ships: slack * height / requirement.
			const ceiling = state.sidebarRequired
				? ((state.inner * 0.98) / state.sidebarRequired).toFixed(2)
				: "n/a";
			console.log(`--- ${label}`);
			console.log(
				`    inner=${state.inner} zoom=${state.zoom} titlebar=${state.titlebar} ` +
					`required=${state.sidebarRequired} (alt ${state.sidebarRequiredAlt}) ` +
					`ceiling=${ceiling} col=${state.colLayout} footerBottom=${state.footerBottom}` +
					`${state.footerClipped ? " FOOTER CLIPPED" : ""} panels=${state.panelRows.length}`
			);
			if (state.clipped.length) {
				console.log(`    clipped: ${state.clipped.map((c) => `${c.cls} needs ${c.need} has ${c.have}`).join(" | ")}`);
			}
		}
	}
}

writeFileSync(join(outDir, `${name}.report.json`), JSON.stringify(report, null, 1));

/* --tree: the sidebar column's subtree with layout heights, for structural work. */
if (flag("tree")) {
	const tree = await evaluate(`(() => {
		const col = document.querySelector('[class*="_sidebarCol"]');
		if (!col) return "(no sidebar column)";
		const walk = (el, depth) => {
			const cs = getComputedStyle(el);
			const pad = "  ".repeat(depth);
			const label =
				pad + (el.tagName === "DIV" ? "div" : el.tagName.toLowerCase()) +
				" [" + [...el.classList].join(" ") + "]" +
				" h=" + el.offsetHeight + " grow=" + cs.flexGrow + " ov=" + cs.overflowY +
				(el.textContent && el.children.length === 0 ? " |" + (el.textContent.trim().slice(0, 24)) : "");
			const lines = [label];
			for (const kid of el.children) lines.push(...walk(kid, depth + 1));
			return lines;
		};
		return walk(col, 0).filter(Boolean).join("\\n");
	})()`);
	console.log(tree);
}
if (quiet) console.log(JSON.stringify(report, null, 1));
else console.log(`\nreport: ${join(outDir, `${name}.report.json`)}`);

/* -------------------------------------------------------------------- teardown */

ws.close();
if (!flag("keep")) {
	child.kill();
	await sleep(300);
	spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
process.exit(0);
