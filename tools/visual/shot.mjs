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
 *   --theme <dark|light|keep>  toggles body[data-ds-dark-theme] (default keep)
 *   --panel <pkg>      renders that package's panel inside a copy of the hub page
 *   --fixture <file>   the route payloads for --panel (default fixtures/<pkg>.json)
 *   --click <text>     click the element whose trimmed text equals it, before shooting
 *   --eval <js>        run raw JS after the size/zoom/attribute step
 *   --css <file>       inject a stylesheet (repeatable) to preview a fix live
 *   --script <file>    evaluate a script file in the page (repeatable): the proxy's own
 *                      mobile layer, which on a real phone comes from dsh-remote
 *   --ask <js>         evaluate an expression and print its JSON value (repeatable): the
 *                      reconnaissance half of the loop, before writing any rule
 *   --settle <ms>      wait after each change (default 500)
 *   --port <n>         CDP port for the browser it launches (default 9400)
 *   --browser-arg <f>  extra browser flag, verbatim (repeatable). Point the URL at a
 *                      fake host and pass `--host-resolver-rules=MAP phone.test 127.0.0.1`
 *                      to look like a phone origin without a real tunnel.
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
const theme = String(arg("theme", "keep"));
const clickText = arg("click", null);
const evalScript = arg("eval", null);
const cssFiles = all("css").map(String);
const scriptFiles = all("script").map(String);
const asks = all("ask").map(String);
const settle = Number(arg("settle", 500));
const browserPort = Number(arg("port", 9400));
// Read these raw: the values are themselves `--flags`, which `all()` would reject.
const browserArgs = [];
argv.forEach((item, at) => {
	if (item === "--browser-arg" && argv[at + 1] !== undefined) browserArgs.push(argv[at + 1]);
});
const name = String(arg("name", "shot"));
const panelName = arg("panel", null);
const fixturePath = arg("fixture", null);
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
// Extra browser flags, verbatim. The one that matters in practice is
// `--host-resolver-rules=MAP phone.test 127.0.0.1`: it makes `location.hostname`
// non-loopback while the socket still lands on the proxy, which is the only way
// to reproduce what a phone sees when dsh scopes a page by transport.
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
		...browserArgs,
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
if (theme === "dark") await evaluate('document.body.setAttribute("data-ds-dark-theme","")');
// The proxy's enhancement layer needs the early slot a real phone gives it, so it is added as
// an inline script element rather than run through Runtime.evaluate.
for (const file of scriptFiles) {
	await evaluate(`(() => {
		const tag = document.createElement("script");
		tag.textContent = ${JSON.stringify(readFileSync(String(file), "utf8"))};
		document.head.append(tag);
	})()`);
}
if (theme === "light") await evaluate('document.body.removeAttribute("data-ds-dark-theme")');
for (const file of cssFiles) {
	await evaluate(
		`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(
			readFileSync(String(file), "utf8")
		)}; document.head.append(s); })()`
	);
}

/* ------------------------------------------------------------- panel preview */

/**
 * `--panel <pkg>` renders that package's panel the way the 功能管理 hub shows it:
 * the hub's own stylesheet, its head (back / title / package chip / refresh) and a
 * `hub-stage[data-view="feature"]`, into which the panel mounts itself. The panel's
 * routes are answered from `fixtures/<pkg>.json`, so a list has rows to look at.
 * This is how to see a panel change without installing anything.
 */
let injected = evalScript;
if (typeof panelName === "string") {
	const dir = resolve(here, "..", "..", String(panelName));
	const fixtures = JSON.parse(
		readFileSync(typeof fixturePath === "string" ? resolve(String(fixturePath)) : join(here, "fixtures", `${String(panelName)}.json`), "utf8")
	);
	const hubSource = readFileSync(join(here, "..", "..", "dsh-features", "lib", "client.js"), "utf8");
	const skinAt = hubSource.indexOf("const SKIN = `");
	const hubSkin = hubSource.slice(skinAt + "const SKIN = `".length, hubSource.indexOf("`;", skinAt));
	// The hub's stylesheet, then the panel's own: in a real shell a plugin's CSS ships
	// with its client bundle, so a preview has to inject it by hand.
	const previewCss = `${hubSkin}
${readFileSync(join(dir, "lib", "client.css"), "utf8")}`;
	const head = `<div class="hub-head">`
		+ `<button class="hub-icon-btn" type="button" title="返回" aria-label="返回"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg></button>`
		+ `<div class="hub-titles"><div class="hub-line"><h1>预览</h1><span class="hub-pkg">${String(panelName)}</span></div><p>panel preview</p></div>`
		+ `<button class="hub-icon-btn" type="button" title="刷新" aria-label="刷新"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 11-1.6-3.7M13 2.5V5h-2.5"/></svg></button>`
		+ `</div><div class="hub-stage" data-view="feature"></div>`;
	const scenario = `(async () => {
	const FIXTURES = ${JSON.stringify(fixtures)};
	const reply = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
	const real = window.fetch.bind(window);
	window.fetch = (url, init) => {
		const path = String(url);
		for (const key of Object.keys(FIXTURES)) if (key !== "default" && path.includes(key)) return reply(FIXTURES[key]);
		// The hub probe must fail, or the panel stands down expecting the hub to mount it.
		if (path.includes("/dsh-features/api/status")) return reply({ ok: false, error: "preview" });
		if (FIXTURES.default !== undefined) return reply(FIXTURES.default);
		return real(url, init);
	};
	// Get the onboarding dialog out of the way: it is modal, so it would cover the page.
	for (const button of document.querySelectorAll("button")) {
		if ((button.textContent || "").trim() === "继续" || (button.textContent || "").trim() === "Continue") button.click();
	}
	const style = document.createElement("style");
	style.textContent = ${JSON.stringify(previewCss)};
	document.head.append(style);
	// The page fills the window: the harness shoots this overlay, not the app behind it,
	// so the review is of the panel page at a known size rather than of the whole shell.
	const stage = document.createElement("div");
	stage.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-base,#1e2126);display:flex;flex-direction:column";
	const root = document.createElement("div");
	root.id = "dsh-features-root";
	root.innerHTML = ${JSON.stringify(head)};
	stage.append(root);
	document.body.append(stage);
	const panelSource = ${JSON.stringify(readFileSync(join(dir, "lib", "client.js"), "utf8"))};
	// The panel is an IIFE that expects to be injected as one: run it, then let the hub
	// do what it does on a visit — mount the published feature into the stage.
	new Function(panelSource)();
	// Boot is async (it probes the host first), so wait for the feature to be published.
	for (let i = 0; i < 40 && Object.keys(window.__dshFeatures ?? {}).length === 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const keys = Object.keys(window.__dshFeatures ?? {});
	if (keys.length === 0) throw new Error("panel published no feature");
	window.__dshFeatures[keys[0]].mount(root.querySelector(".hub-stage"));
	// ...and for the mount's own round trip to paint the list.
	await new Promise((resolve) => setTimeout(resolve, 600));
})()`;
	injected = scenario;
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
		if (typeof injected === "string") await evaluate(injected);
		if (typeof clickText === "string" || typeof injected === "string" || asks.length > 0) {
			await sleep(typeof asks.length === "number" && asks.length > 0 ? Math.max(300, settle) : 300);
		}


		const shot = await send("Page.captureScreenshot", { format: "png" });
		const label = `${name}-z${zoom}-${width}x${height}${typeof clickText === "string" ? "-click" : ""}`;
		const file = join(outDir, `${label}.png`);
		writeFileSync(file, Buffer.from(shot.data, "base64"));
		const state = JSON.parse(await evaluate(REPORT));
		// `--ask` runs here, not earlier: what it is asked about is usually the state that
		// --click/--eval just created.
		const answers = [];
		for (const expression of asks) {
			try {
				answers.push({ ask: expression, value: await evaluate(expression) });
			} catch (error) {
				answers.push({ ask: expression, error: String(error?.message ?? error) });
			}
		}
		if (answers.length > 0) console.log(JSON.stringify(answers, null, 1));
		report.push({ label, file, ...state, answers });
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
