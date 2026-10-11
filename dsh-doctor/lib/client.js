/**
 * dsh-doctor — browser half.
 *
 * Injected into dsh's own web UI by the host half through the web server's
 * structured index injection, so it runs same-origin with the harness and can
 * call `/dsh-doctor/api/*` directly.
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
 *
 * This panel is the debug surface for that set of plugins, so it shows two things
 * the harness does not surface anywhere else: the plugin tree with each row's
 * activation state (a green boot does not mean a row loaded), and the harness's own
 * log records read in-process. While the panel is open it appends new records every
 * few seconds through `/api/logs?since=<sn>`.
 */
(() => {
	"use strict";

	// The loader may inject this script more than once (e.g. after a client HMR);
	// a second copy would double every listener.
	if (window.__dshDoctorLoaded === true) return;
	window.__dshDoctorLoaded = true;

	const BASE = "/dsh-doctor";
	const API = `${BASE}/api`;
	/** How often an open panel asks for new log records. */
	const LIVE_INTERVAL_MS = 3000;
	/** Records this panel holds; the host keeps its own, larger, window. */
	const WINDOW_LIMIT = 500;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Doctor", "诊断"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		refresh: ["Refresh", "刷新"],
		logs: ["Log", "日志"],
		noLogs: ["No log records captured yet.", "还没有捕获到日志记录。"],
		port: ["Port", "端口"],
		pid: ["Process id", "进程号"],
		uptime: ["Uptime", "已运行"],
		memory: ["Memory", "内存"],
		profile: ["Profile", "Profile"],
		sessions: ["Sessions", "会话数"],
		dshHome: ["DSH home", "DSH 主目录"],
		patch: ["Patch layer", "补丁层"],
		logSource: ["Source", "日志来源"],
		seconds: ["s", "秒"],
		rows: ["Plugin rows", "插件行"],
		rowId: ["Row", "行"],
		rowPackage: ["Package", "包"],
		rowState: ["State", "状态"],
		activeRows: ["rows active", "行已激活"],
		failedRows: ["failed", "失败"],
		records: ["record(s)", "条记录"],
		sourceCapture: ["in-process capture", "进程内捕获"],
		sourcePlugin: ["this plugin's ring", "本插件环形缓冲"],
		required: ["required", "必需"],
		disabled: ["disabled", "已禁用"],
		rowsOff: ["The plugin tree is unavailable in this profile.", "这个 profile 里读不到插件树。"],
		rowOrder: ["failed and this suite's rows first", "异常行与本套插件在前"],
		capture: ["Capture", "捕获"],
		captureOff: ["In-process log capture is unavailable", "进程内日志捕获不可用"],
		files: ["Log files", "日志文件"],
		level: ["Level", "级别"],
		all: ["All", "全部"],
		onlyOurs: ["Our plugins only", "只看本套插件"],
		scope: ["Which records to show", "显示哪些记录"],
		scopeAll: ["All plugins", "全部插件"],
		filter: ["Filter", "筛选"],
		copy: ["Copy", "复制"],
		copied: ["Copied", "已复制"]
	};
	const T = (key) => STRINGS[key][ZH ? 1 : 0];

	/** The `dsh-*` packages this panel exists to debug, by row id and by package name. */
	const OUR_NAMES = ["dsh-features", "dsh-skills", "dsh-mcp", "dsh-doctor", "dsh-zoom", "dsh-notify", "dsh-remote", "dsh-init", "features", "skills", "mcp", "doctor", "zoom", "notify", "remote", "init"];

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

	/** A record type as a two-letter tag, so a line stays one row high. */
	const levelTag = (type) => String(type ?? "info").slice(0, 3).toUpperCase();

	/** `HH:MM:SS` in local time, or an empty string for a record without a timestamp. */
	function clock(ts) {
		if (!Number.isFinite(ts)) return "";
		const at = new Date(ts);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
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
	/** The live-tail timer, set only while a floating panel is open. */
	let live;
	/** The log view's state: what was read, what is shown, what is filtered out. */
	const logView = {
		source: "?",
		reason: undefined,
		records: [],
		files: [],
		lastSn: 0,
		level: "all",
		onlyOurs: false,
		match: "",
		list: undefined,
		meta: undefined
	};

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

	// --------------------------------------------------------------- feature

	/**
	 * Per-package hooks, reassigned by the feature block below: `prepare` runs
	 * before the panel is painted (so saved settings apply first), and
	 * `showLauncher` decides whether this plugin docks a button at all.
	 */
	let prepare = async () => {};
	let showLauncher = () => true;

	async function render() {
		body.replaceChildren(el("div", { class: "muted", text: "…" }));
		try {
			const snapshot = assertOk(await getJson(`${API}/diagnostics`));
			const log = assertOk(await getJson(`${API}/logs`));
			readLog(log);
			body.replaceChildren(renderStatus(snapshot.status), renderLogs());
		} catch (error) {
			body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
		}
	}

	/** Adopt a `/api/logs` payload, replacing the window when the host says so. */
	function readLog(payload) {
		const incoming = Array.isArray(payload?.records) ? payload.records : [];
		logView.source = payload?.source ?? "?";
		logView.reason = payload?.reason;
		logView.files = Array.isArray(payload?.files) ? payload.files : [];
		logView.records = payload?.reset === true ? incoming : [...logView.records, ...incoming];
		if (logView.records.length > WINDOW_LIMIT) logView.records = logView.records.slice(-WINDOW_LIMIT);
		logView.lastSn = logView.records.at(-1)?.sn ?? 0;
	}

	/** The environment facts, as a definition list, plus the plugin tree. */
	function renderStatus(status) {
		const value = (label, text) => [el("dt", { text: label }), el("dd", { text: text ?? "?" })];
		return el("div", {},
			el("div", { class: "actions" },
				// The hub's own header refreshes an embedded panel, so it hides this one.
				inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() })),
			el("dl", { class: "grid" },
				...value("dsh", `${status.version}`, ),
				...value("node", status.node),
				...value(T("port"), String(status.port ?? "?")),
				...value(T("pid"), String(status.pid)),
				...value(T("uptime"), `${String(status.uptimeSeconds)} ${T("seconds")}`),
				...value(T("memory"), `${String(status.memoryMb)} MB`),
				...value(T("profile"), status.profile),
				...value(T("sessions"), status.sessions === undefined ? "?" : String(status.sessions)),
				...value(T("dshHome"), status.dshHome),
				...value(T("patch"), status.patchPath),
				...value("platform", `${status.platform} ${status.arch}`),
				...value(T("capture"), status.capture === undefined || status.capture.attached !== true
					? `${T("captureOff")}${status.capture?.reason === undefined ? "" : ` (${status.capture.reason})`}`
					: `${String(status.capture.records)} ${T("records")}`)),
			renderRows(status));
	}

	/** The plugin tree: one line per row, failed and required rows called out. */
	function renderRows(status) {
		const rows = Array.isArray(status.rows) ? status.rows : [];
		if (status.rowsAvailable !== true) {
			return el("div", { class: "section" },
				el("div", { class: "row-sub", text: T("rows") }),
				el("div", { class: "note", text: status.rowsReason ?? T("rowsOff") }));
		}
		// A shipped profile has around two hundred rows, so the ones this panel exists for
		// come first: anything that failed, then this suite's packages, then the rest in
		// tree order (the sort is stable, so the groups keep it).
		const rank = (entry) => (entry.state === "failed" ? 0 : isOurs({ name: entry.id, text: entry.package }) ? 1 : entry.required ? 2 : 3);
		const ordered = [...rows].sort((left, right) => rank(left) - rank(right));
		// The counts are composed here, not sent as a sentence, so the panel reads in the
		// page's own language rather than the host's.
		const failed = Array.isArray(status.rowsFailed) ? status.rowsFailed : [];
		const summary = [
			`${String(status.rowsActive ?? "?")}/${String(status.rowsTotal ?? rows.length)} ${T("activeRows")}`,
			failed.length === 0 ? "" : `${T("failedRows")}: ${failed.join(", ")}`,
			T("rowOrder")
		].filter((part) => part !== "").join(" · ");
		return el("div", { class: "section" },
			el("div", { class: "row-sub", text: `${T("rows")} · ${summary}` }),
			el("div", { class: "table", role: "table" },
				el("div", { class: "tr head", role: "row" },
					el("span", { class: "td", text: T("rowId") }),
					el("span", { class: "td", text: T("rowPackage") }),
					el("span", { class: "td state", text: T("rowState") })),
				...ordered.map((entry) => el("div", { class: "tr", role: "row", dataset: { state: entry.state } },
					el("span", { class: "td id", text: entry.id, title: entry.module }),
					el("span", { class: "td", text: entry.package, title: entry.module }),
					el("span", {
						class: "td state",
						text: [entry.state, entry.disabled ? T("disabled") : "", entry.required ? T("required") : ""].filter((part) => part !== "").join(" · ")
					})))));
	}

	/** True when a record belongs to the plugins this panel is here to debug. */
	function isOurs(record) {
		if (OUR_NAMES.includes(String(record?.name ?? ""))) return true;
		const text = String(record?.text ?? "");
		return OUR_NAMES.some((candidate) => text.includes(candidate));
	}

	/** The records the current filter lets through. */
	function visibleRecords() {
		return logView.records.filter((record) => {
			if (logView.level !== "all" && String(record.type) !== logView.level) return false;
			if (logView.onlyOurs && !isOurs(record)) return false;
			if (logView.match !== "" && !String(record.text).toLowerCase().includes(logView.match)) return false;
			return true;
		});
	}

	/** One log line: when, who, how bad, what. */
	function renderRecord(record) {
		return el("div", { class: "logline", dataset: { type: String(record.type), ours: String(isOurs(record)) } },
			el("span", { class: "log-when", text: clock(record.ts) }),
			el("span", { class: "log-tag", text: levelTag(record.type) }),
			el("span", { class: "log-name", text: record.name, title: record.name }),
			el("span", { class: "log-text", text: record.text }));
	}

	/** Repaint only the record list, which is what a filter change or a poll touches. */
	function paintRecords() {
		if (logView.list === undefined) return;
		const records = visibleRecords();
		const children = records.length === 0
			? [el("div", { class: "note", text: logView.records.length === 0 ? T("noLogs") : `${T("filter")}: 0/${String(logView.records.length)}` })]
			: records.map(renderRecord);
		logView.list.replaceChildren(...children);
		logView.list.scrollTop = logView.list.scrollHeight;
	}

	/**
	 * The filter controls. They write into `logView` and repaint the list. Both
	 * ranges are dropdowns rather than a dropdown plus a checkbox, so every control
	 * in the row is the same height as the one beside it.
	 */
	function renderFilters() {
		const levels = ["all", "error", "warn", "info", "debug"];
		const level = el("select", { class: "level", onchange: (event) => {
			logView.level = String(event?.target?.value ?? "all");
			paintRecords();
		} }, ...levels.map((name) => el("option", { value: name, selected: name === logView.level, text: name === "all" ? T("all") : name })));
		level.value = logView.level;
		const scopes = { all: T("scopeAll"), ours: T("onlyOurs") };
		const scope = el("select", { class: "scope", title: T("scope"), onchange: (event) => {
			logView.onlyOurs = String(event?.target?.value ?? "all") === "ours";
			paintRecords();
		} }, ...Object.entries(scopes).map(([value, text]) => el("option", { value, text, selected: (value === "ours") === logView.onlyOurs })));
		scope.value = logView.onlyOurs ? "ours" : "all";
		const match = el("input", { type: "search", class: "match", placeholder: T("filter"), oninput: debounce((event) => {
			logView.match = String(event?.target?.value ?? "").toLowerCase();
			paintRecords();
		}, 150) });
		match.value = logView.match;
		return el("div", { class: "filters" },
			level,
			scope,
			match,
			el("button", { text: T("copy"), onclick: () => void copyRecords() }));
	}

	/** Put the records the filter shows on the clipboard, as plain text. */
	async function copyRecords() {
		const text = visibleRecords().map((record) => `${clock(record.ts)} ${levelTag(record.type)} ${record.name}: ${record.text}`).join("\n");
		try {
			await navigator.clipboard.writeText(text);
			toast(T("copied"), `${String(visibleRecords().length)} ${T("logs")}`);
		} catch (error) {
			toast(T("failed"), String(error?.message ?? error));
		}
	}

	/** The log view: where the records came from, the filters, the lines, the files. */
	function renderLogs() {
		const source = logView.source === "capture" ? T("sourceCapture") : logView.source === "plugin" ? T("sourcePlugin") : logView.source;
		logView.meta = el("div", { class: "row-sub", text: `${T("logs")} · ${T("logSource")}: ${source}${logView.records.length === 0 ? "" : ` · ${String(logView.records.length)} ${T("records")}`}${logView.reason === undefined ? "" : ` · ${String(logView.reason)}`}` });
		logView.list = el("div", { class: "loglines" });
		const files = logView.files.length === 0
			? undefined
			: el("div", { class: "section" },
				el("div", { class: "row-sub", text: T("files") }),
				...logView.files.map((file) => el("details", {},
					el("summary", { text: `${file.source} · ${file.path} · ${String((file.lines ?? []).length)}` }),
					el("pre", { class: "logs", text: (file.lines ?? []).join("\n") }))));
		const section = el("div", { class: "section" }, logView.meta, renderFilters(), logView.list, files);
		paintRecords();
		return section;
	}

	/** Ask for records newer than the newest one held; a reset replaces the window. */
	async function poll() {
		try {
			const payload = assertOk(await getJson(`${API}/logs?since=${String(logView.lastSn)}`));
			if (payload.reset !== true && (payload.records ?? []).length === 0) return;
			readLog(payload);
			paintRecords();
		} catch {
			/* a poll that fails leaves what is on screen alone */
		}
	}

	/** Start the live tail. Only a floating panel polls: the hub refreshes itself. */
	function startLive() {
		stopLive();
		if (typeof setInterval !== "function" || inHub) return;
		live = setInterval(() => void poll(), LIVE_INTERVAL_MS);
	}

	/** Stop the live tail; an unmounted or closed panel must not keep asking. */
	function stopLive() {
		if (live === undefined) return;
		clearInterval(live);
		live = undefined;
	}

	// ---------------------------------------------------------------- chrome

	function toggle() {
		const hidden = panel.hidden;
		panel.hidden = !hidden;
		launcher.dataset.open = String(hidden);
		if (hidden) {
			void render();
			startLive();
		} else {
			stopLive();
		}
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
			el("span", { class: "dsh-launch-icon", text: "D" }),
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
		const root = el("div", { id: "dsh-doctor-root" });
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
		stopLive();
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
			doctor: {
				title: T("title"),
				icon: "M2 8.5h3l1.5-4 2.5 7 1.5-3h3.5",
				order: 30,
				mount: mountInline
			}
		});
	}

	/** True when the host half answers — the panel is useless without it. */
	async function reachable() {
		try {
			const data = await getJson("/dsh-doctor/api/diagnostics");
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

	/** A panel left open while the tab is hidden has nothing to update, so pause. */
	function watchVisibility() {
		document.addEventListener("visibilitychange", () => {
			if (panel === undefined || panel.hidden) return;
			if (document.visibilityState === "hidden") stopLive();
			else {
				void poll();
				startLive();
			}
		});
	}

	async function boot() {
		if (!(await reachable())) return;
		try {
			await prepare();
		} catch {
			/* a settings read that fails must not hide the panel */
		}
		registerWithHub();
		watchVisibility();
		if (await hubInstalled()) return;
		buildChrome();
	}

	// The injected script lands at the end of <body>; defer only if that is not
	// true, so the launcher appears with the rest of the UI.
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
	else void boot();
})();
