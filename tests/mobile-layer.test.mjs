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
		insertAdjacentElement(position, inserted) {
			const at = node.parent.children.indexOf(node);
			node.parent.children.splice(position === "afterend" ? at + 1 : at, 0, inserted);
			inserted.parent = node.parent;
			return inserted;
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
const querySelector = (node, selector) => descendants(node, selector.trim().split(/\s+/u))[0];
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
		window: {},
		setTimeout,
		clearTimeout
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "mobile.js" });
	return sandbox;
}

const noteIn = (sheet) => sheet.options.children.find((child) => Object.hasOwn(child.attrs, "data-dshmobile-unavailable"));

/* ------------------------------------------------------------------ the checks */

{
	const sheet = makeSheet();
	run(sheet);
	const note = noteIn(sheet);
	check(
		sheet.card.hasAttribute("data-dshmobile-unavailable-card"),
		"upstream's failed-catalog card is marked so the stylesheet hides it (Retry and all)",
		JSON.stringify(sheet.card.attrs)
	);
	check(note !== undefined, "a note takes its place in the same scroller", String(sheet.options.children.length));
	check(
		note !== undefined && sheet.options.children.indexOf(note) === sheet.options.children.indexOf(sheet.card) + 1,
		"the note sits directly after the card it replaces, not at the panel's foot",
		""
	);
	check(
		note !== undefined && note.textContent.includes("电脑端"),
		"the Chinese note says which window can actually change it",
		note === undefined ? "" : note.textContent
	);
}

{
	// An English page must not be answered in Chinese.
	const sheet = makeSheet({ lang: "en" });
	run(sheet);
	const note = noteIn(sheet);
	check(
		note !== undefined && /desktop window/u.test(note.textContent) && !/[\u4e00-\u9fff]/u.test(note.textContent),
		"an English page gets the English note",
		note === undefined ? "" : note.textContent
	);
}

{
	// Two copies of the layer live in the page during a live preview (the proxy's and an
	// injected one): the second must not stack a second note.
	const sheet = makeSheet();
	run(sheet);
	run(sheet);
	const notes = sheet.options.children.filter((child) => Object.hasOwn(child.attrs, "data-dshmobile-unavailable")).length;
	check(notes === 1, "running the layer twice still leaves exactly one note", String(notes));
}

{
	// The healthy case: a loopback page reads settings fine, so nothing may be touched.
	const sheet = makeSheet({ withFailure: false });
	const before = sheet.options.children.length;
	run(sheet);
	check(
		sheet.options.children.length === before && sheet.card.hasAttribute("data-dshmobile-unavailable-card") === false,
		"a sheet that loads its providers is left completely alone",
		String(sheet.options.children.length)
	);
}

/* ------------------------------------------------------------------- reporting */

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nMOBILE LAYER TEST PASS (${results.length} checks)` : `\nMOBILE LAYER TEST FAIL (${failed.length}/${results.length})`);
if (failed.length > 0) process.exitCode = 1;
