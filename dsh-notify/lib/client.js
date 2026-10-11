/**
 * dsh-notify — browser half.
 *
 * Injected into dsh's own web UI by the host half through the web server's
 * structured index injection, so it runs same-origin with the harness and can
 * call `/dsh-notify/api/*` directly.
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
	if (window.__dshNotifyLoaded === true) return;
	window.__dshNotifyLoaded = true;

	const BASE = "/dsh-notify";
	const API = `${BASE}/api`;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Reminders", "任务提醒"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		approval: ["Waiting for approval", "等待批准"],
		question: ["Waiting for an answer", "等待回答"],
		turnDone: ["Task finished", "任务完成"],
		answerDone: ["Answer ready", "回答就绪"],
		rules: ["When to remind", "何时提醒"],
		timing: ["Timing", "时机"],
		always: ["Always", "总是"],
		background: ["Only when this page is not focused", "仅当此页面不在前台"],
		sound: ["Sound", "音效"],
		volume: ["Volume", "音量"],
		toast: ["In-page popup", "页面弹窗"],
		browser: ["Browser notification", "系统通知"],
		permission: ["Grant browser notifications", "授权系统通知"],
		granted: ["granted", "已授权"],
		denied: ["denied, enable it in the browser's site settings", "已拒绝，请在浏览器的站点设置里打开"],
		defaultSound: ["System default (no sound from here)", "系统默认（本插件不放声）"],
		browserSound: ["A system notification has a sound of its own. This panel silences it unless the sound above is set to system default.", "系统通知自带提示音；只有上面的音效选的是系统默认，面板才让它响。"],
		silentSound: ["Silent", "静音"],
		noSounds: ["No sound files were found next to the plugin.", "插件目录下没有找到音效文件。"],
		configAt: ["Settings file", "设置文件"],
		test: ["Test", "试听"],
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

	/** In-page toast for local feedback. A body carrying newlines (the reminder's session line and
	 * its sentence) becomes one line per part rather than one run-on string.
	 */
	function toast(title, message) {
		if (toasts === undefined) return;
		const lines = String(message ?? "").split("\n").filter((line) => line.length > 0);
		const node = el("div", { class: "toast" },
			el("div", { class: "toast-title", text: title }),
			lines.map((line) => el("div", { class: "row-sub", text: line })));
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
	let sounds = [];
	/** The open SSE stream; the browser reconnects on its own. */
	let source;
	let audio;

	/** Human label for a reminder kind. */
	function labelForKind(kind) {
		switch (kind) {
			case "approval": return T("approval");
			case "question": return T("question");
			case "turn_done": return T("turnDone");
			case "answer_done": return T("answerDone");
			default: return kind;
		}
	}

	/** The kinds this page has a label for; anything else is a newer host's kind. */
	const LABEL_KEY = {
		approval: "approval",
		question: "question",
		turn_done: "turnDone",
		answer_done: "answerDone"
	};

	/**
	 * The words for one reminder, in the reader's language: two lines, which is what a
	 * notification reads as. The first is the kind, alone, because a system notification renders
	 * that line bold and short and a session name glued to it with a separator reads as part of
	 * the kind. The second is the session it belongs to, which is the thing that says *which*
	 * session is waiting; the sentence this used to add only restated the kind, so it is gone.
	 *
	 * The host publishes facts, not prose: it cannot know which language the page in front of the
	 * reader is speaking, and a reminder that arrives in the wrong one is worse than a short one.
	 * A kind this page has no label for still shows what the host called it, on that same second
	 * line, as the only description available.
	 * @param item - one reminder record off the stream.
	 * @returns the localized title (the kind alone) and body (at most one line).
	 */
	function reminderText(item) {
		const known = LABEL_KEY[item.kind] !== undefined;
		const named = typeof item.title === "string" && item.title.length > 0;
		const second = named ? item.title : (known ? undefined : item.text);
		return { title: labelForKind(item.kind), body: typeof second === "string" ? second : "" };
	}

	/** Whether a kind may be raised right now: its rule, and whether the page is focused. */
	function allows(kind) {
		const rule = config[kind];
		if (rule === undefined || rule.enabled !== true) return false;
		if (rule.timing === "always") return true;
		return document.hidden || !document.hasFocus();
	}

	/** Nudge the launcher when a reminder arrives while the panel is closed. */
	function pulseLauncher() {
		if (panel === undefined || !panel.hidden || launcher === undefined) return;
		launcher.classList.add("attention");
		setTimeout(() => launcher.classList.remove("attention"), 4000);
	}

	/** Play the configured completion sound. */
	function playSound() {
		const choice = config.sound;
		// "silent" means play nothing; "default" leaves the sound to the OS notification.
		if (choice === "silent" || choice === "default") return;
		audio = audio ?? new Audio();
		audio.src = `${BASE}/sounds/${encodeURIComponent(choice)}.wav`;
		audio.volume = config.volume;
		audio.play().catch(() => {
			/* autoplay policy: harmless, the toast still shows */
		});
	}

	/** Raise one reminder through every channel the settings allow. */
	function deliver(item) {
		if (item.kind === undefined) return;
		if (!allows(item.kind)) return;
		const words = reminderText(item);
		playSound();
		if (config.toast) toast(words.title, words.body);
		if (config.browser && typeof Notification !== "undefined" && Notification.permission === "granted") {
			try {
				// A system notification has a sound of its own on Windows, and it rings on top of
				// the .wav this panel is already playing, so a reader who picked a plugin sound
				// heard both. Only "system default" means "let the OS make the noise", so only
				// that choice leaves the notification audible.
				const notice = new Notification(words.title, {
					body: words.body,
					tag: `dsh-notify-${item.kind}`,
					silent: config.sound !== "default"
				});
				// Clicking the reminder should bring the application up. `window.focus()`
				// covers the browser (where the page is the window), and the host half covers
				// the desktop app, where a page cannot raise a window the OS has not focused
				// and the app exposes no IPC for it: the host is a child of the window's own
				// process and can ask Windows directly.
				notice.onclick = () => {
					window.focus();
					void postJson(`${API}/focus`, { kind: item.kind }).catch(() => {
						/* a window that stays where it is costs the click, nothing else */
					});
				};
			} catch {
				/* some engines refuse notifications outside a user gesture */
			}
		}
		pulseLauncher();
		if (inHub || (panel !== undefined && !panel.hidden)) void render();
	}

	/** Open the SSE stream. */
	function startStream() {
		if (source !== undefined) source.close();
		source = new EventSource(`${API}/events`);
		source.onmessage = (event) => {
			try {
				deliver(JSON.parse(event.data));
			} catch {
				/* a malformed frame is not worth surfacing */
			}
		};
	}

	/** Save a settings patch and repaint. */
	async function patchConfig(patch) {
		const result = await postJson(`${API}/settings`, patch);
		if (result.ok !== true) {
			toast(T("failed"), result.error ?? "settings save failed");
			return;
		}
		config = result.config;
		void render();
	}

	/**
	 * Re-read the settings from the host. They live in a file that any page of this
	 * plugin may write (the desktop window, the phone through the proxy), so a cached
	 * copy goes stale the moment the reader changes one somewhere else — and an edit
	 * made outside the panel would otherwise stay invisible to this page for its whole
	 * life, which is exactly the kind of "I set it and nothing happened" that reads as a
	 * broken plugin. Refreshing on focus covers both and costs one local request.
	 */
	async function refreshSettings() {
		if (document.hidden === true) return;
		try {
			const data = await getJson(`${API}/settings`);
			if (data.ok !== true) return;
			config = data.config;
			sounds = data.sounds ?? [];
			configPath = data.configPath;
			if (inHub || (panel !== undefined && !panel.hidden)) void render();
		} catch {
			/* the host being unreachable is the panel's own render's business */
		}
	}

	async function render() {
		body.replaceChildren(el("div", { class: "muted", text: "…" }));
		try {
			if (config === undefined) {
				const data = await getJson(`${API}/settings`);
				if (data.ok !== true) throw new Error(data.error ?? "failed to read settings");
				config = data.config;
				sounds = data.sounds ?? [];
				configPath = data.configPath;
			}
			body.replaceChildren(renderSettings());
		} catch (error) {
			body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
		}
	}

	/** One reminder rule: an on/off switch and a timing select. */
	function ruleRow(kind) {
		const timing = el("select", {},
			el("option", { value: "background", text: T("background"), selected: config[kind].timing !== "always" }),
			el("option", { value: "always", text: T("always"), selected: config[kind].timing === "always" }));
		timing.addEventListener("change", () => void patchConfig({ [kind]: { timing: timing.value } }));
		return row(labelForKind(kind), T("timing"), config[kind].enabled,
			(enabled) => postJson(`${API}/settings`, { [kind]: { enabled } }).then(assertOk),
			[timing]);
	}

	/** Label for one entry of the sound list. */
	function soundLabel(id) {
		if (id === "silent") return T("silentSound");
		if (id === "default") return T("defaultSound");
		return id;
	}

	function renderSettings() {
		const soundSelect = el("select", {});
		for (const id of sounds.length > 0 ? sounds : [config.sound]) {
			soundSelect.append(el("option", { value: id, text: soundLabel(id), selected: id === config.sound }));
		}
		soundSelect.addEventListener("change", () => void patchConfig({ sound: soundSelect.value }));
		const volume = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(config.volume) });
		volume.addEventListener("input", () => {
			audio = audio ?? new Audio();
			audio.volume = Number(volume.value);
		});
		volume.addEventListener("change", () => void patchConfig({ volume: Number(volume.value) }));

		const permission = typeof Notification === "undefined" ? undefined : Notification.permission;
		const grant = el("button", {
			text: T("permission"),
			disabled: permission === "granted" || permission === "denied",
			onclick: async () => {
				await Notification.requestPermission();
				void render();
			}
		});

		return el("div", {},
			el("div", { class: "note", text: T("rules") }),
			...["approval", "question", "turn_done", "answer_done"].map((kind) => ruleRow(kind)),
			el("div", { class: "field" }, el("label", { text: T("sound") }), soundSelect),
			sounds.length === 0 ? el("div", { class: "note", text: T("noSounds") }) : undefined,
			el("div", { class: "field" }, el("label", { text: `${T("volume")} ${Math.round(config.volume * 100)}%` }), volume),
			el("div", { class: "actions" },
				el("button", { text: T("test"), onclick: () => playSound() })),
			row(T("toast"), undefined, config.toast, (enabled) => postJson(`${API}/settings`, { toast: enabled }).then(assertOk)),
			row(T("browser"), permission === undefined ? undefined : permission === "granted" ? T("granted") : T("denied"), config.browser,
				(enabled) => postJson(`${API}/settings`, { browser: enabled }).then(assertOk),
				[grant]),
			el("div", { class: "note", text: T("browserSound") }),
			el("div", { class: "note", text: `${T("configAt")}: ${configPath ?? "?"}` }));
	}

	// Read the settings and open the event stream before the panel is painted: a
	// reminder must arrive even if the user never opens the panel.
	prepare = async () => {
		const data = await getJson(`${API}/settings`);
		if (data.ok !== true) throw new Error(data.error ?? "failed to read settings");
		config = data.config;
		sounds = data.sounds ?? [];
		configPath = data.configPath;
		startStream();
	};

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
			el("span", { class: "dsh-launch-icon", text: "N" }),
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
		const root = el("div", { id: "dsh-notify-root" });
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
			notify: {
				title: T("title"),
				icon: "M8 2.5a3.5 3.5 0 00-3.5 3.5v2.7L3 12h10l-1.5-3.3V6A3.5 3.5 0 008 2.5zM6.8 13.5a1.3 1.3 0 002.4 0",
				order: 50,
				mount: mountInline
			}
		});
	}

	/** True when the host half answers — the panel is useless without it. */
	async function reachable() {
		try {
			const data = await getJson("/dsh-notify/api/settings");
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
		// Coming back to the front is when a stale copy matters: it is both the moment the
		// next reminder will be judged against it and the moment the reader may have changed
		// the settings on another page. `visibilitychange` covers a hidden page that is
		// restored without ever losing focus.
		window.addEventListener("focus", () => void refreshSettings());
		document.addEventListener("visibilitychange", () => void refreshSettings());
		registerWithHub();
		if (await hubInstalled()) return;
		buildChrome();
	}

	// The injected script lands at the end of <body>; defer only if that is not
	// true, so the launcher appears with the rest of the UI.
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
	else void boot();
})();
