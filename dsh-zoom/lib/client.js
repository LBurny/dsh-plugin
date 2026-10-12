/**
 * dsh-zoom — browser half.
 *
 * Injected into dsh's own web UI by the host half through the web server's
 * structured index injection, so it runs same-origin with the harness and can
 * call `/dsh-zoom/api/*` directly.
 *
 * Plain DOM, no build step and no framework: an injected script must not depend
 * on dsh's internal client bundle format or slot names, both of which are
 * undocumented outside the tree and change between releases.
 *
 * Three cross-package conventions, all DOM-level (no module coupling):
 *   `#dsh-launchers`   the corner container every plugin's button docks into,
 *                      created on demand by whichever plugin loads first
 *   `.dsh-launch`      the shared button style, so several plugins look alike
 *   `--dsh-launcher-stack`  its measured height, so panels clear the dock
 *   `window.__dshFeatures`  the 功能管理 hub's registry — this panel publishes its
 *                      `mount` there, and docks no button while the hub is
 *                      installed (`/dsh-features/api/status` answers)
 */
(() => {
	"use strict";

	// The loader may inject this script more than once (e.g. after a client HMR);
	// a second copy would double every listener.
	if (window.__dshZoomLoaded === true) return;
	window.__dshZoomLoaded = true;

	const BASE = "/dsh-zoom";
	const API = `${BASE}/api`;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Zoom", "缩放"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		level: ["Level", "缩放级别"],
		step: ["Step", "步进"],
		range: ["Range", "范围"],
		zoomIn: ["Zoom in", "放大"],
		zoomOut: ["Zoom out", "缩小"],
		record: ["Record", "录制"],
		recording: ["Press the shortcut…", "请按下快捷键…"],
		reset: ["Reset to 100%", "重置为 100%"],
		ceiling: ["capped by the window height", "已按窗口高度封顶"],
		shortcutHint: ["Shortcuts work anywhere in the dsh web UI; a recording stays open until you press a key.", "快捷键在 dsh 界面任意位置生效；录制状态下按任意键即完成。"],
		configAt: ["Settings file", "设置文件"],
		percent: ["%", "%"]
	};
	const T = (key) => STRINGS[key][ZH ? 1 : 0];

	// --------------------------------------------------------------- helpers

	/** Create an element with attributes and children. */
	function el(tag, attrs, ...children) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs ?? {})) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else if (key === "dataset") Object.assign(node.dataset, value);
			else node.setAttribute(key, value === true ? "" : String(value));
		}
		for (const child of children.flat()) {
			if (child === undefined || child === null || child === false) continue;
			node.append(child instanceof Node ? child : document.createTextNode(String(child)));
		}
		return node;
	}

	/** GET JSON. */
	async function getJson(path) {
		const response = await fetch(path, { credentials: "same-origin" });
		return response.json();
	}

	/** POST JSON. */
	async function postJson(path, body) {
		const response = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		});
		return response.json();
	}

	/** Throw when an API result reports failure. */
	function assertOk(result) {
		if (result?.ok !== true) throw new Error(result?.error ?? "request failed");
		return result;
	}

	/** Debounce a function. */
	function debounce(fn, delay) {
		let handle;
		return (...args) => {
			clearTimeout(handle);
			handle = setTimeout(() => fn(...args), delay);
		};
	}

	/** Parse a `KEY=VALUE` textarea into an object, ignoring blank lines. */
	function parsePairs(text) {
		const out = {};
		for (const line of String(text ?? "").split(/\r?\n/u)) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const at = trimmed.indexOf("=");
			if (at <= 0) continue;
			out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
		}
		return out;
	}

	/** Serialize an object back into `KEY=VALUE` lines. */
	const pairsToText = (value) =>
		Object.entries(value ?? {})
			.map(([key, item]) => `${key}=${item}`)
			.join("\n");

	// ------------------------------------------------------------------- dom

	let panel;
	let body;
	let toasts;
	let launcher;
	/**
	 * True while this panel is mounted inside the 功能管理 hub's page instead of
	 * its own floating panel.
	 */
	let inHub = false;

	/** In-page toast for local feedback. */
	function toast(title, message) {
		if (toasts === undefined) return;
		const node = el("div", { class: "toast" },
			el("div", { class: "toast-title", text: title }),
			message ? el("div", { class: "row-sub", text: message }) : undefined);
		node.addEventListener("click", () => node.remove());
		toasts.append(node);
		setTimeout(() => node.remove(), 8000);
	}

	/** One list row: name, subtitle, optional action buttons and a switch. */
	function row(name, subtitle, enabled, toggle, actions) {
		const children = [el("div", { class: "row-main" },
			el("div", { class: "row-name", text: name, title: name }),
			subtitle ? el("div", { class: "row-sub", text: subtitle, title: subtitle }) : undefined)];
		const side = [...(actions ?? [])];
		if (toggle !== undefined) {
			const control = el("div", { class: "switch", dataset: { on: String(enabled === true) }, role: "switch" });
			control.addEventListener("click", async () => {
				const next = control.dataset.on !== "true";
				control.dataset.on = String(next);
				try {
					await toggle(next);
				} catch (error) {
					toast(T("failed"), String(error?.message ?? error));
				}
				void render();
			});
			side.push(control);
		}
		return el("div", { class: "row" }, ...children, side.length === 0 ? undefined : el("div", { class: "row-actions" }, ...side));
	}

	/** Swap the panel body for a sub-view (dialog); the factory supplies it. */
	function showView(factory) {
		void (async () => {
			body.replaceChildren(el("div", { class: "muted", text: T("working") }));
			try {
				body.replaceChildren(await factory());
			} catch (error) {
				body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
			}
		})();
	}

	// --------------------------------------------------------------- feature

	/**
	 * Per-package hooks, reassigned by the feature block below: `prepare` runs
	 * before the panel is painted (so saved settings apply first), and
	 * `showLauncher` decides whether this plugin docks a button at all.
	 */
	let prepare = async () => {};
	let showLauncher = () => true;

	let config;
	let configPath;
	/** Set while the recorder is armed, so the matcher stands down. */
	let recordTarget;
	/** The armed recorder's keycap and listener, so a second arm can cancel the first. */
	let recorder;

	/**
	 * The harness's own chrome is what limits zoom, not the content: `zoom` on
	 * `<html>` divides the layout viewport by the factor, and past
	 * `window height / chrome` the sidebar's stack no longer fits. The app shell
	 * clips it (`overflow: hidden`) and the document never scrolls, so its bottom
	 * block — 设置, 意见反馈, 退出登录 — and the avatar menu hanging off it become
	 * unreachable, with no way to scroll to them.
	 *
	 * What that stack needs is measured from the page instead of assumed: the
	 * sidebar column is the shell's only non-shrinkable stack (each child is
	 * `flex: none` except the session region, which collapses to zero), so forcing a
	 * deliberately oversized zoom makes `scrollHeight` report exactly the height the
	 * column requires. That reading is in layout px — which the factor does not
	 * scale — so it stays valid at any zoom, for any sidebar contents: extra plugins
	 * add nav rows, a signed-in profile adds footer rows, and both raise the floor.
	 */
	const SIDEBAR_COLUMN = '[class*="_sidebarCol"]';
	/** Used until the shell's sidebar exists, and in a host that has none. */
	const FALLBACK_CHROME_PX = 360;
	/** Big enough to overflow any real window, so `scrollHeight` reports the need. */
	const SAMPLE_ZOOM = 6;
	/** Keeps the cap strictly below the physical limit, so rounding cannot clip. */
	const SLACK = 0.98;

	/**
	 * How tall the harness's sidebar needs to be, in layout px. The zoom used to
	 * measure is restored in the same task: no frame is painted oversized, and the
	 * shell's own width watcher — which reads a viewport-space rect on the next
	 * animation frame — never sees it either.
	 * @returns the requirement, or the fallback when there is no sidebar to ask.
	 */
	function sidebarMinHeight() {
		const column = document.querySelector(SIDEBAR_COLUMN);
		if (column === null) return FALLBACK_CHROME_PX;
		const html = document.documentElement;
		const applied = html.style.zoom;
		let required;
		try {
			html.style.zoom = String(SAMPLE_ZOOM);
			required = column.scrollHeight;
		} finally {
			html.style.zoom = applied;
		}
		return Number.isFinite(required) && required > 0 ? required : FALLBACK_CHROME_PX;
	}

	/**
	 * The largest level this window can render with the harness still usable. Not
	 * a policy limit but a physical one, which is why it is derived per apply
	 * rather than written into the settings: `max` stays the preference.
	 * @returns the effective maximum, in the configured range.
	 */
	function ceiling() {
		const height = window.innerHeight;
		// A hidden or not-yet-laid-out window reports 0 (or nothing): that is not a
		// small window, it is no answer, so keep the user's own maximum.
		if (!Number.isFinite(height) || height <= 0) return config.max;
		// Never shrink the page on the user's behalf: 100% is the floor of what a cap
		// may impose, so a short window cannot be talked into a smaller level.
		const bounded = Math.max(1, (height * SLACK) / sidebarMinHeight());
		return Math.floor(Math.min(config.max, Math.max(config.min, bounded)) * 100) / 100;
	}

	/** Apply a level to the page and remember it (the write is debounced). */
	function applyLevel(level, persist) {
		const next = Math.min(ceiling(), Math.max(config.min, level));
		const html = document.documentElement;
		html.style.zoom = String(next);
		// The factor, published for the `data-menu-material` rules in the stylesheet:
		// dsh's portaled menus have to cancel it on themselves and take it back on
		// their contents, or the zoom lands on their inline coordinates a second time.
		html.style.setProperty("--dsh-zoom", String(next));
		html.style.setProperty("--dsh-zoom-inverse", String(1 / next));
		config.level = next;
		if (persist) persistLevel();
		return next;
	}

	// A shorter window lowers the ceiling. Re-apply through the clamp so resizing
	// after zooming in cannot strand the harness's bottom block out of reach.
	window.addEventListener("resize", () => {
		if (config !== undefined) applyLevel(config.level, false);
	});

	/**
	 * This script is injected with the page, but the shell mounts its sidebar
	 * afterwards, and the cap can only be measured once it is there. Until then
	 * `ceiling` answers with the fallback, so re-apply through the clamp as soon as
	 * the column appears — otherwise the saved level survives a reload uncapped.
	 */
	function watchForSidebar() {
		if (document.querySelector(SIDEBAR_COLUMN) !== null) return;
		if (typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(() => {
			if (document.querySelector(SIDEBAR_COLUMN) === null) return;
			observer.disconnect();
			if (config !== undefined) applyLevel(config.level, false);
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
		// The sidebar mounts immediately in dsh's own UI; on a host without one the
		// observer must not run a whole-document query on every mutation forever.
		setTimeout(() => observer.disconnect(), 60_000);
	}

	const persistLevel = debounce(() => {
		void postJson(`${API}/settings`, { level: config.level });
	}, 400);

	/** Match a keyboard event against a stored shortcut descriptor. */
	function matchesShortcut(event, shortcut) {
		if (event.metaKey) return false;
		if (event.ctrlKey !== shortcut.ctrl) return false;
		if (event.shiftKey !== shortcut.shift) return false;
		if (event.altKey !== shortcut.alt) return false;
		// `code` is authoritative; `key` covers synthesized/RDP events.
		return (event.code && event.code === shortcut.code) || (event.key && event.key === shortcut.key);
	}

	/**
	 * Capture-phase key handling for the zoom shortcuts. Registered once; the
	 * handler reads the live settings, so rebinding needs no re-registration.
	 */
	function installShortcutMatcher() {
		window.addEventListener("keydown", (event) => {
			if (recordTarget !== undefined) return;
			if (config === undefined) return;
			for (const side of ["in", "out"]) {
				if (!matchesShortcut(event, config[side])) continue;
				event.preventDefault();
				event.stopImmediatePropagation();
				applyLevel(side === "in" ? config.level + config.step : config.level - config.step, true);
				return;
			}
		}, true);
	}

	/** Human-readable form of a shortcut descriptor. */
	function describeShortcut(shortcut) {
		const parts = [];
		if (shortcut.ctrl) parts.push("Ctrl");
		if (shortcut.shift) parts.push("Shift");
		if (shortcut.alt) parts.push("Alt");
		parts.push(prettyCode(shortcut.code, shortcut.key));
		return parts.join(" + ");
	}

	/** Turn a KeyboardEvent code into something a person recognises. */
	function prettyCode(code, key) {
		if (typeof code !== "string" || code === "") return key ?? "?";
		if (code.startsWith("Key")) return code.slice(3);
		if (code.startsWith("Digit")) return code.slice(5);
		const named = { Equal: "=", Minus: "-", Plus: "+", NumpadAdd: "Num +", NumpadSubtract: "Num -", Space: "Space" };
		return named[code] ?? code;
	}

	/** Arm the recorder for one side; the next keydown becomes the shortcut. */
	function recordShortcut(side, cap) {
		// Only one recorder can be armed: two live capture listeners would both take the
		// next keydown, and both sides would end up bound to the same key.
		cancelRecorder();
		recordTarget = side;
		cap.textContent = T("recording");
		cap.classList.add("recording");
		const once = (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			window.removeEventListener("keydown", once, true);
			recordTarget = undefined;
			recorder = undefined;
			// Escape cancels rather than binding Escape itself.
			if (event.key !== "Escape") {
				const shortcut = {
					ctrl: event.ctrlKey === true,
					shift: event.shiftKey === true,
					alt: event.altKey === true,
					code: typeof event.code === "string" && event.code !== "" ? event.code : "",
					key: typeof event.key === "string" ? event.key : ""
				};
				if (shortcut.code === "" && shortcut.key === "") return;
				config[side] = shortcut;
				void patchConfig({ [side]: shortcut });
				cap.textContent = describeShortcut(shortcut);
			} else {
				cap.textContent = describeShortcut(config[side]);
			}
			cap.classList.remove("recording");
		};
		recorder = { cap, once };
		window.addEventListener("keydown", once, true);
	}

	/** Disarm the recorder, restoring the keycap it was painting. */
	function cancelRecorder() {
		if (recorder === undefined || recordTarget === undefined) return;
		window.removeEventListener("keydown", recorder.once, true);
		if (config !== undefined) recorder.cap.textContent = describeShortcut(config[recordTarget]);
		recorder.cap.classList.remove("recording");
		recorder = undefined;
		recordTarget = undefined;
	}

	/** Save a settings patch and surface failures. */
	async function patchConfig(patch) {
		try {
			const result = await postJson(`${API}/settings`, patch);
			if (result.ok !== true) throw new Error(result.error ?? "settings save failed");
			config = result.config;
			if (patch.level !== undefined) applyLevel(config.level, false);
			void render();
		} catch (error) {
			// Callers are `void patchConfig(...)`: a host that is restarting refuses the
			// connection, and without this the rejection escapes to the console while the
			// control appears to do nothing at all.
			toast(T("failed"), String(error?.message ?? error));
		}
	}

	async function render() {
		// A re-render rebuilds the shortcut rows, so an armed recorder would be left
		// painting a detached keycap.
		cancelRecorder();
		body.replaceChildren(el("div", { class: "muted", text: "…" }));
		try {
			if (config === undefined) {
				const data = await getJson(`${API}/settings`);
				if (data.ok !== true) throw new Error(data.error ?? "failed to read settings");
				config = data.config;
			}
			body.replaceChildren(renderSettings());
		} catch (error) {
			body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
		}
	}

	/** The shortcut row for one side: a keycap that doubles as the recorder. */
	function shortcutRow(side) {
		const cap = el("span", { class: "keycap", text: describeShortcut(config[side]) });
		cap.addEventListener("click", () => recordShortcut(side, cap));
		return el("div", { class: "row" },
			el("div", { class: "row-main" },
				el("div", { class: "row-name", text: side === "in" ? T("zoomIn") : T("zoomOut") }),
				el("div", { class: "row-sub", text: T("shortcutHint") })),
			el("div", { class: "row-actions" }, cap,
				el("button", { text: T("record"), onclick: () => recordShortcut(side, cap) })));
	}

	function renderSettings() {
		const top = ceiling();
		// The level is a value badge, not bare text: same 32px box and padding as the
		// buttons beside it, so the row reads as one line of controls instead of a
		// number floating next to a button.
		const levelLabel = el("span", { class: "level", text: `${Math.round(config.level * 100)}${T("percent")}` });
		const slider = el("input", {
			type: "range",
			min: String(config.min),
			max: String(top),
			step: String(config.step),
			value: String(config.level)
		});
		slider.addEventListener("input", () => {
			const next = applyLevel(Number(slider.value), false);
			levelLabel.textContent = `${Math.round(next * 100)}${T("percent")}`;
		});
		slider.addEventListener("change", () => persistLevel());
		const stepSelect = el("select", {});
		for (const step of [0.01, 0.02, 0.05, 0.1, 0.25]) {
			stepSelect.append(el("option", { value: String(step), text: `${Math.round(step * 100)}${T("percent")}`, selected: Math.abs(step - config.step) < 0.001 }));
		}
		stepSelect.addEventListener("change", () => void patchConfig({ step: Number(stepSelect.value) }));
		return el("div", {},
			el("div", { class: "field" }, el("label", {
				text: `${T("level")} ${T("range")} ${Math.round(config.min * 100)}–${Math.round(top * 100)}${T("percent")}`
					+ (top < config.max ? ` · ${T("ceiling")}` : "")
			}), slider),
			el("div", { class: "actions" }, levelLabel,
				el("button", { text: T("reset"), onclick: () => { applyLevel(1, true); void render(); } })),
			el("div", { class: "field" }, el("label", { text: T("step") }), stepSelect),
			shortcutRow("in"),
			shortcutRow("out"),
			el("div", { class: "note", text: `${T("configAt")}: ${configPath ?? "?"}` }));
	}

	// Read the saved level before the panel is painted, so the page is already at
	// the user's zoom when the launcher appears, and the shortcut matcher is live
	// even if they never open the panel.
	prepare = async () => {
		const data = await getJson(`${API}/settings`);
		if (data.ok !== true) throw new Error(data.error ?? "failed to read settings");
		config = data.config;
		configPath = data.configPath;
		applyLevel(config.level, false);
		installShortcutMatcher();
		watchForSidebar();
	};

	/** The launcher is the settings' own on/off switch. */
	showLauncher = () => config?.launcher !== false;

	// ---------------------------------------------------------------- chrome

	function toggle() {
		const hidden = panel.hidden;
		panel.hidden = !hidden;
		launcher.dataset.open = String(hidden);
		if (hidden) void render();
	}

	/**
	 * Panels anchor above the launcher dock, whose height depends on how many
	 * packages are installed. Every package publishes the same measurement, so a
	 * later plugin's panel is placed clear of a taller dock.
	 */
	function publishStackHeight(dock) {
		const apply = () => document.documentElement.style.setProperty("--dsh-launcher-stack", `${dock.offsetHeight}px`);
		apply();
		if (typeof ResizeObserver !== "undefined") new ResizeObserver(apply).observe(dock);
	}

	/** The corner launcher, docked into the shared container. */
	function buildLauncher() {
		let dock = document.getElementById("dsh-launchers");
		if (dock === null) {
			dock = el("div", { id: "dsh-launchers" });
			document.body.append(dock);
		}
		launcher = el("button", { class: "dsh-launch", title: T("title"), onclick: toggle },
			el("span", { class: "dsh-launch-icon", text: "Z" }),
			el("span", { class: "dsh-launch-label", text: T("title") }));
		launcher.dataset.open = "false";
		dock.append(launcher);
		publishStackHeight(dock);
	}

	/**
	 * Build the panel's DOM. `inline` mounts it into a container the 功能管理 hub
	 * owns; the hub then provides the frame, the title and the close control, and
	 * this panel contributes its body only.
	 * @param host - element to append to (the document body by default).
	 * @param inline - true when the hub page is mounting this panel.
	 */
	function buildChrome(host = document.body, inline = false) {
		inHub = inline;
		const root = el("div", { id: "dsh-zoom-root" });
		toasts = el("div", { class: "toasts" });
		body = el("div", { class: "body" });
		if (inline) {
			root.append(toasts, body);
			host.append(root);
			return;
		}
		panel = el("div", { class: "panel", hidden: true },
			el("div", { class: "head" },
				el("div", { class: "title", text: T("title") }),
				el("button", { text: T("close"), onclick: toggle })),
			body);
		root.append(toasts, panel);
		host.append(root);
		if (showLauncher()) buildLauncher();
	}

	/**
	 * Render this panel inside a container owned by the 功能管理 hub. The hub calls
	 * this on every visit and drops the DOM when the page is left, so it discards
	 * whatever the previous visit (or the floating panel) left behind first.
	 * @param host - the hub page's container element.
	 */
	function mountInline(host) {
		if (panel !== undefined) {
			panel.remove();
			panel = undefined;
			launcher?.remove();
			launcher = undefined;
		}
		buildChrome(host, true);
		void render();
	}

	/**
	 * Publish this panel to the 功能管理 hub (`window.__dshFeatures`). That registry
	 * is this package's only coupling to the hub: with no hub installed nothing
	 * reads it, and this plugin keeps its standalone floating panel.
	 */
	function registerWithHub() {
		window.__dshFeatures = Object.assign(window.__dshFeatures ?? {}, {
			zoom: {
				title: T("title"),
				icon: "M7 3a4 4 0 100 8 4 4 0 000-8zM9.9 9.9L14 14",
				order: 40,
				mount: mountInline
			}
		});
	}

	/** True when the host half answers — the panel is useless without it. */
	async function reachable() {
		try {
			const data = await getJson("/dsh-zoom/api/settings");
			return data?.ok === true;
		} catch {
			return false;
		}
	}

	/**
	 * True when the 功能管理 hub is installed. Its page lists this plugin beside
	 * every other feature, so the floating panel — and its corner button — is not
	 * built; the route is absent in a bare dsh or a profile without the hub.
	 */
	async function hubInstalled() {
		try {
			const data = await getJson("/dsh-features/api/status");
			return data?.ok === true;
		} catch {
			return false;
		}
	}

	async function boot() {
		if (!(await reachable())) return;
		try {
			await prepare();
		} catch {
			/* a settings read that fails must not hide the panel */
		}
		registerWithHub();
		if (await hubInstalled()) return;
		buildChrome();
	}

	// The injected script lands at the end of <body>; defer only if that is not
	// true, so the launcher appears with the rest of the UI.
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
	else void boot();
})();
