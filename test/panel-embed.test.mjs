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
			patchPath: "cordis.patch.yml", sessions: 0, platform: "win32", arch: "x64"
		},
		lines: [], source: "events", path: "events.log"
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
		addEventListener() {},
		execCommand: () => true
	};
	return { Node, makeNode, body, document };
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
async function bootPanel(pkg, { hub = true, mount = true } = {}) {
	const dom = makeDom();
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		Node: dom.Node,
		document: dom.document,
		navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: async (url) => {
			const path = String(url);
			if (path.includes("/dsh-features/api/status")) {
				if (!hub) throw new Error("no hub");
				return { ok: true, status: 200, json: async () => ({ ok: true, hub: "dsh-features" }) };
			}
			const payload = { ok: true, ...PAYLOADS[pkg] };
			if (path.includes("/api/logs") || path.includes("/diagnostics")) return { ok: true, status: 200, json: async () => payload };
			return { ok: true, status: 200, json: async () => payload };
		}
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(join(root, "packages", pkg, "assets", "panel.js"), "utf8"), sandbox, { filename: `${pkg}/panel.js` });
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
	return { sandbox, dom, host, keys };
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
	const panel = readFileSync(join(root, "packages", pkg, "assets", "panel.js"), "utf8");
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
const stripSource = readFileSync(join(root, "packages", "dsh-features", "assets", "client.js"), "utf8");
check(stripSource.includes("function stripDuplicateRefresh(node)"), "dsh-features: the hub sweeps a mounted panel for a duplicate refresh", "");
check(stripSource.includes('new Set(["刷新", "Refresh"])'), "dsh-features: the sweep knows both refresh labels", "");
check(stripSource.includes("[data-dsh-refresh]"), "dsh-features: a marked refresh is hidden by the skin too", "");

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
