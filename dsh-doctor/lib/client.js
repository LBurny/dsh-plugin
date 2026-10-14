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
	/**
	 * Records this panel holds and paints. The host keeps a larger ring, so this is what
	 * a reader can actually reach: it has to be at least as deep as the history anyone
	 * wants to debug with, and low enough that rebuilding the list on every poll stays
	 * cheap. The rest of the ring is still there for the next visit.
	 */
	const WINDOW_LIMIT = 2000;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Doctor", "诊断"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		refresh: ["Refresh", "刷新"],
		runtime: ["Runtime", "运行状态"],
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
		keptWindow: ["window", "保留窗口"],
		mb: ["MB", "MB"],
		showsLast: ["shows the last", "显示最近"],
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
		copied: ["Copied", "已复制"],
		patches: ["Environment patches", "环境补丁"],
		patchesSummary: ["fixes for the running harness, switchable at any time", "对运行中的 dsh 所作的修补，随时可停用"],
		patchesNone: ["Nothing to patch here.", "这里没有需要修补的地方。"],
		patchesNotApplicable: ["this process never carried that variable, so the patch changes nothing here", "本进程本来就没有这个变量，此处修补不产生变化"],
		patchesAt: ["Decisions file", "决定文件"],
		remove: ["Delete", "删除"]
	};
	const T = (key) => STRINGS[key][ZH ? 1 : 0];

	/**
	 * Per-patch copy, keyed by the id the host half sends. Kept out of STRINGS because the
	 * host owns the catalog: a patch this panel has no text for (a newer host half behind
	 * a script the page cached) still renders, under its id.
	 */
	const PATCH_TEXT = {
		"electron-run-as-node": {
			name: ["Electron flag leak", "Electron 变量泄漏"],
			what: [
				"The desktop app runs the harness in Electron's Node mode, so ELECTRON_RUN_AS_NODE=1 sits in this very process and every program it starts inherits it. An Electron editor then starts as plain Node, is handed the folder as a script, and dies, which dsh reports as a failed launch. This patch drops that variable for this process. One child needs it back: the folder chooser a phone or a LAN browser asks for is started as this same executable, so the variable is lent to that one call and taken back as it returns.",
				"桌面应用以 Electron 的 Node 模式运行 dsh，于是 ELECTRON_RUN_AS_NODE=1 留在本进程里，被它启动的每个程序都会继承。Electron 系编辑器因此会以纯 Node 启动、把文件夹当脚本执行然后失败，dsh 报为打开失败。本补丁只在当前进程里去掉这个变量。有一个子进程需要把它要回来：手机或局域网浏览器请求的文件夹选择器以同一个可执行文件启动，因此只在这一次调用期间把变量交给它，调用返回即收回。"
			]
		}
	};

	/** One patch's text in the page's language, or the fallback. */
	function patchText(id, field, fallback) {
		return PATCH_TEXT[id]?.[field]?.[ZH ? 1 : 0] ?? fallback;
	}

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
		/** What the host keeps before it trims, as it reported it; undefined on an older host. */
		retention: undefined,
		lastSn: 0,
		level: "all",
		onlyOurs: false,
		match: "",
		list: undefined
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
			// A host half that predates the patch section answers 404 here, and no section is
			// the right answer to that: there is nothing for the reader to switch.
			const patches = await getJson(`${API}/patches`).catch(() => undefined);
			readLog(log);
			// 运行状态, 插件行, 日志 (with the log files as a section of their own),
			// and only then the patches: a fix this plugin applies to the harness is
			// the page's footnote, not its headline.
			const sections = [...renderStatus(snapshot.status), ...renderLogs()];
			const patchSection = renderPatches(patches);
			if (patchSection !== undefined) sections.push(patchSection);
			body.replaceChildren(...sections);
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
		logView.retention = payload?.retention;
		logView.records = payload?.reset === true ? incoming : [...logView.records, ...incoming];
		if (logView.records.length > WINDOW_LIMIT) logView.records = logView.records.slice(-WINDOW_LIMIT);
		logView.lastSn = logView.records.at(-1)?.sn ?? 0;
	}

	/**
	 * A section heading, the way dsh's own 插件 page heads its groups (官方 8,
	 * 已安装 8): the label, with the section's summary muted beside it on the
	 * same baseline.
	 */
	function sectionHead(title, meta) {
		return el("div", { class: "sect-head" },
			el("label", { text: title }),
			meta === undefined || meta === "" ? undefined : el("span", { class: "sect-meta", text: meta, title: meta }));
	}

	/**
	 * The runtime facts as one card of label/value cells, then the plugin tree.
	 * The fact grid sizes itself from the width it gets: three columns in the
	 * hub page, two in the floating panel, one on the phone, with no breakpoint
	 * to keep in step.
	 */
	function renderStatus(status) {
		const fact = (label, text) => el("div", { class: "fact" },
			el("span", { class: "fact-k", text: label }),
			el("span", { class: "fact-v", text: text ?? "?", title: text ?? "" }));
		return [
			el("div", { class: "section" },
				sectionHead(T("runtime")),
				el("div", { class: "card" },
					el("div", { class: "facts" },
						fact("dsh", String(status.version)),
						fact("node", status.node),
						fact("platform", `${status.platform} ${status.arch}`),
						fact(T("port"), String(status.port ?? "?")),
						fact(T("pid"), String(status.pid)),
						fact(T("uptime"), `${String(status.uptimeSeconds)} ${T("seconds")}`),
						fact(T("memory"), `${String(status.memoryMb)} MB`),
						fact(T("profile"), status.profile),
						fact(T("sessions"), status.sessions === undefined ? "?" : String(status.sessions)),
						fact(T("dshHome"), status.dshHome),
						fact(T("patch"), status.patchPath),
						fact(T("capture"), status.capture === undefined || status.capture.attached !== true
							? `${T("captureOff")}${status.capture?.reason === undefined ? "" : ` (${status.capture.reason})`}`
							: `${String(status.capture.records)} ${T("records")}${status.capture.bytes > 0 ? ` · ${String(Math.round(status.capture.bytes / 1024))} KB` : ""}`)))),
			renderRows(status)
		];
	}

	/**
	 * The patch section: one row per patch, each with a switch and a delete control, so a
	 * fix this plugin applies to its own process can be taken back at any time. It comes
	 * last on the page: it is a footnote about the harness, not the panel's headline.
	 * Nothing is rendered when the host half has no patch route or no patches left.
	 */
	function renderPatches(payload) {
		const patches = Array.isArray(payload?.patches) ? payload.patches : [];
		if (patches.length === 0) return undefined;
		return el("div", { class: "section" },
			sectionHead(T("patches"), T("patchesSummary")),
			...patches.map((patch) => renderPatch(patch)),
			payload.configPath === undefined ? undefined : el("div", { class: "note", text: `${T("patchesAt")}: ${String(payload.configPath)}` }));
	}

	/** One patch: what it fixes, a switch, and the control that takes it off the list. */
	function renderPatch(patch) {
		const name = patchText(patch.id, "name", patch.id);
		const what = patchText(patch.id, "what", patch.variable);
		return row(name, patch.applicable === false ? `${what} (${T("patchesNotApplicable")})` : what, patch.enabled,
			(enabled) => postJson(`${API}/patches`, { action: "toggle", id: patch.id, enabled }).then(assertOk),
			[el("button", {
				class: "danger",
				text: T("remove"),
				onclick: async () => {
					try {
						await postJson(`${API}/patches`, { action: "delete", id: patch.id }).then(assertOk);
					} catch (error) {
						toast(T("failed"), String(error?.message ?? error));
					}
					void render();
				}
			})]);
	}

	/** The plugin tree: one line per row, failed and required rows called out. */
	function renderRows(status) {
		const rows = Array.isArray(status.rows) ? status.rows : [];
		if (status.rowsAvailable !== true) {
			return el("div", { class: "section" },
				sectionHead(T("rows")),
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
			sectionHead(T("rows"), summary),
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
		const list = logView.list;
		if (list === undefined) return;
		// Whether the reader is following the tail has to be read *before* the list is
		// replaced: afterwards the new content has already moved the scroll. Pinning the
		// view to the bottom unconditionally meant every poll that brought a record yanked
		// it there, which is what made scrollback unreadable while anything was being
		// logged, the one moment this panel exists for.
		const following = list.scrollHeight - list.scrollTop - list.clientHeight <= 24;
		const records = visibleRecords();
		const children = records.length === 0
			? [el("div", { class: "note", text: logView.records.length === 0 ? T("noLogs") : `${T("filter")}: 0/${String(logView.records.length)}` })]
			: records.map(renderRecord);
		list.replaceChildren(...children);
		if (following) list.scrollTop = list.scrollHeight;
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

	/** The log view: where the records came from, the filters, the lines. */
	function renderLogs() {
		const source = logView.source === "capture" ? T("sourceCapture") : logView.source === "plugin" ? T("sourcePlugin") : logView.source;
		// "47 records" invites the question of whether that is all of them or a trimmed tail,
		// so the memory the host is holding them in, and how many of them this panel paints,
		// both ride along when the host reports a budget.
		const window_ = logView.retention === undefined
			? ""
			: ` · ${T("keptWindow")} ${String(Math.round(logView.retention.bytes / 1024 / 1024))} ${T("mb")} / ${T("showsLast")} ${String(WINDOW_LIMIT)} ${T("records")}`;
		const meta = `${T("logSource")}: ${source}${logView.records.length === 0 ? "" : ` · ${String(logView.records.length)} ${T("records")}`}${window_}${logView.reason === undefined ? "" : ` · ${String(logView.reason)}`}`;
		logView.list = el("div", { class: "loglines" });
		const section = el("div", { class: "section" }, sectionHead(T("logs"), meta), renderFilters(), logView.list);
		paintRecords();
		// The on-disk files are a section of their own, so the heading keeps the same
		// gap off the log box as every other section, and each file renders open: a
		// file the reader opened this page to see should not sit behind a second click.
		if (logView.files.length === 0) return [section];
		return [section, el("div", { class: "section" },
			sectionHead(T("files")),
			...logView.files.map((file) => el("details", { open: true },
				el("summary", { text: `${file.source} · ${file.path} · ${String((file.lines ?? []).length)}` }),
				el("pre", { class: "logs", text: (file.lines ?? []).join("\n") }))))];
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
				// The hub's own header refreshes an embedded panel, so this one exists only
				// in the floating panel (the hub also sweeps the marker to be sure).
				inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() }),
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
				order: 60,
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
