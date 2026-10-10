/**
 * Checks for dsh-features: the installed-feature inventory, the host half's two
 * routes, and the browser half.
 *
 * The browser half runs here for real — the bundle is plain script and only
 * touches `window`, `document`, `navigator` and `fetch`, so it is evaluated in a
 * vm with small stubs plus a minimal React (element objects, state, effects,
 * refs). That is what lets this suite assert the things that otherwise only show
 * up in a browser: the sidebar entry's slot, id and order, the skin, the tab
 * order, and that the page hands a registered feature a node it owns.
 *
 * Run from the repository root or the package directory:
 *   node test/hub.test.mjs
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { readInventory } from "../lib/inventory.js";
import { resolveLayout } from "../lib/layout.js";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/* ------------------------------------------------------------- inventory */

const root = await mkdtemp(join(tmpdir(), "dsh-features-"));
const pluginsDir = join(root, "profiles", "plugins");
const profileDir = join(root, "profiles", "desktop");
const nodeModules = join(profileDir, "node_modules");

const writePackage = async (dir, name, manifest) => {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", ...manifest }), "utf8");
};

await writePackage(join(pluginsDir, "dsh-doctor"), "dsh-doctor", {
	dsh: { ui: { feature: { key: "doctor", order: 30, title: { zh: "诊断", en: "Doctor" }, summary: { zh: "运行状态", en: "Status" } } } }
});
// Installed by `dsh plugin add`: lands in the profile's node_modules instead.
await writePackage(join(nodeModules, "dsh-mcp"), "dsh-mcp", {
	dsh: { ui: { feature: { key: "mcp", order: 20, title: { en: "MCP" } } } }
});
// No marker, a broken manifest, a foreign package and a keyless marker: skipped.
await writePackage(join(pluginsDir, "dsh-plain"), "dsh-plain", {});
await mkdir(join(pluginsDir, "dsh-broken"), { recursive: true });
await writeFile(join(pluginsDir, "dsh-broken", "package.json"), "{ not json", "utf8");
await writePackage(join(pluginsDir, "other-tool"), "other-tool", { dsh: { ui: { feature: { key: "other" } } } });
await writePackage(join(pluginsDir, "dsh-keyless"), "dsh-keyless", { dsh: { ui: { feature: { order: 1 } } } });
// A string title is fine, a non-numeric order falls back, junk titles are dropped.
await writePackage(join(pluginsDir, "dsh-odd"), "dsh-odd", {
	dsh: { ui: { feature: { key: "odd", order: "high", title: "Odd", summary: { note: "nope" } } } }
});
// A marked package in the staging directory that the profile never declared. It is
// not installed, so it must not be reported: a stray copy there used to surface on
// the hub page as "installed, but its panel did not load".
await writePackage(join(pluginsDir, "dsh-stray"), "dsh-stray", {
	dsh: { ui: { feature: { key: "stray", order: 5, title: { zh: "暂存", en: "Stray" } } } }
});

// The profile's own manifest is the source of truth for "installed".
await writeFile(join(profileDir, "package.json"), JSON.stringify({
	name: "dsh-profile-desktop",
	private: true,
	dependencies: {
		"dsh-doctor": "github:LBurny/dsh-plugin#path:/packages/dsh-doctor",
		"dsh-mcp": "link:C:/elsewhere/dsh-mcp",
		"dsh-odd": "link:C:/elsewhere/dsh-odd"
	},
	dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-odd"] } }
}), "utf8");

const layout = resolveLayout({ documentPath: join(profileDir, "cordis.patch.yml") });
check(layout.profileName === "desktop", "the layout derives the profile name from the patch document", layout.profileName);
check(layout.pluginsDir === pluginsDir, "the layout points at the plugins directory", layout.pluginsDir);

const inventory = await readInventory(layout);
const keys = inventory.map((item) => item.key);
check(keys.join(",") === "mcp,doctor,odd", "only marked packages are inventoried, ordered by their order", keys.join(","));
check(inventory[1].package === "dsh-doctor" && inventory[1].version === "1.2.3", "an entry carries the package name and version", JSON.stringify(inventory[1]));
check(inventory[1].title.zh === "诊断" && inventory[1].title.en === "Doctor", "a bilingual title survives as a pair", JSON.stringify(inventory[1].title));
check(inventory[0].title.en === "MCP", "a one-language title survives", JSON.stringify(inventory[0].title));
check(inventory[2].order === 100, "a non-numeric order falls back to the default", String(inventory[2].order));
check(inventory[2].title === "Odd", "a plain string title survives", JSON.stringify(inventory[2].title));
check(inventory[2].summary === undefined, "a title-shaped value with no zh/en is dropped", JSON.stringify(inventory[2].summary));

const emptyRoot = await readInventory({ pluginsDir: join(root, "absent"), profileDir: join(root, "absent-profile") });
check(emptyRoot.length === 0, "missing directories degrade to an empty inventory", JSON.stringify(emptyRoot));

// The profile does not declare dsh-stray, so being on disk does not count.
check(!keys.includes("stray"), "a staged copy the profile never declared is not reported as installed", keys.join(","));

// A symlinked package is a package: that is how pnpm links an installed plugin.
try {
	await symlink(join(pluginsDir, "dsh-doctor"), join(nodeModules, "dsh-doctor"), "junction");
	const both = await readInventory(layout);
	check(both.length === 3, "a symlinked copy of the same key does not duplicate an entry", String(both.length));
} catch {
	check(true, "symlink case skipped (the platform refused to create one)");
}
await rm(root, { recursive: true, force: true });

/* ------------------------------------------------------------ host routes */

const { apply: applyHost, inject: hostInject, name: hostName } = await import("../index.js");
check(hostName === "features", "the host half exports the short row name", hostName);
check(Array.isArray(hostInject) && hostInject.length === 0, "the host half needs no service before apply", JSON.stringify(hostInject));

/** Boot the host half against a fake ctx and capture the route it registers. */
function bootHost({ withConfigEditor = true } = {}) {
	const registered = [];
	const logs = [];
	const services = { webServer: { register: (route) => registered.push(route) } };
	if (withConfigEditor) services.configEditor = { documentPath: join(profileDir, "cordis.patch.yml") };
	const ctx = {
		logger: { info: (line) => logs.push(line) },
		get: (key) => services[key],
		inject(list, callback) {
			if (list.includes("webServer") && services.webServer !== undefined) callback({ webServer: services.webServer, effect: (fn) => fn() });
		}
	};
	applyHost(ctx);
	return { registered, logs };
}

/** Call a captured prefix route with a fake request/response pair. */
async function call(route, path, method = "GET") {
	const answer = { status: 0, body: "" };
	const res = {
		headersSent: false,
		writeHead(status) {
			answer.status = status;
			this.headersSent = true;
		},
		end(body) {
			answer.body = body ?? "";
		}
	};
	await route.handler({ method, url: path }, res);
	return { ...answer, json: answer.body === "" ? undefined : JSON.parse(answer.body) };
}

const host = bootHost();
check(host.registered.length === 1, "the host half registers exactly one route prefix", String(host.registered.length));
const route = host.registered[0];
check(route.kind === "prefix" && route.path === "/dsh-features", "the route owns /dsh-features", `${route.kind} ${route.path}`);

const status = await call(route, "/dsh-features/api/status");
check(status.status === 200 && status.json.ok === true, "the probe route answers ok", JSON.stringify(status.json));
check(status.json.hub === "dsh-features", "the probe names the hub, so a feature knows who answered", String(status.json.hub));
const features = await call(route, "/dsh-features/api/features");
check(features.status === 200 && features.json.ok === true, "the inventory route answers ok", String(features.status));
check(features.json.source === join(root, "profiles", "plugins"), "the inventory reports where it looked", String(features.json.source).replace(root, "<root>"));
const missing = await call(route, "/dsh-features/nope");
check(missing.status === 404 && missing.json.ok === false, "an unknown path is a JSON 404", JSON.stringify(missing.json));
check((await call(route, "/dsh-features/api/status", "POST")).status === 404, "a wrong method does not answer the route");

const degraded = await call(bootHost({ withConfigEditor: false }).registered[0], "/dsh-features/api/features");
check(degraded.status === 200 && degraded.json.features.length === 0, "without a config-editor service the inventory degrades instead of failing", JSON.stringify(degraded.json));

/* --------------------------------------------------------- browser half */

const bundle = readFileSync(join(here, "..", "assets", "client.js"), "utf8");

/** A localStorage stand-in: Map-backed, inspectable, shareable between browsers. */
function makeStorage() {
	const data = new Map();
	return {
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => void data.set(key, String(value)),
		removeItem: (key) => void data.delete(key),
		dump: () => Object.fromEntries(data)
	};
}

/**
 * One browser's worth of stubs: element objects plus state/effect/ref slots, a
 * document whose created nodes record what is appended to them, and a `fetch`.
 * A `ref` in `createElement` is bound to a stub node right there, which is what
 * React does for real and what the page's mount effect depends on.
 */
function createBrowser({ language = "zh-CN", registry, fetchImpl, storage = makeStorage() }) {
	let hooks = [];
	let cursor = 0;
	let dirty = false;
	const effects = [];
	const created = [];
	const observers = [];
	/** Tell every live MutationObserver, the way a real DOM would. */
	const mutate = () => {
		for (const observer of [...observers]) observer.callback();
	};
	const makeNode = (tag) => {
		const node = {
			tag: tag ?? "div",
			className: "",
			id: undefined,
			textContent: "",
			attrs: {},
			children: [],
			parent: undefined,
			append(...added) {
				for (const child of added) {
					if (child === undefined || child === null || child === false) continue;
					child.parent = node;
					node.children.push(child);
				}
				mutate();
			},
			replaceChildren(...next) {
				node.children = [];
				node.append(...next);
			},
			remove() {
				const at = node.parent?.children.indexOf(node) ?? -1;
				if (at !== -1) node.parent.children.splice(at, 1);
				node.parent = undefined;
				mutate();
			},
			setAttribute(key, value) {
				node.attrs[key] = String(value);
			},
			hasAttribute: (key) => Object.hasOwn(node.attrs, key),
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
		};
		created.push(node);
		return node;
	};
	/** The only DOM global the hub itself uses: it watches a mounted panel. */
	class MutationObserver {
		constructor(callback) {
			this.callback = callback;
		}
		observe() {
			observers.push(this);
		}
		disconnect() {
			const at = observers.indexOf(this);
			if (at !== -1) observers.splice(at, 1);
		}
	}
	const styles = [];
	const document = {
		head: { append: (node) => styles.push(node) },
		getElementById: (id) => styles.find((node) => node.id === id) ?? null,
		createElement: (tag) => makeNode(tag)
	};
	const React = {
		createElement(type, config, ...children) {
			const element = { type, props: { ...config, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) } };
			if (config?.ref !== undefined && config.ref.current === null) config.ref.current = makeNode("ref");
			return element;
		},
		useState(initial) {
			const slot = cursor++;
			if (hooks[slot] === undefined) hooks[slot] = typeof initial === "function" ? initial() : initial;
			const set = (next) => {
				const value = typeof next === "function" ? next(hooks[slot]) : next;
				if (value === hooks[slot]) return;
				hooks[slot] = value;
				dirty = true;
			};
			return [hooks[slot], set];
		},
		useEffect(fn, deps) {
			const slot = cursor++;
			const previous = effects[slot];
			const changed = previous === undefined || deps === undefined || deps.some((value, index) => value !== previous.deps?.[index]);
			effects[slot] = { fn, deps, changed };
		},
		useRef(value) {
			const slot = cursor++;
			if (hooks[slot] === undefined) hooks[slot] = { current: value ?? null };
			return hooks[slot];
		}
	};

	const registrations = [];
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		navigator: { language },
		document,
		fetch: fetchImpl,
		localStorage: storage,
		MutationObserver,
		__dshFeatures: registry,
		__ModuleLoader__: { load: (registration) => registrations.push(registration) }
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(bundle, sandbox, { filename: "dsh-features/assets/client.js" });

	/** Render (repeatedly, while state changes), then run the changed effects. */
	const render = async (Component, props) => {
		let element;
		let guard = 0;
		do {
			dirty = false;
			cursor = 0;
			element = Component(props);
			for (const effect of effects) if (effect?.changed) effect.fn();
			await new Promise((resolve) => setTimeout(resolve, 5));
		} while (dirty && ++guard < 6);
		return element;
	};

	/** Collect what `apply` registers on a fake client ctx. */
	const wire = (registration) => {
		const slots = [];
		const dictionaries = [];
		const ctx = {
			effect: (fn) => fn(),
			locale: {
				register: (ns, dict) => dictionaries.push({ ns, dict }),
				bind: (ns) => {
					const dict = dictionaries.find((item) => item.ns === ns)?.dict;
					return (key) => dict?.[language.startsWith("zh") ? "zh" : "en"]?.[key] ?? key;
				}
			},
			slots: {
				inject: (slot, factory) => slots.push({ slot, ...factory() }),
				// The real `register` returns a dispose function; the test only needs
				// what was registered.
				register: (options, component) => ({ options, component })
			}
		};
		const exports = registration.factory((specifier) => {
			if (specifier === "react") return React;
			throw new Error(`unexpected require("${specifier}")`);
		});
		exports.apply(ctx);
		return { exports, slots, dictionaries };
	};

	return { React, document, styles, created, registrations, render, wire, makeNode, storage };
}

/** Find every rendered node a predicate accepts. */
function findAll(element, predicate, found = []) {
	if (element === null || typeof element !== "object") return found;
	if (predicate(element)) found.push(element);
	for (const child of element.props?.children ?? []) findAll(child, predicate, found);
	return found;
}

const browser = createBrowser({
	registry: {
		doctor: { title: "诊断", order: 30, icon: "M-doctor", mount: (host) => browser.mounted.push({ key: "doctor", host }) },
		mcp: { title: "MCP", order: 20, icon: "M-mcp", mount: (host) => browser.mounted.push({ key: "mcp", host }) }
	},
	fetchImpl: async () => ({
		json: async () => ({
			ok: true,
			features: [
				{ key: "doctor", order: 30, package: "dsh-doctor", title: { zh: "诊断", en: "Doctor" } },
				{ key: "mcp", order: 20, package: "dsh-mcp", title: { zh: "MCP", en: "MCP" } },
				{ key: "skills", order: 10, package: "dsh-skills", title: { zh: "技能", en: "Skills" }, summary: { zh: "管理技能", en: "Managed skills" } }
			]
		})
	})
});
browser.mounted = [];

check(browser.registrations.length === 1, "the bundle registers itself exactly once", String(browser.registrations.length));
check(browser.registrations[0].id === "dsh-features", "the bundle registers under the package name (the loader checks this)", String(browser.registrations[0].id));

// Materializing the factory is what injects the skin — the module system does
// this for every boot-graph row, so the dock is hidden for the whole page.
const wired = browser.wire(browser.registrations[0]);
check(browser.styles.length === 1, "the bundle injects its skin", String(browser.styles.length));
check(browser.styles[0].id === "dsh-features-skin", "the skin carries an id, so a reload cannot double it", String(browser.styles[0].id));
check(/display:\s*none\s*!important/u.test(browser.styles[0].textContent), "the skin hides the corner launcher dock", browser.styles[0].textContent.slice(0, 48).trim());

check(wired.exports.inject?.join(",") === "slots,locale", "the client half declares the services it needs", JSON.stringify(wired.exports.inject));
check(wired.dictionaries.length === 1 && wired.dictionaries[0].ns === "features", "the dictionary is registered under its namespace", JSON.stringify(wired.dictionaries.map((item) => item.ns)));
check(wired.dictionaries[0].dict.zh.panel === "功能管理" && wired.dictionaries[0].dict.en.panel === "Features", "the dictionary is bilingual", JSON.stringify([wired.dictionaries[0].dict.zh.panel, wired.dictionaries[0].dict.en.panel]));

const sidebar = wired.slots.find((item) => item.slot === "sidebar.panellist");
const main = wired.slots.find((item) => item.slot === "main");
check(sidebar?.options.id === "features", "the sidebar entry registers the shared panel id", JSON.stringify(sidebar?.options));
check(sidebar.options.order === 5, "the sidebar entry sits between 插件 (0) and 自动化任务 (10)", String(sidebar.options.order));
check(sidebar.options.label() === "功能管理", "the sidebar label comes from the dictionary", sidebar.options.label());
check(typeof sidebar.component === "function", "the sidebar entry ships its own glyph component", typeof sidebar.component);
check(main?.options.key === "features", "the page registers under the same id, so selectPanel finds it", JSON.stringify(main?.options));

/* --------------------------------------------------------------- the page */

const T = (key) => ({
	panel: "功能管理",
	subtitle: "统一入口",
	loading: "加载中…",
	refresh: "刷新",
	back: "返回",
	dragHint: "拖拽调整顺序",
	empty: "没有检测到功能插件。",
	emptyHint: "安装任意 dsh-* 功能插件。",
	unloaded: "已安装，但它的面板脚本没有加载。",
	failed: "面板加载失败"
})[key] ?? key;

let element = await browser.render(main.component, { t: T });
/** The row for one feature, in the list view. */
const rows = () => findAll(element, (node) => node.props?.className === "row");
const rowName = (row) => row.props.children[1]?.props.children[0]?.props.children?.join("") ?? "";
const rowNames = () => rows().map(rowName).join(",");
/** The glyph path a row leads with: row > tile span > svg > path. */
const rowGlyph = (row) => row.props.children[0]?.props.children[0]?.props.children[0]?.props.d;
const rowNote = (row) => row.props.children[1]?.props.children[1]?.props.children?.join("") ?? "";
const endPad = () => findAll(element, (node) => node.props?.className === "list-end")[0];
const headRefresh = () => findAll(element, (node) => node.props?.["aria-label"] === T("refresh"));
const headBack = () => findAll(element, (node) => node.props?.["aria-label"] === T("back"));
const stage = () => findAll(element, (node) => node.props?.className === "stage")[0];
const stageHost = () => findAll(element, (node) => node.props?.ref !== undefined)[0]?.props.ref.current;

check(rows().length === 3, "a row per feature: two registered plus one installed-only", String(rows().length));
check(rowNames() === "技能,MCP,诊断", "rows follow the default order", rowNames());
check(rows().every((row) => row.props.draggable === true), "every row is draggable", "");
check(rowGlyph(rows()[1]) === "M-mcp", "a registered icon leads its row", String(rowGlyph(rows()[1])));
check(rowGlyph(rows()[0]) === "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z", "an iconless feature gets the fallback grid", String(rowGlyph(rows()[0])));
check(rowNote(rows()[0]) === "管理技能", "a row carries the feature's own summary from the inventory", rowNote(rows()[0]));
check(rows()[0].props.children[2]?.props.children[0]?.props.children[0]?.props.d === "M6.2 3.6L10.6 8l-4.4 4.4", "a row ends in a chevron, so it reads as clickable", String(rows()[0].props.children[2]?.props.children[0]?.props.children?.[0]?.props.d));
check(endPad() !== undefined, "the list ends in a drop pad for move-to-last", "");
check(browser.mounted.length === 0, "the list view mounts nothing (a panel is opened, not shown by default)", String(browser.mounted.length));
check(headBack().length === 0, "the list view has no back control", String(headBack().length));
check(headRefresh().length === 1, "the list view has exactly one refresh control", String(headRefresh().length));
check(stage().props["data-view"] === "list", "the stage knows it is showing the list", String(stage().props["data-view"]));

// Opening a row is the whole interaction: it drills into that feature.
rows()[1].props.onClick();
element = await browser.render(main.component, { t: T });
check(browser.mounted.at(-1)?.key === "mcp", "clicking a row opens that feature's settings", String(browser.mounted.at(-1)?.key));
check(headBack().length === 1, "the detail view offers a way back", String(headBack().length));
check(headRefresh().length === 1, "the detail view still has exactly one refresh control", String(headRefresh().length));
check(stage().props["data-view"] === "feature", "the stage switches to the feature view", String(stage().props["data-view"]));
check(findAll(element, (node) => node.props?.className === "rows").length === 0, "the list is gone while a feature is open", "");
const title = findAll(element, (node) => node.props?.className === "line")[0];
console.log('DEBUG line children:', title.props.children.map((c) => JSON.stringify([c?.props?.className, c?.props?.children])).join(' | '));
check(title?.props.children[0]?.props.children?.join("") === "MCP", "the head names the open feature", String(title?.props.children[0]?.props.children));
check(title?.props.children[1]?.props.children?.join("") === "dsh-mcp", "the head names the package it came from", String(title?.props.children[1]?.props.children));

// Going back returns to the list, with every feature still on it.
headBack()[0].props.onClick();
element = await browser.render(main.component, { t: T });
check(rows().length === 3 && stage().props["data-view"] === "list", "back returns to the list", `${rows().length} rows, ${stage().props["data-view"]}`);
check(rowNames() === "技能,MCP,诊断", "the list still holds every feature", rowNames());

// An installed-only feature opens to an explanation, not to an empty page.
// 技能 is the one the profile declares but whose browser half never registered.
rows()[0].props.onClick();
element = await browser.render(main.component, { t: T });
check(stageHost().children[0]?.textContent === T("unloaded"), "an installed-only feature explains itself in place", String(stageHost().children[0]?.textContent));
headBack()[0].props.onClick();
element = await browser.render(main.component, { t: T });

// Dragging a row onto another moves it in front of the target, persists the
// order, and never opens anything.
const dragEvent = { dataTransfer: { setData() {}, effectAllowed: "" } };
rows()[0].props.onDragStart(dragEvent);
rows()[2].props.onDragOver({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(rows()[2].props["data-drop"] === "true", "the row under the cursor is marked as the drop target", String(rows()[2].props["data-drop"]));
rows()[2].props.onDrop({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(rowNames() === "MCP,技能,诊断", "dropping moves the row in front of its target", rowNames());
check(stage().props["data-view"] === "list", "reordering stays in the list view", String(stage().props["data-view"]));
const saved = JSON.parse(browser.storage.dump()["dsh-features:nav-order"] ?? "[]");
check(saved.join(",") === "mcp,skills,doctor", "the dragged order lands in localStorage", saved.join(","));

// The end pad accepts move-to-last.
rows()[0].props.onDragStart(dragEvent);
endPad().props.onDragOver({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(endPad().props["data-drop"] === "true", "the end pad marks itself as the drop target", String(endPad().props["data-drop"]));
endPad().props.onDrop({ preventDefault() {} });
element = await browser.render(main.component, { t: T });
check(rowNames() === "技能,诊断,MCP", "dropping on the end pad moves the row last", rowNames());

/* ------------------------------------------------ the embedded refresh sweep */

/**
 * A feature whose body renders a bare 刷新 button, the way a panel build older
 * than the hub's cooperation would. The page must not end up showing two.
 */
const sweeper = createBrowser({
	registry: {
		stale: {
			title: "陈旧",
			order: 1,
			mount: (host) => {
				// Late, like a real panel: its body lands after its own fetch resolves.
				setTimeout(() => {
					const button = sweeper.document.createElement("button");
					button.textContent = "刷新";
					host.append(button);
				}, 0);
			}
		},
		marked: {
			title: "标记",
			order: 2,
			mount: (host) => {
				const button = sweeper.document.createElement("button");
				button.setAttribute("data-dsh-refresh", "");
				host.append(button);
			}
		}
	},
	fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) })
});
const sweeperWired = sweeper.wire(sweeper.registrations[0]);
const sweeperPage = sweeperWired.slots.find((item) => item.slot === "main").component;
let swept = await sweeper.render(sweeperPage, { t: T });
findAll(swept, (node) => node.props?.className === "row")[0].props.onClick();
swept = await sweeper.render(sweeperPage, { t: T });
await new Promise((resolve) => setTimeout(resolve, 5));
const sweptHost = findAll(swept, (node) => node.props?.ref !== undefined)[0].props.ref.current;
console.log('DEBUG sweep children:', sweptHost.children.length, JSON.stringify(sweptHost.children.map((c) => c.tag + ":" + c.textContent)));
check(sweptHost.children.length === 0, "a panel's bare refresh button is swept out of the mount point", String(sweptHost.children.length));
check(
	findAll(swept, (node) => node.props?.["aria-label"] === T("refresh")).length === 1,
	"the sweep leaves the page's own refresh alone",
	String(findAll(swept, (node) => node.props?.["aria-label"] === T("refresh")).length)
);

// A marked control is dropped as soon as it appears, even synchronously. Back to
// the list first: the open feature is what the page is showing.
findAll(swept, (node) => node.props?.["aria-label"] === T("back"))[0].props.onClick();
swept = await sweeper.render(sweeperPage, { t: T });
findAll(swept, (node) => node.props?.className === "row")[1].props.onClick();
swept = await sweeper.render(sweeperPage, { t: T });
const markedHost = findAll(swept, (node) => node.props?.ref !== undefined)[0].props.ref.current;
check(markedHost.children.length === 0, "a marked refresh control never survives either", String(markedHost.children.length));

// A feature that throws is reported on the page, not into the console.
const broken = createBrowser({
	registry: { boom: { title: "Boom", order: 1, mount: () => { throw new Error("nope"); } } },
	fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) })
});
const brokenWired = broken.wire(broken.registrations[0]);
let brokenElement = await broken.render(brokenWired.slots.find((item) => item.slot === "main").component, { t: T });
findAll(brokenElement, (node) => node.props?.className === "row")[0].props.onClick();
brokenElement = await broken.render(brokenWired.slots.find((item) => item.slot === "main").component, { t: T });
const brokenHost = findAll(brokenElement, (node) => node.props?.ref !== undefined)[0].props.ref.current;
check(brokenHost.children[0]?.textContent === `${T("failed")}: nope`, "a throwing feature is reported in place", brokenHost.children[0]?.textContent);

/* ------------------------------------------------------------------ empty */

const empty = createBrowser({ language: "en", registry: {}, fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) }) });
const emptyWired = empty.wire(empty.registrations[0]);
const emptyElement = await empty.render(emptyWired.slots.find((item) => item.slot === "main").component, { t: (key) => `en:${key}` });
check(findAll(emptyElement, (node) => node.props?.className === "rows").length === 0, "an empty inventory renders no list");
check(findAll(emptyElement, (node) => node.props?.className === "empty").length === 1, "an empty inventory renders the hint block");
check(findAll(emptyElement, (node) => node.props?.["aria-label"] === "en:refresh").length === 1, "an empty inventory keeps its one refresh, so the list can be rescanned");
check(emptyWired.dictionaries[0].dict.en.panel === "Features", "the English dictionary is registered too", emptyWired.dictionaries[0].dict.en.panel);
check(emptyWired.slots.find((item) => item.slot === "sidebar.panellist").options.label() === "Features", "the sidebar label follows the language");

// An unreachable inventory costs only the hint: the registry still drives the page.
const offline = createBrowser({
	registry: { doctor: { title: "Doctor", order: 1, mount: () => {} } },
	fetchImpl: async () => {
		throw new Error("offline");
	}
});
const offlineWired = offline.wire(offline.registrations[0]);
const offlineElement = await offline.render(offlineWired.slots.find((item) => item.slot === "main").component, { t: T });
check(offlineWired.slots.length === 2, "a failing inventory request still registers both slots", String(offlineWired.slots.length));
check(
	findAll(offlineElement, (node) => node.props?.className === "row").length === 1,
	"the page still lists what the registry registered",
	String(findAll(offlineElement, (node) => node.props?.className === "row").length)
);

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
