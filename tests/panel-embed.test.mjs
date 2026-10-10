/**
 * Repository-wide checks for the feature panels' second contract: what a panel
 * does when the 功能管理 hub is installed.
 *
 * The hub page mounts a panel inline and owns the only refresh control, so an
 * embedded panel must not dock its floating corner button and must not add a
 * second refresh button. That behaviour lives in each panel's browser script,
 * which no package's own suite evaluates, so it is asserted here by running the
 * real `assets/panel.js` of every feature in a small DOM stub.
 *
 * Run from the repository root:
 *   node test/panel-embed.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

const PACKAGES = ["dsh-skills", "dsh-mcp", "dsh-doctor", "dsh-zoom", "dsh-notify", "dsh-remote"];

/**
 * What each panel needs from its own routes before it renders. These are the real
 * payload shapes (see each host half); a thin `{ ok: true }` would make the render
 * throw and quietly turn every "no refresh button here" assertion into a pass.
 */
const PAYLOADS = {
	"dsh-skills": { skills: [], sources: [], counts: { enabled: 0, total: 0 } },
	"dsh-mcp": { servers: [], sources: [], patchPath: "cordis.patch.yml" },
	"dsh-doctor": {
		status: {
			state: "ready", version: "0.2.0", node: "v24.0.0", pid: 1, uptimeSeconds: 5, memoryMb: 120,
			port: 1234, host: "127.0.0.1", profile: "desktop", profileDir: "/tmp/p", dshHome: "/tmp",
			patchPath: "cordis.patch.yml", sessions: 0, platform: "win32", arch: "x64",
			rows: [
				{ id: "webserver", module: "@deepseek-ai/dsh-webserver", package: "@deepseek-ai/dsh-webserver", group: false, disabled: false, state: "active", required: true },
				{ id: "doctor", module: "dsh-doctor", package: "dsh-doctor", group: false, disabled: false, state: "active", required: false }
			],
			rowsAvailable: true, rowsSummary: "2/2 rows active", rowsActive: 2, rowsTotal: 2, rowsFailed: [],
			requiredRowIds: ["webserver"], logFiles: [],
			capture: { attached: true, boot: 12, records: 2 }
		},
		records: [
			{ sn: 1, ts: 1700000000000, name: "loader", type: "info", level: 1, text: "apply plugin dsh-doctor" },
			{ sn: 2, ts: 1700000001000, name: "doctor", type: "warn", level: 2, text: "panel served" }
		],
		source: "capture", reset: true, files: []
	},
	"dsh-zoom": {
		config: {
			level: 1, step: 0.02, min: 0.25, max: 5, launcher: true,
			in: { ctrl: true, shift: true, alt: false, code: "Equal", key: "+" },
			out: { ctrl: true, shift: true, alt: false, code: "Minus", key: "_" }
		},
		configPath: "cordis.patch.yml"
	},
	"dsh-notify": {
		config: {
			approval: { enabled: true, timing: "background" }, question: { enabled: true, timing: "background" },
			turn_done: { enabled: true, timing: "background" }, answer_done: { enabled: true, timing: "background" },
			sound: "staplebops-02", volume: 0.7, toast: true, browser: false
		},
		sounds: [], configPath: "cordis.patch.yml"
	},
	"dsh-remote": { remote: { enabled: false, mode: "lan" }, cloudflared: null, qrAvailable: false }
};

/**
 * A control each panel must render in its body. Asserting one of these makes the
 * "no refresh button" check meaningful: it proves the panel really painted, and
 * that what is missing is the refresh, not the whole body.
 */
const EXPECTED = {
	"dsh-skills": "导入技能…",
	"dsh-mcp": "导入服务…",
	"dsh-doctor": "补丁层",
	"dsh-zoom": "重置为 100%",
	"dsh-notify": "试听",
	"dsh-remote": "开启"
};

/** The panels that ship a refresh button of their own (the other two have none). */
const OWN_REFRESH = new Set(["dsh-skills", "dsh-mcp", "dsh-doctor", "dsh-remote"]);

/**
 * A DOM stub with the surface the panels actually use: element objects that
 * track their parent (so `remove` and `querySelectorAll` mean something), a
 * document that records created nodes, and a per-boot `fetch`.
 */
function makeDom() {
	/**
	 * The panels append with `child instanceof Node ? child : createTextNode(...)`,
	 * so the stub's nodes must really be instances of the `Node` the sandbox sees —
	 * otherwise every element lands in the document as a text node.
	 */
	class Node {}
	let idCounter = 0;
	const parseHtml = (tag) => (tag === "#fragment" ? "fragment" : tag);
	const makeNode = (tag) => {
		const node = Object.assign(new Node(), {
			uid: ++idCounter,
			tag: parseHtml(tag),
			className: "",
			id: undefined,
			textContent: "",
			hidden: false,
			dataset: {},
			style: { setProperty() {} },
			attrs: {},
			children: [],
			parent: undefined,
			offsetHeight: 0,
			classList: { add() {}, remove() {} },
			append(...added) {
				for (const child of added) {
					if (child === undefined || child === null || child === false) continue;
					child.parent = node;
					node.children.push(child);
				}
			},
			replaceChildren(...next) {
				for (const child of node.children) child.parent = undefined;
				node.children = [];
				node.append(...next);
			},
			remove() {
				if (node.parent === undefined) return;
				const at = node.parent.children.indexOf(node);
				if (at !== -1) node.parent.children.splice(at, 1);
				node.parent = undefined;
			},
			setAttribute(key, value) {
				node.attrs[key] = String(value);
				// `id` and `hidden` are reflected properties in a real DOM, and the
				// panels read them as properties: `getElementById` and `panel.hidden`.
				if (key === "id") node.id = String(value);
				if (key === "hidden") node.hidden = true;
			},
			getAttribute: (key) => node.attrs[key],
			hasAttribute: (key) => Object.hasOwn(node.attrs, key),
			listeners: {},
			addEventListener(type, handler) {
				node.listeners[type] = handler;
			},
			removeEventListener() {},
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
		});
		return node;
	};

	const body = makeNode("body");
	const document = {
		readyState: "complete",
		head: { append() {} },
		body,
		documentElement: { style: { setProperty() {} } },
		createElement: (tag) => makeNode(tag),
		createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [] }),
		createDocumentFragment: () => makeNode("#fragment"),
		getElementById: () => null,
		// The sidebar stub: `sidebarRequired` stands in for the harness's own column,
		// whose scrollHeight is the height the shell needs in layout px.
		querySelector: (selector) =>
			String(selector).includes("_sidebarCol") && typeof dom.sidebarRequired === "number"
				? { scrollHeight: dom.sidebarRequired }
				: null,
		addEventListener() {},
		execCommand: () => true
	};
	const dom = { Node, makeNode, body, document, sidebarRequired: undefined };
	return dom;
}

/** Every node under a root, the root excluded. */
function descendants(node, found = []) {
	for (const child of node.children ?? []) {
		found.push(child);
		descendants(child, found);
	}
	return found;
}

/**
 * Boot one panel. `hub` decides whether the 功能管理 probe route answers; a panel
 * that sees it must stay out of the way of the hub page.
 * @returns the booted panel with its sandbox, the DOM stub and the mount point.
 */
async function bootPanel(pkg, { hub = true, mount = true, innerHeight = 900, sidebarRequired, level } = {}) {
	const dom = makeDom();
	dom.sidebarRequired = sidebarRequired;
	// Window listeners are recorded so a test can fire them the way the browser does.
	const listeners = {};
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		Node: dom.Node,
		innerHeight,
		addEventListener(event, handler) {
			(listeners[event] ??= []).push(handler);
		},
		document: dom.document,
		navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
		// The boot-order guard waits for the shell's sidebar with an observer; the
		// callback is captured so a test can play the sidebar appearing late.
		MutationObserver: class {
			constructor(callback) {
				sandbox.sidebarAppeared = callback;
			}
			observe() {}
			disconnect() {}
		},
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: async (url) => {
			const path = String(url);
			if (path.includes("/dsh-features/api/status")) {
				if (!hub) throw new Error("no hub");
				return { ok: true, status: 200, json: async () => ({ ok: true, hub: "dsh-features" }) };
			}
			const payload = { ok: true, ...PAYLOADS[pkg] };
			if (level !== undefined && payload.config !== undefined) payload.config = { ...payload.config, level };
			if (path.includes("/api/logs") || path.includes("/diagnostics")) return { ok: true, status: 200, json: async () => payload };
			return { ok: true, status: 200, json: async () => payload };
		}
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(join(root, pkg, "lib", "client.js"), "utf8"), sandbox, { filename: `${pkg}/panel.js` });
	// One macrotask is enough for boot()'s probe round trip and the first render.
	await new Promise((resolve) => setTimeout(resolve, 30));

	const registry = sandbox.__dshFeatures ?? {};
	const keys = Object.keys(registry);
	const host = dom.makeNode("div");
	// Mounting inline is what the hub does; it also tears down a floating panel the
	// boot may have built, so the standalone path is observed with `mount: false`.
	if (mount) {
		for (const key of keys) await registry[key].mount(host);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	return { sandbox, dom, host, keys, listeners };
}

/** The buttons of a subtree, by their visible text. */
const buttonsOf = (node) =>
	descendants(node)
		.filter((child) => child.tag === "button")
		.map((child) => (child.textContent ?? "").trim());

/** All text a subtree shows: every element's own text plus every text node's. */
const textOf = (node) => {
	const own = typeof node.textContent === "string" ? node.textContent : "";
	const inner = (node.children ?? []).map(textOf).join(" ");
	return `${own} ${inner}`.trim();
};

const REFRESH = new Set(["刷新", "Refresh"]);

for (const pkg of PACKAGES) {
	/* ------------------------------------------------- with the hub installed */

	const embedded = await bootPanel(pkg);
	check(embedded.keys.length === 1, `${pkg}: publishes exactly one feature to the hub`, embedded.keys.join(","));
	check(
		!embedded.dom.body.children.some((child) => child.id === "dsh-launchers"),
		`${pkg}: docks no corner button while the hub answers`,
		embedded.dom.body.children.map((child) => child.id ?? child.tag).join(",")
	);

	const embeddedButtons = buttonsOf(embedded.host);
	const embeddedText = textOf(embedded.host);
	check(
		embeddedText.includes(EXPECTED[pkg]),
		`${pkg}: the embedded panel really painted its body`,
		embeddedText.slice(0, 120) || "(empty)"
	);
	check(
		!embeddedButtons.some((text) => REFRESH.has(text)),
		`${pkg}: an embedded panel renders no refresh button (the hub page owns it)`,
		embeddedButtons.join(",") || "(no buttons)"
	);
	// The marker only has to be present when the panel does render a refresh of its
	// own; the hub hides a marked one as a belt-and-braces measure.
	const panel = readFileSync(join(root, pkg, "lib", "client.js"), "utf8");
	check(
		panel.includes('"data-dsh-refresh": ""') || !OWN_REFRESH.has(pkg),
		`${pkg}: the refresh it renders when standalone is marked for the hub to hide`,
		""
	);

	/* ------------------------------------------------------- the standalone path */

	const standalone = await bootPanel(pkg, { hub: false, mount: false });
	const dock = standalone.dom.body.children.find((child) => child.id === "dsh-launchers");
	check(dock !== undefined, `${pkg}: still docks its corner button without the hub`, standalone.dom.body.children.map((child) => child.id ?? child.tag).join(","));
	check(
		dock !== undefined && dock.children.length === 1,
		`${pkg}: the dock holds exactly its own launcher`,
		String(dock?.children.length)
	);
	// Without the hub the panel must keep its own refresh: that path is the only
	// way to reload a standalone panel's data. Opening the panel is what renders
	// its body, so the launcher is clicked the way a reader would.
	const launcher = dock?.children[0];
	launcher?.listeners?.click?.();
	await new Promise((resolve) => setTimeout(resolve, 30));
	const standaloneButtons = buttonsOf(standalone.dom.body);
	check(
		launcher?.listeners?.click !== undefined,
		`${pkg}: the corner button opens its panel`,
		Object.keys(launcher?.listeners ?? {}).join(",")
	);
	check(
		!OWN_REFRESH.has(pkg) || standaloneButtons.includes("刷新"),
		`${pkg}: keeps its own refresh in the floating panel`,
		`${standaloneButtons.join(",") || "(no buttons)"} :: ${textOf(standalone.dom.body).slice(0, 100)}`
	);
	check(
		standalone.keys.length === 1,
		`${pkg}: still publishes to the registry without the hub (harmless, nothing reads it)`,
		standalone.keys.join(",")
	);
}

/* --------------------------------------------------- the refresh de-duplication */

/** The hub's rule, copied from its bundle: a bare 刷新/Refresh button is a duplicate. */
const stripSource = readFileSync(join(root, "dsh-features", "lib", "client.js"), "utf8");
check(stripSource.includes("function stripDuplicateRefresh(node)"), "dsh-features: the hub sweeps a mounted panel for a duplicate refresh", "");
check(stripSource.includes('new Set(["刷新", "Refresh"])'), "dsh-features: the sweep knows both refresh labels", "");
check(stripSource.includes("[data-dsh-refresh]"), "dsh-features: a marked refresh is hidden by the skin too", "");

/* --------------------------------------------------- the zoom ceiling */

// CSS `zoom` on <html> divides the layout viewport by the factor, so a large
// enough level makes the harness's own sidebar taller than its box; the shell
// clips it (`overflow: hidden`) and the document never scrolls, which puts
// 设置 / 意见反馈 / 退出登录 — and the avatar menu hanging off them — out of reach.
// dsh-zoom therefore bounds the level by what the window can render, measured
// from the sidebar column itself. These cases boot the real panel at a saved
// level of 300%, so what is observed is the clamp the page really receives.
const zoomedTo = (booted) => Number(booted.dom.document.documentElement.style.zoom);
/** The cap the shipped code should reach for a given window and sidebar. */
const expectedCap = (innerHeight, sidebarRequired) =>
	Math.floor(Math.max(1, Math.min(5, (innerHeight * 0.98) / sidebarRequired)) * 100) / 100;
/** The slider's own maximum: the cap as the panel reports it. */
const capOf = (booted) => {
	const slider = descendants(booted.host).find((node) => node.attrs?.type === "range");
	return slider === undefined ? undefined : Number(slider.attrs.max);
};
const zoomWith = async (innerHeight, sidebarRequired) => {
	const booted = await bootPanel("dsh-zoom", { innerHeight, sidebarRequired, level: 3 });
	await booted.sandbox.__dshFeatures.zoom.mount(booted.host);
	await new Promise((resolve) => setTimeout(resolve, 30));
	return booted;
};

// A sidebar that needs 450 layout px in a 900 px window: 900 * 0.98 / 450 = 1.96.
const measured = await zoomWith(900, 450);
check(
	zoomedTo(measured) === expectedCap(900, 450) && zoomedTo(measured) < 900 / 450,
	"dsh-zoom: the cap is measured from the sidebar column, not assumed",
	`${zoomedTo(measured)} vs ${expectedCap(900, 450)}`
);
check(
	capOf(measured) === expectedCap(900, 450),
	"dsh-zoom: the slider stops at the measured cap",
	`${capOf(measured)} vs ${expectedCap(900, 450)}`
);
check(
	textOf(measured.host).includes("已按窗口高度封顶"),
	"dsh-zoom: the panel says the ceiling comes from the window",
	textOf(measured.host).slice(0, 140)
);
check(
	zoomedTo(measured) !== 6,
	"dsh-zoom: the sampling zoom used to measure is not left applied",
	String(zoomedTo(measured))
);

// The level used to be bare 13px text sitting beside two 32px buttons, which read as a
// stray number rather than the value of the control above it. It is a chip now: the same
// box as those buttons. Asserted on the mounted panel, so a class rename cannot pass.
const chip = descendants(measured.host).find((node) => node.className === "level");
check(
	chip !== undefined && /^\d+%$/u.test(chip.textContent ?? ""),
	"dsh-zoom: the current level is a boxed chip, not bare text beside the buttons",
	chip === undefined ? "(no .level element)" : chip.textContent
);

// A rail (narrow window) and an expanded sidebar with more footer rows differ by
// hundreds of px; the cap has to follow the one that is mounted, not a constant.
const rail = await zoomWith(900, 216);
check(
	capOf(rail) === expectedCap(900, 216) && capOf(rail) > capOf(measured),
	"dsh-zoom: a lighter sidebar allows a higher cap than a heavier one",
	`${capOf(rail)} vs ${capOf(measured)}`
);

// No sidebar at all (a host without one, or the shell has not mounted it yet):
// fall back to the stock measurement rather than not capping at all.
const noSidebar = await zoomWith(1200, undefined);
check(
	capOf(noSidebar) === expectedCap(1200, 360) && zoomedTo(noSidebar) === 3,
	"dsh-zoom: without a sidebar column the stock floor still caps the level",
	`cap ${capOf(noSidebar)} vs ${expectedCap(1200, 360)}`
);
// A hidden or not-yet-laid-out window reports 0. Reading that as "a very short
// window" would slam the zoom to the minimum; it must simply not cap anything.
const noWindow = await zoomWith(0, 450);
check(
	zoomedTo(noWindow) === 3,
	"dsh-zoom: a window height of 0 is not treated as a tiny window",
	String(zoomedTo(noWindow))
);
// A window too short for the sidebar even at 100% must not be shrunk on the
// user's behalf: the cap never drops below 1.
const tiny = await zoomWith(200, 900);
check(zoomedTo(tiny) === 1, "dsh-zoom: the cap never forces the page below 100%", String(zoomedTo(tiny)));

// The shell mounts its sidebar after this script runs, so the first measurement
// answers with the fallback; the level must be re-clamped once it appears, or a
// saved 300% would survive a reload uncapped.
const late = await bootPanel("dsh-zoom", { innerHeight: 900, level: 3, mount: false });
check(zoomedTo(late) === expectedCap(900, 360), "dsh-zoom: before the sidebar exists the stock floor caps", String(zoomedTo(late)));
late.dom.sidebarRequired = 450;
late.sandbox.sidebarAppeared?.();
check(
	zoomedTo(late) === expectedCap(900, 450),
	"dsh-zoom: a sidebar that mounts late is measured and the level re-clamped",
	`${zoomedTo(late)} vs ${expectedCap(900, 450)}`
);

const tallWindow = await zoomWith(4000, 360);
check(
	zoomedTo(tallWindow) === 3,
	"dsh-zoom: a tall window leaves the saved level alone",
	String(zoomedTo(tallWindow))
);
check(
	!textOf(tallWindow.host).includes("已按窗口高度封顶"),
	"dsh-zoom: no ceiling note when the window is not the limit",
	""
);

// Shrinking the window after zooming in is the other way to end up stranded, so
// the resize handler re-applies the level through the clamp.
check(
	(tallWindow.listeners.resize ?? []).length === 1,
	"dsh-zoom: listens for a window resize",
	String((tallWindow.listeners.resize ?? []).length)
);
tallWindow.sandbox.innerHeight = 500;
for (const handler of tallWindow.listeners.resize ?? []) handler();
check(
	zoomedTo(tallWindow) === expectedCap(500, 360),
	"dsh-zoom: shrinking the window pulls the level back inside the new ceiling",
	`${zoomedTo(tallWindow)} vs ${expectedCap(500, 360)}`
);

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
