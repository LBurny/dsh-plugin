/**
 * dsh-mcp — browser half.
 *
 * Injected into dsh's own web UI by the host half through the web server's
 * structured index injection, so it runs same-origin with the harness and can
 * call `/dsh-mcp/api/*` directly.
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
	if (window.__dshMcpLoaded === true) return;
	window.__dshMcpLoaded = true;

	const BASE = "/dsh-mcp";
	const API = `${BASE}/api`;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["MCP", "MCP 服务"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		refresh: ["Refresh", "刷新"],
		cancel: ["Cancel", "取消"],
		add: ["Add server…", "添加服务…"],
		edit: ["Edit", "编辑"],
		remove: ["Delete", "删除"],
		importServers: ["Import servers…", "导入服务…"],
		noServers: ["No MCP servers configured in this profile.", "本 profile 还没有配置 MCP 服务。"],
		patch: ["Patch layer", "补丁层"],
		savedReload: ["saved, dsh reloads it without a restart", "已保存，dsh 会自动重载，无需重启"],
		serverName: ["Name", "名称"],
		transport: ["Transport", "传输方式"],
		command: ["Command", "命令"],
		args: ["Arguments (one per line)", "参数（每行一个）"],
		env: ["Environment (KEY=VALUE per line)", "环境变量（每行 KEY=VALUE）"],
		cwd: ["Working directory", "工作目录"],
		url: ["URL", "URL"],
		headers: ["Headers (KEY=VALUE per line)", "请求头（每行 KEY=VALUE）"],
		save: ["Save", "保存"],
		source: ["Source", "来源"],
		onConflict: ["If it already exists", "若已存在"],
		conflictSkip: ["Skip", "跳过"],
		conflictOverwrite: ["Overwrite", "覆盖"],
		import: ["Import", "导入"],
		notAvailable: ["not found", "未找到"],
		alreadyInstalled: ["⚠ already installed", "⚠ 已安装"],
		unsupported: ["unsupported transport", "不支持的传输方式"]
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

	async function render() {
		body.replaceChildren(el("div", { class: "muted", text: "…" }));
		try {
			body.replaceChildren(await renderServers());
		} catch (error) {
			body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
		}
	}

	async function renderServers() {
		const data = await getJson(`${API}/mcp`);
		if (data.ok !== true) throw new Error(data.error ?? "failed to list MCP servers");
		const fragment = document.createDocumentFragment();
		fragment.append(el("div", { class: "actions" },
			el("button", { text: T("add"), onclick: () => showServerForm(undefined) }),
			el("button", { text: T("importServers"), onclick: () => showServerImport(data.sources) }),
			// The hub's own header refreshes an embedded panel, so it hides this one.
			inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() })));
		fragment.append(el("div", { class: "note", text: `${T("patch")}: ${data.patchPath}` }));
		fragment.append(el("div", { class: "note", text: T("savedReload") }));
		if (data.servers.length === 0) fragment.append(el("div", { class: "note", text: T("noServers") }));
		for (const server of data.servers) {
			fragment.append(row(server.serverName, `${server.transport} · ${server.summary}`, server.enabled,
				(enabled) => postJson(`${API}/mcp`, { action: "toggle", id: server.id, enabled }).then(assertOk),
				[
					el("button", { text: T("edit"), onclick: () => showServerForm(server) }),
					el("button", {
						class: "danger",
						text: T("remove"),
						onclick: async () => {
							try {
								await postJson(`${API}/mcp`, { action: "delete", id: server.id }).then(assertOk);
							} catch (error) {
								toast(T("failed"), String(error?.message ?? error));
							}
							void render();
						}
					})
				]));
		}
		return fragment;
	}

	/** Add/edit form for one MCP server. */
	function showServerForm(server) {
		// Keep advanced keys the form does not own (timeouts, reconnect) by starting
		// from the existing config and only overwriting the fields below.
		const current = server?.config ?? {};
		const name = el("input", { value: current.serverName ?? "" });
		const transport = el("select", {},
			el("option", { value: "stdio", text: "stdio" }),
			el("option", { value: "streamable-http", text: "streamable-http" }));
		transport.value = current.transport === "streamable-http" ? "streamable-http" : "stdio";
		const command = el("input", { value: current.command ?? "" });
		const args = el("textarea", { rows: 3, text: (current.args ?? []).join("\n") });
		const env = el("textarea", { rows: 3, text: pairsToText(current.env) });
		const cwd = el("input", { value: current.cwd ?? "" });
		const url = el("input", { value: current.url ?? "" });
		const headers = el("textarea", { rows: 3, text: pairsToText(current.headers) });
		const stdioFields = el("div", {},
			el("div", { class: "field" }, el("label", { text: T("command") }), command),
			el("div", { class: "field" }, el("label", { text: T("args") }), args),
			el("div", { class: "field" }, el("label", { text: T("env") }), env),
			el("div", { class: "field" }, el("label", { text: T("cwd") }), cwd));
		const httpFields = el("div", {},
			el("div", { class: "field" }, el("label", { text: T("url") }), url),
			el("div", { class: "field" }, el("label", { text: T("headers") }), headers));
		const sync = () => {
			stdioFields.hidden = transport.value !== "stdio";
			httpFields.hidden = transport.value !== "streamable-http";
		};
		transport.addEventListener("change", sync);
		sync();
		const close = () => showView(renderServers);
		showView(async () => el("div", {},
			el("div", { class: "field" }, el("label", { text: T("serverName") }), name),
			el("div", { class: "field" }, el("label", { text: T("transport") }), transport),
			stdioFields,
			httpFields,
			el("div", { class: "actions" },
				el("button", {
					class: "primary",
					text: T("save"),
					onclick: async () => {
						const payload = {
							serverName: name.value.trim(),
							transport: transport.value,
							command: command.value,
							args: args.value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== ""),
							env: parsePairs(env.value),
							cwd: cwd.value,
							url: url.value,
							headers: parsePairs(headers.value)
						};
						const result = await postJson(`${API}/mcp`, { action: "upsert", server: payload, currentId: server?.id });
						if (result.ok !== true) {
							toast(T("failed"), result.error);
							return;
						}
						toast(T("title"), `${result.id}：${T("savedReload")}`);
						close();
					}
				}),
				el("button", { text: T("cancel"), onclick: close }))));
	}

	/** Import dialog for MCP servers found in other agent tool configs. */
	function showServerImport(sources) {
		const selected = new Set();
		const policy = el("select", {},
			el("option", { value: "skip", text: T("conflictSkip") }),
			el("option", { value: "overwrite", text: T("conflictOverwrite") }));
		const sourceSelect = el("select", {});
		for (const source of sources) sourceSelect.append(el("option", { value: source.id, text: `${source.label}${source.available ? "" : ` (${T("notAvailable")})`}` }));
		const list = el("div", {});
		const paint = () => {
			const source = sources.find((entry) => entry.id === sourceSelect.value);
			selected.clear();
			list.replaceChildren();
			if (source === undefined || !source.available || source.servers.length === 0) {
				list.append(el("div", { class: "note", text: T("noServers") }));
				return;
			}
			for (const server of source.servers) {
				const box = el("input", { type: "checkbox", disabled: server.unsupported });
				box.addEventListener("change", () => (box.checked ? selected.add(server.serverName) : selected.delete(server.serverName)));
				list.append(el("label", { class: "row" }, box,
					el("div", { class: "row-main" },
						el("div", { class: "row-name", text: server.serverName }),
						el("div", { class: "row-sub", text: [server.transport, server.command ?? server.url, server.conflict ? T("alreadyInstalled") : "", server.unsupported ? T("unsupported") : ""].filter(Boolean).join(" · ") }))));
			}
		};
		sourceSelect.addEventListener("change", paint);
		paint();
		const close = () => showView(renderServers);
		showView(async () => el("div", {},
			el("div", { class: "field" }, el("label", { text: T("source") }), sourceSelect),
			list,
			el("div", { class: "field" }, el("label", { text: T("onConflict") }), policy),
			el("div", { class: "actions" },
				el("button", {
					class: "primary",
					text: T("import"),
					onclick: async () => {
						const result = await postJson(`${API}/mcp`, { action: "import", source: sourceSelect.value, names: [...selected], onConflict: policy.value });
						if (result.ok !== true) {
							toast(T("failed"), result.error);
							return;
						}
						toast(T("import"), `${result.imported.length} → ${result.skipped.length}`);
						close();
					}
				}),
				el("button", { text: T("cancel"), onclick: close }))));
	}

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
			el("span", { class: "dsh-launch-icon", text: "M" }),
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
		const root = el("div", { id: "dsh-mcp-root" });
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
			mcp: {
				title: T("title"),
				icon: "M6 2.5V6M10 2.5V6M4 6h8v2.5a4 4 0 01-8 0V6zM8 12.5V14",
				order: 20,
				mount: mountInline
			}
		});
	}

	/** True when the host half answers — the panel is useless without it. */
	async function reachable() {
		try {
			const data = await getJson("/dsh-mcp/api/mcp");
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
