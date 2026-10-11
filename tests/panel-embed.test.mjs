/**
 * Repository-wide checks for the feature panels' second contract: what a panel
 * does when the 功能管理 hub is installed.
 *
 * The hub page mounts a panel inline and owns the only refresh control, so an
 * embedded panel must not dock its floating corner button and must not add a
 * second refresh button. That behaviour lives in each panel's browser script,
 * which no package's own suite evaluates, so it is asserted here by running the
 * real `assets/client.js` of every feature in a small DOM stub.
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
			capture: { attached: true, boot: 12, records: 2, bytes: 4096 }
		},
		records: [
			{ sn: 1, ts: 1700000000000, name: "loader", type: "info", level: 1, text: "apply plugin dsh-doctor" },
			{ sn: 2, ts: 1700000001000, name: "doctor", type: "warn", level: 2, text: "panel served" }
		],
		source: "capture", reset: true, files: [], retention: { bytes: 4 * 1024 * 1024 }
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
				approval: { enabled: true, timing: "always" }, question: { enabled: true, timing: "always" },
				turn_done: { enabled: true, timing: "background" }, answer_done: { enabled: true, timing: "background" },
				sound: "staplebops-02", volume: 0.7, toast: true, browser: true
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
			// Recorded rather than ignored: a panel announcing itself through a class
			// (`attention` on the corner button) has no other observable effect.
			classes: [],
			classList: {
				add(name) {
					if (!node.classes.includes(String(name))) node.classes.push(String(name));
				},
				remove(name) {
					const at = node.classes.indexOf(String(name));
					if (at !== -1) node.classes.splice(at, 1);
				}
			},
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
		// A reminder may be deferred to the background, so the stub has to answer the two
		// questions the client asks about focus: is the page hidden, and does it hold focus.
		hidden: false,
		focused: true,
		hasFocus: () => document.focused !== false,
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
 * that sees it must stay out of the way of the hub page. `payload` replaces the
 * default route body, and `timers` collects the delays a panel schedules instead of
 * running them, which is how the "is it still asking for more?" question is asked.
 * `notifications` adds the media and push globals a reminder panel needs and records
 * what it does with them; without it a panel boots the way a shell lacking them does.
 * @returns the booted panel with its sandbox, the DOM stub and the mount point.
 */
async function bootPanel(pkg, { hub = true, mount = true, innerHeight = 900, sidebarRequired, level, payload: body, timers, notifications } = {}) {
	const dom = makeDom();
	dom.sidebarRequired = sidebarRequired;
	// Window listeners are recorded so a test can fire them the way the browser does.
	const listeners = {};
	const sandbox = {
		console,
		setTimeout: timers === undefined ? setTimeout : (fn, delay) => {
			timers.push(delay);
			return 0;
		},
		clearTimeout,
		Node: dom.Node,
		innerHeight,
		addEventListener(event, handler) {
			(listeners[event] ??= []).push(handler);
		},
		// A real window can focus itself (which a page may only do for a window the OS has
		// already focused); it is recorded so a click's browser-side half is observable.
		focus() {
			sandbox.focusCalls = (sandbox.focusCalls ?? 0) + 1;
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
			// `payload` may be a function of the requested path, which is how a test changes
			// what the host answers between two calls (a settings edit made from another page)
			// without handing the panel the very object it already holds.
			const served = typeof body === "function" ? body(path) : body ?? PAYLOADS[pkg];
			const payload = { ok: true, ...served };
			if (level !== undefined && payload.config !== undefined) payload.config = { ...payload.config, level };
			return { ok: true, status: 200, json: async () => payload };
		}
	};
	// A reminder panel is the one client whose whole job is a side effect, so its sound and
	// its system notification are what a test has to look at. Both are recorded rather than
	// performed, and the stream keeps its own instance so a test can push a frame the way
	// the host does. `played` holds the sound URLs and `audios` the players themselves, so a
	// test can read back the volume the panel set; `permission` stands in for the browser's
	// own grant, which a reader can refuse.
	if (notifications !== undefined) {
		sandbox.Audio = class {
			constructor() {
				this.src = "";
				this.volume = 1;
				(notifications.audios ??= []).push(this);
			}
			play() {
				notifications.played.push(this.src);
				return Promise.resolve();
			}
		};
		sandbox.Notification = class {
			constructor(title, options) {
				notifications.shown.push({ title, ...options });
				// The instance itself is kept too: a panel hangs `onclick` on it, and a click is
				// a side effect that has to be observable (it asks the host to raise the window).
				(notifications.notices ??= []).push(this);
				this.title = title;
			}
			static permission = notifications.permission ?? "granted";
			static requestPermission() {
				return Promise.resolve("granted");
			}
		};
		sandbox.EventSource = class {
			constructor(url) {
				this.url = url;
				notifications.source = this;
			}
			close() {}
			push(item) {
				this.onmessage?.({ data: JSON.stringify(item) });
			}
		};
	}
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
	return { sandbox, dom, host, keys, listeners, timers };
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

/* ------------------- dsh-doctor: the capture window is stated, not left to guess */

// "47 records" invites the question of whether that is everything or a trimmed tail, so the
// panel repeats the memory the host is holding them in, and the line window it paints itself.
const doctorLogs = await bootPanel("dsh-doctor");
check(
	textOf(doctorLogs.host).includes("保留窗口 4 MB / 显示最近 2000 条记录"),
	"dsh-doctor: the log view states the retention budget the host reported",
	textOf(doctorLogs.host).slice(0, 200)
);

/* ------------- dsh-notify: one reminder makes exactly one sound */

// A system notification has a sound of its own on Windows, so a panel that plays its own
// .wav has to silence the notification, or the reader hears both at once. The two cases are
// the two halves of the sound choice: a plugin file, and "system default", which is the one
// that means "let the OS make the noise".
const notifyPayload = {
	config: {
		approval: { enabled: true, timing: "always" }, question: { enabled: true, timing: "always" },
		turn_done: { enabled: true, timing: "always" }, answer_done: { enabled: true, timing: "always" },
		sound: "staplebops-02", volume: 0.7, toast: true, browser: true
	},
	sounds: ["staplebops-02"], configPath: "cordis.patch.yml"
};

const withSound = { played: [], shown: [] };
const reminded = await bootPanel("dsh-notify", { payload: notifyPayload, notifications: withSound });
withSound.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	withSound.played.length === 1 && withSound.shown.length === 1,
	"dsh-notify: a reminder plays the chosen sound and raises exactly one notification",
	`played=${withSound.played.join(",") || "none"} shown=${String(withSound.shown.length)}`
);
check(
	withSound.shown[0]?.silent === true,
	"dsh-notify: the system notification stays silent while the panel plays its own sound",
	JSON.stringify(withSound.shown[0] ?? null)
);

const withDefault = { played: [], shown: [] };
await bootPanel("dsh-notify", {
	payload: { ...notifyPayload, config: { ...notifyPayload.config, sound: "default" } },
	notifications: withDefault
});
withDefault.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	withDefault.played.length === 0 && withDefault.shown[0]?.silent === false,
	"dsh-notify: system default hands the sound to the OS and plays nothing itself",
	`played=${String(withDefault.played.length)} silent=${String(withDefault.shown[0]?.silent)}`
);

/* ------------- dsh-notify: which reminders are allowed to make themselves known */

// Every reminder is gated twice: its own rule (on/off plus a timing) and then, when the
// timing defers to it, the page's focus state. The four kinds do not ship alike: the two
// that block the agent notify always, and the two completion kinds defer to the
// background. The matrix below pins all 24 cells: four kinds, two timings, three focus
// states, and the whole answer to "I turned a reminder on and nothing happened" is in it.

const KINDS = ["approval", "question", "turn_done", "answer_done"];
/** The four states a page can be in when a reminder arrives, as the browser reports them. */
const FOCUS = ["focused", "unfocused", "hidden"];

/** A config giving every kind the same timing. */
const timedConfig = (timing) =>
	Object.assign({}, notifyPayload.config, ...KINDS.map((kind) => ({ [kind]: { enabled: true, timing } })));

/** The panel's toast stack, wherever it was mounted. */
const toastsOf = (dom, host) => [...descendants(host), ...descendants(dom.body)].find((node) => node.className === "toasts");

/**
 * Deliver all four kinds to a panel sitting in one focus state, and report which of them
 * were raised. Each frame carries its own kind as its text, so the titles of the raised
 * notifications name the winners.
 * @returns the booted panel and the raised kinds.
 */
async function raisedFrom(timing, state) {
	const seen = { played: [], shown: [] };
	const panel = await bootPanel("dsh-notify", {
		payload: { ...notifyPayload, config: timedConfig(timing) },
		notifications: seen
	});
	panel.dom.document.hidden = state === "hidden";
	panel.dom.document.focused = state === "focused";
	for (const kind of KINDS) seen.source?.push({ kind, text: kind });
	return { panel, seen, raised: seen.shown.map((notice) => String(notice.title)) };
}

const ALL_KINDS = KINDS.join(",");
for (const [timing, expected] of [
	["always", { focused: ALL_KINDS, unfocused: ALL_KINDS, hidden: ALL_KINDS }],
	["background", { focused: "", unfocused: ALL_KINDS, hidden: ALL_KINDS }]
]) {
	for (const state of FOCUS) {
		const { raised } = await raisedFrom(timing, state);
		check(
			raised.join(",") === expected[state],
			`dsh-notify: timing=${timing} with the page ${state} raises ${expected[state] === "" ? "no kind" : "all four kinds"}`,
			raised.join(",") || "(nothing)"
		);
	}
}

// The popup is gated by the same rule, so the quiet case is quiet through every channel: a
// reminder that arrives while the reader is looking at the window leaves no trace at all.
const popupQuiet = await raisedFrom("background", "focused");
const popupLoud = await raisedFrom("always", "focused");
check(
	(toastsOf(popupQuiet.panel.dom, popupQuiet.panel.host)?.children ?? []).length === 0,
	"dsh-notify: the popup stays away too, not just the notification and the sound",
	String((toastsOf(popupQuiet.panel.dom, popupQuiet.panel.host)?.children ?? []).length)
);
check(
	(toastsOf(popupLoud.panel.dom, popupLoud.panel.host)?.children ?? []).length === KINDS.length,
	"dsh-notify: timing=always pops one in-page reminder per kind",
	String((toastsOf(popupLoud.panel.dom, popupLoud.panel.host)?.children ?? []).length)
);

// The shipped default, whole: an approval raised while the reader is looking at the window
// now makes itself known, and a finished turn still waits for the background. This is the
// report that produced the split, so it is pinned as the default and not as a matrix cell.
const shipped = { played: [], shown: [] };
const withDefaults = await bootPanel("dsh-notify", { notifications: shipped });
shipped.source?.push({ kind: "approval", text: "waiting for your approval" });
shipped.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	shipped.shown.length === 1 && shipped.played.length === 1 && shipped.shown[0]?.title === "waiting for your approval",
	"dsh-notify: by default an approval rings even on a focused page, and a finished turn stays quiet",
	`shown=${shipped.shown.map((notice) => String(notice.title)).join(",") || "(nothing)"} played=${String(shipped.played.length)}`
);

/* ------------- dsh-notify: a settings change made elsewhere reaches the page */

// The settings are a file on the host, so a page that cached them at boot is wrong the moment
// they change somewhere else: the phone writes the same file, and so does anyone editing it by
// hand. Without a refresh the page keeps judging reminders by the old rules for its whole life,
// which is how "I set it and it still did not ring" happens. The host answers a fresh object per
// call here, so only a real re-read can pick the change up.
const quietRule = { ...notifyPayload, config: { ...notifyPayload.config, question: { enabled: true, timing: "background" } } };
let servedSettings = quietRule;
const page = { played: [], shown: [] };
const stalePage = await bootPanel("dsh-notify", { payload: () => servedSettings, notifications: page });
page.source?.push({ kind: "question", text: "before the change" });
const beforeRefresh = page.played.length;
servedSettings = { ...quietRule, config: { ...quietRule.config, question: { enabled: true, timing: "always" } } };
for (const handler of stalePage.listeners.focus ?? []) handler();
await new Promise((resolve) => setTimeout(resolve, 30));
page.source?.push({ kind: "question", text: "after the change" });
check(
	beforeRefresh === 0 && page.played.length === 1,
	"dsh-notify: settings changed elsewhere reach this page when it comes back to the front",
	`before=${String(beforeRefresh)} after=${String(page.played.length)}`
);

/* ------------- dsh-notify: what a click on the reminder is worth */

// A reminder that cannot take the reader to the thing it is about is half a reminder, and the
// page cannot do it alone: `window.focus()` is a no-op for a window the OS has not focused, and
// the desktop app exposes no IPC that raises it. So the click also asks the host half, which is
// a child of the process owning the window. The stub here records the routes a panel calls.
const clicks = { played: [], shown: [] };
const called = [];
const clickable = await bootPanel("dsh-notify", {
	payload: (path) => {
		called.push(path);
		return notifyPayload;
	},
	notifications: clicks
});
clicks.source?.push({ kind: "turn_done", text: "the turn finished" });
clicks.notices?.[0]?.onclick?.();
await new Promise((resolve) => setTimeout(resolve, 30));
check(
	clickable.sandbox.focusCalls === 1 && called.some((path) => path.endsWith("/dsh-notify/api/focus")),
	"dsh-notify: clicking the reminder focuses the page and asks the host half to raise the window",
	`window.focus()x${String(clickable.sandbox.focusCalls ?? 0)} routes ${called.filter((path) => path.includes("/api/")).join(",") || "(none)"}`
);

/* ------------- dsh-notify: what a raised reminder then does */

// Past the gate the three channels are independent switches: the sound, the popup and the
// system notification. The sound choice then decides one more thing, whether the system
// notification may ring on top of it, which is the double-sound fix.

const sw = { played: [], shown: [] };
await bootPanel("dsh-notify", { payload: notifyPayload, notifications: sw });
sw.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	String(sw.played[0]).endsWith("/sounds/staplebops-02.wav"),
	"dsh-notify: the chosen sound is fetched from this package's own route",
	sw.played.join(",") || "(nothing played)"
);
check(
	sw.audios?.[0]?.volume === notifyPayload.config.volume,
	"dsh-notify: the player carries the configured volume",
	String(sw.audios?.[0]?.volume)
);
check(
	sw.shown[0]?.tag === "dsh-notify-turn_done",
	"dsh-notify: each kind carries its own tag, so a newer one replaces the older",
	String(sw.shown[0]?.tag)
);

const swOff = { played: [], shown: [] };
const panelOff = await bootPanel("dsh-notify", {
	payload: { ...notifyPayload, config: { ...notifyPayload.config, toast: false } },
	notifications: swOff
});
swOff.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	swOff.shown.length === 1 && swOff.played.length === 1 && (toastsOf(panelOff.dom, panelOff.host)?.children ?? []).length === 0,
	"dsh-notify: with the popup switched off the sound and the notification still fire",
	`played=${String(swOff.played.length)} shown=${String(swOff.shown.length)} popups=${String((toastsOf(panelOff.dom, panelOff.host)?.children ?? []).length)}`
);

const swNoBrowser = { played: [], shown: [] };
await bootPanel("dsh-notify", {
	payload: { ...notifyPayload, config: { ...notifyPayload.config, browser: false } },
	notifications: swNoBrowser
});
swNoBrowser.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	swNoBrowser.shown.length === 0 && swNoBrowser.played.length === 1,
	"dsh-notify: with the system notification switched off the sound still fires",
	`played=${String(swNoBrowser.played.length)} shown=${String(swNoBrowser.shown.length)}`
);

const swDenied = { played: [], shown: [], permission: "denied" };
await bootPanel("dsh-notify", { payload: notifyPayload, notifications: swDenied });
swDenied.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	swDenied.shown.length === 0 && swDenied.played.length === 1,
	"dsh-notify: a refused notification permission costs the toast, never the sound",
	`played=${String(swDenied.played.length)} shown=${String(swDenied.shown.length)}`
);

const swSilent = { played: [], shown: [] };
await bootPanel("dsh-notify", {
	payload: { ...notifyPayload, config: { ...notifyPayload.config, sound: "silent" } },
	notifications: swSilent
});
swSilent.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	swSilent.played.length === 0 && swSilent.shown[0]?.silent === true,
	"dsh-notify: a silent sound setting plays nothing and keeps the notification silent",
	`played=${String(swSilent.played.length)} silent=${String(swSilent.shown[0]?.silent)}`
);

// A switched-off kind is silent whatever the page is doing; the second frame proves the
// panel was live and only the rule was refusing.
const swOffKind = { played: [], shown: [] };
await bootPanel("dsh-notify", {
	payload: { ...notifyPayload, config: { ...notifyPayload.config, question: { enabled: false, timing: "always" } } },
	notifications: swOffKind
});
swOffKind.source?.push({ kind: "question", text: "switched off" });
const afterOffKind = swOffKind.shown.length;
swOffKind.source?.push({ kind: "turn_done", text: "still switched on" });
check(
	afterOffKind === 0 && swOffKind.shown.length === 1,
	"dsh-notify: a switched-off kind raises nothing while its neighbours still do",
	`off=${String(afterOffKind)} on=${String(swOffKind.shown.length)}`
);

// A record with no kind is the host's own bookkeeping; it must never be raised.
const swKindless = { played: [], shown: [] };
await bootPanel("dsh-notify", { payload: notifyPayload, notifications: swKindless });
swKindless.source?.push({ text: "no kind on this one" });
const afterKindless = swKindless.shown.length;
swKindless.source?.push({ kind: "turn_done", text: "the turn finished" });
check(
	afterKindless === 0 && swKindless.shown.length === 1,
	"dsh-notify: a frame naming no kind is not a reminder",
	`kindless=${String(afterKindless)} real=${String(swKindless.shown.length)}`
);

// With no hub the panel is a floating one, closed until its corner button is clicked, so a
// reminder has to say where to look. The payload here gives every kind `timing: always`,
// which is the shipped default for the two blocking kinds; a completion kind left on its own
// default would be quiet on a page that has focus and the pulse would never happen.
const floated = { played: [], shown: [] };
const floating = await bootPanel("dsh-notify", { hub: false, mount: false, payload: notifyPayload, notifications: floated });
floated.source?.push({ kind: "turn_done", text: "the turn finished" });
const corner = descendants(floating.dom.body).find((node) => node.className === "dsh-launch");
check(
	corner !== undefined && corner.classes.includes("attention"),
	"dsh-notify: a reminder pulses the closed panel's corner button",
	corner === undefined
		? "(no corner button)"
		: `classes=${corner.classes.join(",") || "(none)"} played=${String(floated.played.length)} shown=${String(floated.shown.length)}`
);

/* ------------------------- dsh-remote: a link that arrives after "enable" */

// `enable` answers as soon as the proxy is listening, while in tunnel mode the link
// exists only once cloudflared has reported its hostname, seconds later. The manager
// already reads "up" by then, so a panel that waited on that state name alone showed
// no link and no QR until the page was remounted. It has to keep asking until it holds
// a link, and stop asking once it does.
const waitingPayload = {
	remote: {
		state: "up", enabled: true, mode: "tunnel", proxyPort: 29274,
		tunnel: { state: "starting", url: "", error: undefined }, lanUrls: []
	},
	qrAvailable: true, qrPath: "/dsh-remote/qr.svg", cloudflared: "C:/tools/cloudflared.exe"
};
const waiting = await bootPanel("dsh-remote", { payload: waitingPayload, timers: [] });
check(
	waiting.timers.includes(2000),
	"dsh-remote: an enabled panel with no link yet keeps asking for one",
	waiting.timers.join(",") || "(nothing scheduled)"
);
check(
	!textOf(waiting.host).includes("[object Object]"),
	"dsh-remote: the waiting status row shows the tunnel state, never its handle",
	textOf(waiting.host).slice(0, 140)
);

const linkedPayload = {
	remote: {
		state: "up", enabled: true, mode: "tunnel", proxyPort: 29274,
		link: "https://x-y-z.trycloudflare.com/?token=abc", resumed: false,
		tunnel: { state: "up", url: "https://x-y-z.trycloudflare.com", error: undefined }, lanUrls: []
	},
	qrAvailable: true, qrPath: "/dsh-remote/qr.svg", cloudflared: "C:/tools/cloudflared.exe"
};
const linked = await bootPanel("dsh-remote", { payload: linkedPayload, timers: [] });
check(
	!linked.timers.includes(2000),
	"dsh-remote: a panel that has its link stops asking",
	linked.timers.join(",") || "(nothing scheduled)"
);
// The QR is what the reader is actually waiting for, so it is asserted by tag rather
// than by the surrounding sentence.
check(
	descendants(linked.host).some((child) => child.tag === "img"),
	"dsh-remote: the QR is painted as soon as the link is there",
	descendants(linked.host).map((child) => child.tag).join(",")
);
check(
	!descendants(waiting.host).some((child) => child.tag === "img"),
	"dsh-remote: no QR is painted before the link exists",
	""
);
check(
	textOf(linked.host).includes("tunnel: up"),
	"dsh-remote: the tunnel state reaches the status row",
	textOf(linked.host).slice(0, 160)
);
check(
	!textOf(linked.host).includes("[object Object]"),
	"dsh-remote: an up tunnel is not stringified as an object",
	textOf(linked.host).slice(0, 160)
);

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
