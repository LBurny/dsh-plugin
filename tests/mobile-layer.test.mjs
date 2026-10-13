/**
 * Repository-wide checks for the remote mobile layer's phone-only DOM behaviour.
 *
 * `dsh-remote/lib/assets/mobile.js` is injected into dsh's own page by the proxy, so no
 * package suite could evaluate it: `dsh-remote`'s own suite asserts only that the text is
 * there, and the interesting part is what it does to the DOM. It is run here for real in a
 * small DOM stub — a settings sheet from a remote origin, where upstream fails the models
 * page with `settings are unavailable in this browser` and offers a Retry that cannot work.
 *
 * Run from the repository root:
 *   node tests/mobile-layer.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });
const source = readFileSync(join(root, "dsh-remote", "lib", "assets", "mobile.js"), "utf8");

/** One stub element: only what the layer's settings branch touches. */
function element(tag, className = "", text = "") {
	const node = {
		tag,
		className,
		attrs: {},
		children: [],
		parent: undefined,
		/** Both spellings exist in a real DOM, and the layer walks up with `parentElement`. */
		get parentElement() {
			return node.parent;
		},
		/** The layer matches on a subtree's text, so this must aggregate like a real DOM. */
		own: text,
		get textContent() {
			return node.children.map((child) => child.textContent).join("") + node.own;
		},
		set textContent(value) {
			node.own = String(value);
			node.children = [];
		},
		setAttribute(key, value) {
			node.attrs[key] = String(value);
		},
		getAttribute: (key) => node.attrs[key],
		hasAttribute: (key) => Object.hasOwn(node.attrs, key),
		querySelector: (selector) => querySelector(node, selector),
		querySelectorAll: (selector) => querySelectorAll(node, selector),
		append(...added) {
			for (const child of added) {
				child.parent = node;
				node.children.push(child);
			}
		},
		removeAttribute(key) {
			delete node.attrs[key];
		},
		replaceChildren(...next) {
			for (const child of node.children) child.parent = undefined;
			node.children = [];
			node.append(...next);
		},
		insertAdjacentElement(position, inserted) {
			const at = node.parent.children.indexOf(node);
			node.parent.children.splice(position === "afterend" ? at + 1 : at, 0, inserted);
			inserted.parent = node.parent;
			return inserted;
		},
		/** The conversation path appends, inserts before a sibling, and walks up with `closest`. */
		appendChild(child) {
			node.append(child);
			return child;
		},
		insertBefore(child, before) {
			child.parent = node;
			const at = before === undefined || before === null ? -1 : node.children.indexOf(before);
			if (at === -1) node.children.push(child);
			else node.children.splice(at, 0, child);
			return child;
		},
		closest(selector) {
			for (let current = node; current !== undefined; current = current.parent) {
				if (matches(current, selector)) return current;
			}
			return null;
		},
		/** Click listeners are recorded, so a test can fire the control the way a tap does. */
		listeners: {},
		addEventListener(type, handler) {
			(node.listeners[type] ??= []).push(handler);
		},
		removeEventListener(type, handler) {
			const list = node.listeners[type];
			if (list === undefined) return;
			const at = list.indexOf(handler);
			if (at !== -1) list.splice(at, 1);
		},
		fire(type) {
			for (const handler of node.listeners[type] ?? []) handler({ target: node });
		},
		/** The tab-strip fit writes its factor here (`style.setProperty`). */
		style: {
			props: {},
			setProperty(key, value) {
				this.props[key] = String(value);
			},
			getPropertyValue(key) {
				return this.props[key] ?? "";
			},
			removeProperty(key) {
				delete this.props[key];
			}
		}
	};
	return node;
}

/** `[class*="_x"]` substring matching, `[data-x]` presence, `[k="v"]` equality, a tag name, `*`. */
function matches(node, part) {
	if (part === "*") return true;
	const substring = /\[class\*="([^"]+)"\]/u.exec(part);
	if (substring !== null) return node.className.includes(substring[1]);
	const equality = /^\[([a-zA-Z-]+)="([^"]*)"\]$/u.exec(part);
	if (equality !== null) return node.getAttribute(equality[1]) === equality[2];
	const present = /^\[([a-zA-Z-]+)\]$/u.exec(part);
	if (present !== null) return node.hasAttribute(present[1]);
	return node.tag === part;
}
const descendants = (node, parts) => {
	let level = [node];
	for (const part of parts) {
		const next = [];
		for (const current of level) {
			const walk = (parent) => {
				for (const child of parent.children) {
					if (matches(child, part)) next.push(child);
					walk(child);
				}
			};
			walk(current);
		}
		level = next;
	}
	return level;
};
/** A real DOM answers `null`, not `undefined`, and the layer compares against `null`. */
const querySelector = (node, selector) => descendants(node, selector.trim().split(/\s+/u))[0] ?? null;
const querySelectorAll = (node, selector) => descendants(node, selector.trim().split(/\s+/u));

/**
 * Build a settings sheet: content > options > card(errorText, retry). `withFailure`
 * decides whether the card carries upstream's wording at all.
 */
function makeSheet({ lang = "zh", withFailure = true } = {}) {
	const overlay = element("div", "wCInkW_overlay");
	const panel = element("div", "wCInkW_panel");
	const content = element("div", "wCInkW_content");
	const options = element("div", "wCInkW_options");
	const card = element("div", "css-card");
	const text = element("span", "css-error", withFailure ? "加载提供商目录失败: settings are unavailable in this browser" : "填入各提供商的 API 密钥即可使用其模型。");
	const retry = element("button", "css-retry", "重试");
	card.append(text, retry);
	options.append(card);
	content.append(options);
	panel.append(content);
	overlay.append(panel);
	const body = element("body", "");
	body.append(overlay);
	const document = {
		// A real element, not an attribute-less stub: the layer writes and removes the enhanced
		// flag on it, and a stub that cannot remove would abort the whole tab branch silently.
		documentElement: Object.assign(element("html", ""), { lang }),
		body,
		querySelector: (selector) => querySelector(body, selector),
		querySelectorAll: (selector) => querySelectorAll(body, selector),
		getElementById: () => undefined,
		addEventListener() {},
		removeEventListener() {},
		createElement: (tag) => element(tag, "")
	};
	return { body, overlay, panel, content, options, card, text, retry, document };
}

/** Run the layer's real source against a stub sheet. */
function run(sheet, { narrow = false } = {}) {
	// The layer follows the phone breakpoint, so the stub has to be flippable the way a
	// rotation is; `set` notifies the listeners the layer registered.
	const mq = {
		matches: narrow,
		handlers: [],
		addEventListener(type, handler) {
			if (type === "change") mq.handlers.push(handler);
		},
		removeEventListener(type, handler) {
			const at = mq.handlers.indexOf(handler);
			if (at !== -1) mq.handlers.splice(at, 1);
		},
		set(value) {
			mq.matches = value;
			for (const handler of [...mq.handlers]) handler();
		}
	};
	const sandbox = {
		document: sheet.document,
		location: { href: "http://phone.test:29274/", pathname: "/", search: "", hash: "" },
		// The layer's other modules touch the viewport and the media query; the sandbox has
		// to answer them, or the script dies before the settings branch is ever reached.
		matchMedia: () => mq,
		visualViewport: { addEventListener() {}, removeEventListener() {}, offsetTop: 0 },
		scrollTo() {},
		innerHeight: 844,
		innerWidth: 390,
		MutationObserver: class {
			constructor(callback) {
				this.callback = callback;
			}

			observe() {}

			disconnect() {}
		},
		// The tab-strip fit measures the nav's content box and writes its factor before the
		// next frame; a synchronous frame callback runs the whole thing inside `run`.
		getComputedStyle: (node) => ({
			paddingLeft: `${node.padding ?? 8}px`,
			paddingRight: `${node.padding ?? 8}px`
		}),
		requestAnimationFrame: (callback) => {
			callback();
			return 0;
		},
		window: {},
		setTimeout,
		clearTimeout
	};
	sandbox.mq = mq;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "mobile.js" });
	return sandbox;
}

/**
 * A settings sheet with the top tab strip: panel > nav > navList > four cells. The widths are
 * the real ones (13px, padding 8px, icon gap 4px: 88/62/88/100 = 338 layout px) and
 * `navWidth` is what the phone's layout gives the nav (390 at zoom 1, 342 at the owner's
 * zoom 1.14, 316 on a 360px phone at 1.14).
 */
function makeTabbedSheet({ lang = "zh", cells = [88, 62, 88, 100], navWidth = 390, pad = 8, listBox } = {}) {
	const overlay = element("div", "wCInkW_overlay");
	const panel = element("div", "wCInkW_panel");
	const nav = element("div", "wCInkW_nav");
	const list = element("div", "wCInkW_navList");
	for (const width of cells) {
		const cell = element("div", "wCInkW_navCell", "标签");
		cell.offsetWidth = width;
		list.append(cell);
	}
	// `listBox` emulates the nowrap list being stretched to its content: the fit must not
	// read this one, or it measures its own effect and flips back to wrapping.
	list.clientWidth = listBox ?? navWidth - pad * 2;
	nav.padding = pad;
	nav.clientWidth = navWidth;
	nav.append(list);
	panel.append(nav);
	overlay.append(panel);
	const body = element("body", "");
	body.append(overlay);
	const document = {
		documentElement: Object.assign(element("html", ""), { lang }),
		body,
		querySelector: (selector) => querySelector(body, selector),
		querySelectorAll: (selector) => querySelectorAll(body, selector),
		getElementById: () => undefined,
		addEventListener() {},
		removeEventListener() {},
		createElement: (tag) => element(tag, "")
	};
	return { body, overlay, panel, nav, list, document };
}

/**
 * A conversation view: `chatRoot > header > tablist` with the two native tabs, plus the
 * composer stats row the info panel clones. Only the shapes the tab branch matches on.
 */
function makeConversation() {
	const chatRoot = element("div", "Ab12_root");
	const header = element("header", "");
	const tablist = element("div", "Ab12_tabs");
	tablist.setAttribute("role", "tablist");
	const chat = element("button", "Ab12_tab Ab12_tabActive", "对话");
	chat.setAttribute("role", "tab");
	const trace = element("button", "Ab12_tab", "轨迹");
	trace.setAttribute("role", "tab");
	tablist.append(chat, trace);
	header.append(tablist);
	const dock = element("div", "");
	dock.setAttribute("data-slot", "conversation.composer.dock");
	const stats = element("div", "");
	stats.setAttribute("data-composer-stats", "");
	dock.append(stats);
	chatRoot.append(header, dock);
	const body = element("body", "");
	body.append(chatRoot);
	const document = {
		documentElement: Object.assign(element("html", ""), { lang: "zh-CN" }),
		body,
		querySelector: (selector) => querySelector(body, selector),
		querySelectorAll: (selector) => querySelectorAll(body, selector),
		getElementById: () => undefined,
		addEventListener() {},
		removeEventListener() {},
		createElement: (tag) => element(tag, "")
	};
	return { body, chatRoot, header, tablist, chat, trace, stats, document };
}


/* ------------------------------------------------------------------ the checks */

{
	const sheet = makeSheet();
	run(sheet);
	const note = sheet.card.getAttribute("data-dshmobile-unavailable");
	check(
		note !== undefined,
		"the failed-catalog card carries the replacement wording as an attribute",
		JSON.stringify(sheet.card.attrs)
	);
	check(
		sheet.options.children.length === 1,
		"nothing is inserted into the scroller — React owns that subtree and never removes a foreign node",
		String(sheet.options.children.length)
	);
	check(
		note !== undefined && note.includes("电脑端"),
		"the Chinese wording says which window can actually change it",
		note ?? ""
	);
}

{
	// An English page must not be answered in Chinese.
	const sheet = makeSheet({ lang: "en" });
	run(sheet);
	const note = sheet.card.getAttribute("data-dshmobile-unavailable");
	check(
		note !== undefined && /desktop window/u.test(note) && !/[\u4e00-\u9fff]/u.test(note),
		"an English page gets the English wording",
		note ?? ""
	);
}

{
	// Switching to another settings section replaces the options' subtree. The mark must go
	// with it — a stale one shows the note over a healthy page, which is what made every
	// section look like it had not switched.
	const sheet = makeSheet();
	run(sheet);
	sheet.options.replaceChildren(element("div", "css-other", "填入各提供商的 API 密钥即可使用其模型。"));
	run(sheet);
	check(
		sheet.options.querySelector("[data-dshmobile-unavailable]") === null,
		"switching sections leaves no stale mark behind",
		JSON.stringify(sheet.options.children.map((child) => child.attrs))
	);
	// ...and coming back re-marks the fresh card.
	const back = makeSheet();
	run(back);
	run(back);
	check(
		back.card.getAttribute("data-dshmobile-unavailable") !== undefined,
		"a second run against the same card is idempotent (one mark, not a stack)",
		JSON.stringify(back.card.attrs)
	);
}

{
	// The healthy case: a loopback page reads settings fine, so nothing may be touched.
	const sheet = makeSheet({ withFailure: false });
	const before = sheet.options.children.length;
	run(sheet);
	check(
		sheet.options.children.length === before && sheet.card.hasAttribute("data-dshmobile-unavailable") === false,
		"a sheet that loads its providers is left completely alone",
		String(sheet.options.children.length)
	);
}

/* ------------------------------------------------ the settings tab strip's one-row fit */

{
	// 390px phone at the owner's zoom 1.14: the four labels need 338 layout px and the nav has
	// 342 - 16 = 326, so upstream's centred wrap used to fire and show "three tabs + one
	// centred underneath". The strip fits by itself once shrunk a hair.
	const sheet = makeTabbedSheet({ navWidth: 342 });
	run(sheet);
	const scale = Number(sheet.nav.style.getPropertyValue("--dshmobile-tab-scale"));
	check(
		sheet.nav.hasAttribute("data-dshmobile-tabfit") && Math.abs(scale - 326 / 338) < 0.001,
		"a strip 12px too wide is shrunk to one row instead of wrapping",
		`fit=${sheet.nav.hasAttribute("data-dshmobile-tabfit")} scale=${scale.toFixed(4)}`
	);
}

{
	// Same sheet, but the list box has already been stretched to its content by `nowrap`.
	// Measuring that box would read 338 of 338 and undo the fit on the next mutation, so the
	// factor must come from the nav's own content box.
	const sheet = makeTabbedSheet({ navWidth: 342, listBox: 338 });
	run(sheet);
	const scale = Number(sheet.nav.style.getPropertyValue("--dshmobile-tab-scale"));
	check(
		sheet.nav.hasAttribute("data-dshmobile-tabfit") && Math.abs(scale - 326 / 338) < 0.001,
		"the factor comes from the nav's content box, not from the list the fit itself stretched",
		`scale=${scale.toFixed(4)}`
	);
}

{
	// 390px at zoom 1: 338 of 374 fits already, and the strip must be left exactly as it was.
	const wide = makeTabbedSheet({ navWidth: 390 });
	run(wide);
	check(
		wide.nav.hasAttribute("data-dshmobile-tabfit") === false &&
			wide.nav.style.getPropertyValue("--dshmobile-tab-scale") === "",
		"a strip that already fits one row keeps its untouched metrics",
		`attrs=${JSON.stringify(wide.nav.attrs)}`
	);
}

{
	// A 320px phone at zoom 1.36 leaves 219px: shrinking to that would undo the zoom the
	// reader chose, so the CSS wrap stays in charge (two centred rows, original type size).
	const tiny = makeTabbedSheet({ navWidth: 235 });
	run(tiny);
	check(
		tiny.nav.hasAttribute("data-dshmobile-tabfit") === false &&
			tiny.nav.style.getPropertyValue("--dshmobile-tab-scale") === "",
		"a layout too narrow to shave leaves the centred wrap in charge",
		`scale=${tiny.nav.style.getPropertyValue("--dshmobile-tab-scale")}`
	);
}

/* ----------------------------------------- the tab strip follows the phone breakpoint */

// 信息 is a narrow-only panel, but the flag that de-emphasises the native active tab (so the
// panel can own the accent) lives outside the media query, because 项目 is width-unrestricted
// and needs it at any width. Rotating away with the info panel open used to leave that flag
// behind: CSS hid the panel while 对话 stayed grey, so the strip showed no selected tab at all
// until the reader tapped one. Measured on the real page at 844x390 before the fix.
{
	const view = makeConversation();
	const sandbox = run(view, { narrow: true });
	const infoTab = view.tablist.querySelector("[data-dshmobile-tab]");
	check(
		infoTab !== null && view.tablist.querySelector("[data-dshmobile-project-tab]") !== null,
		"the layer mounts its 项目 and 信息 tabs on the strip",
		String(view.tablist.children.length)
	);
	check(
		view.tablist.children.length === 4 && view.tablist.children[2].hasAttribute("data-dshmobile-project-tab"),
		"the order stays 对话/轨迹/项目/信息",
		view.tablist.children.map((child) => child.textContent).join(",")
	);

	infoTab.fire("click");
	check(
		view.chatRoot.hasAttribute("data-dshmobile-info-open") && view.tablist.hasAttribute("data-dshmobile-open") && infoTab.hasAttribute("data-active"),
		"opening 信息 marks the panel and the strip",
		JSON.stringify({ root: view.chatRoot.attrs, strip: view.tablist.attrs })
	);

	sandbox.mq.set(false);
	check(
		!view.chatRoot.hasAttribute("data-dshmobile-info-open") && !view.tablist.hasAttribute("data-dshmobile-open") && !infoTab.hasAttribute("data-active"),
		"leaving the narrow layout retracts 信息's flag, so the native active tab keeps its highlight",
		JSON.stringify({ root: view.chatRoot.attrs, strip: view.tablist.attrs })
	);
	sandbox.mq.set(true);
	check(!view.chatRoot.hasAttribute("data-dshmobile-info-open"), "rotating back does not resurrect the panel", JSON.stringify(view.chatRoot.attrs));
}

{
	// 项目 works at any width, so its panel and flag have to survive the rotation: the panel
	// still covers the content, which is exactly when greying the native tab is right.
	const view = makeConversation();
	const sandbox = run(view, { narrow: true });
	view.tablist.querySelector("[data-dshmobile-project-tab]").fire("click");
	sandbox.mq.set(false);
	check(
		view.chatRoot.hasAttribute("data-dshmobile-project-open") && view.tablist.hasAttribute("data-dshmobile-open"),
		"a 项目 panel open in portrait is kept through the rotation",
		JSON.stringify({ root: view.chatRoot.attrs, strip: view.tablist.attrs })
	);
}

{
	// The plugin page's head rules are the one block in mobile.css that was silently dead:
	// they hung off `html[data-dshmobile-enhanced]`, and mobile.js only sets that marker on the
	// conversation page (setupInfo, when the 信息 tab mounts). The plugins page is not in a
	// session, so the marker never appears there and the whole block stopped applying: at 390px
	// the Add plugin button was squeezed to 85px with `white-space: normal`, its text wrapped to
	// two lines and bled out of a 32px pill (scrollHeight 36). The narrow media query is the gate
	// these rules need, exactly like the settings sheet and sidebar-drawer rules beside them.
	// A CSS-only fix is invisible to the DOM stub above, so this is a source-level assertion.
	const stylesheet = readFileSync(join(root, "dsh-remote", "lib", "assets", "mobile.css"), "utf8")
		.replace(/\/\*[\s\S]*?\*\//gu, "");
	const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
		selector: match[1].trim(),
		body: match[2].replace(/\s+/gu, " ").trim()
	}));
	const pluginRules = rules.filter((rule) => rule.selector.includes("data-plugin-panel"));
	check(pluginRules.length >= 4, "the plugin page head carries its phone rules", `${pluginRules.length} rule(s)`);
	check(
		pluginRules.every((rule) => !rule.selector.includes("data-dshmobile-enhanced")),
		"none of them is gated on data-dshmobile-enhanced, which only the conversation page gets",
		pluginRules.filter((rule) => rule.selector.includes("data-dshmobile-enhanced")).map((rule) => rule.selector).join(" | ")
	);
	const addRules = pluginRules.filter((rule) => rule.selector.includes("_addButton"));
	check(
		addRules.length > 0 && addRules.every((rule) => rule.body.includes("white-space: nowrap")),
		"the Add plugin button is pinned to one line inside its pill",
		addRules.map((rule) => rule.body).join(" | ")
	);
}

/* ------------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nMOBILE LAYER TEST PASS (${results.length} checks)` : `\nMOBILE LAYER TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
