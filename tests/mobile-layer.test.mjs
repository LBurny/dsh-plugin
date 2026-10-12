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

/** `[class*="_x"]` substring matching, plain `[data-x]` presence, and `*` — all the layer asks. */
function matches(node, part) {
	if (part === "*") return true;
	const substring = /\[class\*="([^"]+)"\]/u.exec(part);
	if (substring !== null) return node.className.includes(substring[1]);
	const present = /^\[([a-zA-Z-]+)\]$/u.exec(part);
	return present !== null && node.hasAttribute(present[1]);
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
		documentElement: { lang, hasAttribute: () => false, setAttribute() {} },
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
function run(sheet) {
	const sandbox = {
		document: sheet.document,
		location: { href: "http://phone.test:29274/", pathname: "/", search: "", hash: "" },
		// The layer's other modules touch the viewport and the media query; the sandbox has
		// to answer them, or the script dies before the settings branch is ever reached.
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
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
		documentElement: { lang, hasAttribute: () => false, setAttribute() {} },
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

/* ------------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nMOBILE LAYER TEST PASS (${results.length} checks)` : `\nMOBILE LAYER TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
