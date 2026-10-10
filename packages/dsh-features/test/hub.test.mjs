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

/**
 * One browser's worth of stubs: element objects plus state/effect/ref slots, a
 * document whose created nodes record what is appended to them, and a `fetch`.
 * A `ref` in `createElement` is bound to a stub node right there, which is what
 * React does for real and what the page's mount effect depends on.
 */
function createBrowser({ language = "zh-CN", registry, fetchImpl }) {
	let hooks = [];
	let cursor = 0;
	let dirty = false;
	const effects = [];
	const created = [];
	const makeNode = (tag) => {
		const node = {
			tag: tag ?? "div",
			className: "",
			id: undefined,
			textContent: "",
			children: [],
			append(...added) {
				node.children.push(...added);
			},
			replaceChildren(...next) {
				node.children = [...next];
			}
		};
		created.push(node);
		return node;
	};
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

	return { React, document, styles, created, registrations, render, wire, makeNode };
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
		doctor: { title: "诊断", order: 30, mount: (host) => browser.mounted.push({ key: "doctor", host }) },
		mcp: { title: "MCP", order: 20, mount: (host) => browser.mounted.push({ key: "mcp", host }) }
	},
	fetchImpl: async () => ({
		json: async () => ({
			ok: true,
			features: [
				{ key: "doctor", order: 30, package: "dsh-doctor", title: { zh: "诊断", en: "Doctor" } },
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
	empty: "没有检测到功能插件。",
	emptyHint: "安装任意 dsh-* 功能插件。",
	unloaded: "已安装，但它的面板脚本没有加载。",
	failed: "面板加载失败"
})[key] ?? key;

let element = await browser.render(main.component, { t: T });
const tabs = () => findAll(element, (node) => node.props?.className === "tab");
check(tabs().length === 3, "a tab per feature: two registered plus one installed-only", String(tabs().length));
check(tabs().map((tab) => tab.props.children).join(",") === "技能,MCP,诊断", "tabs are ordered by the feature's own order", tabs().map((tab) => tab.props.children).join(","));
check(tabs()[0].props["data-active"] === "true", "the first tab is selected by default", String(tabs()[0].props["data-active"]));

const stageHost = findAll(element, (node) => node.props?.ref !== undefined)[0].props.ref.current;
check(stageHost !== undefined && typeof stageHost.append === "function", "the stage owns a node it can hand to a feature", typeof stageHost?.append);
check(browser.mounted.length === 0, "an installed-only feature is not mounted (it registered no mount)", String(browser.mounted.length));
check(stageHost.children[0]?.textContent === T("unloaded"), "an installed-only feature is named on the page instead of silently missing", stageHost.children[0]?.textContent);
check(findAll(element, (node) => node.props?.className === "stage-title")[0].props.children.join("") === "技能", "the stage header names the selected feature");

// Selecting a registered feature mounts it, into the node the page owns.
tabs()[1].props.onClick();
element = await browser.render(main.component, { t: T });
check(browser.mounted.at(-1).key === "mcp", "switching tabs mounts that feature", browser.mounted.at(-1).key);
check(browser.mounted.at(-1).host === stageHost, "the feature is handed the stage's own node", String(browser.mounted.at(-1).host === stageHost));
check(stageHost.children.length === 0, "the host node is cleared before each mount", String(stageHost.children.length));

tabs()[2].props.onClick();
element = await browser.render(main.component, { t: T });
check(browser.mounted.at(-1).key === "doctor", "every tab reaches its own feature", browser.mounted.at(-1).key);
check(findAll(element, (node) => node.props?.className === "stage-title")[0].props.children.join("") === "诊断", "the stage header follows the selection");

// A feature that throws is reported on the page, not into the console.
const broken = createBrowser({
	registry: { boom: { title: "Boom", order: 1, mount: () => { throw new Error("nope"); } } },
	fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) })
});
const brokenWired = broken.wire(broken.registrations[0]);
const brokenElement = await broken.render(brokenWired.slots.find((item) => item.slot === "main").component, { t: T });
const brokenHost = findAll(brokenElement, (node) => node.props?.ref !== undefined)[0].props.ref.current;
check(brokenHost.children[0]?.textContent === `${T("failed")}: nope`, "a throwing feature is reported in place", brokenHost.children[0]?.textContent);

/* ------------------------------------------------------------------ empty */

const empty = createBrowser({ language: "en", registry: {}, fetchImpl: async () => ({ json: async () => ({ ok: true, features: [] }) }) });
const emptyWired = empty.wire(empty.registrations[0]);
const emptyElement = await empty.render(emptyWired.slots.find((item) => item.slot === "main").component, { t: (key) => `en:${key}` });
check(findAll(emptyElement, (node) => node.props?.className === "rail").length === 0, "an empty inventory renders no tab rail");
check(findAll(emptyElement, (node) => node.props?.className === "empty").length === 1, "an empty inventory renders the hint block");
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
check(findAll(offlineElement, (node) => node.props?.className === "tab").length === 1, "the page still lists what the registry registered", String(findAll(offlineElement, (node) => node.props?.className === "tab").length));

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
