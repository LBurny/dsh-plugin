/**
 * dsh-skills — browser half.
 *
 * Injected into dsh's own web UI by the host half through the web server's
 * structured index injection, so it runs same-origin with the harness and can
 * call `/dsh-skills/api/*` directly.
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
	if (window.__dshSkillsLoaded === true) return;
	window.__dshSkillsLoaded = true;

	const BASE = "/dsh-skills";
	const API = `${BASE}/api`;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Skills", "技能"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		refresh: ["Refresh", "刷新"],
		cancel: ["Cancel", "取消"],
		importSkills: ["Import skills…", "导入技能…"],
		importZip: ["Import ZIP…", "导入 ZIP…"],
		remove: ["Delete", "删除"],
		enabled: ["enabled", "已启用"],
		disabled: ["disabled", "已停用"],
		noSkills: ["No skills found.", "没有找到技能。"],
		source: ["Source", "来源"],
		onConflict: ["If it already exists", "若已存在"],
		conflictSkip: ["Skip", "跳过"],
		conflictOverwrite: ["Overwrite", "覆盖"],
		import: ["Import", "导入"],
		notAvailable: ["not found", "未找到"],
		alreadyInstalled: ["⚠ already installed", "⚠ 已安装"],
		zipHint: ["pick the skills to import; folders containing SKILL.md are detected automatically", "勾选要导入的技能；含 SKILL.md 的目录会被自动识别"],
		summary: ["skills", "个技能"],
		badZip: ["not a valid ZIP file", "不是有效的 ZIP 文件"]
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
			body.replaceChildren(await renderSkills());
		} catch (error) {
			body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
		}
	}

	async function renderSkills() {
		const data = await getJson(`${API}/skills`);
		if (data.ok !== true) throw new Error(data.error ?? "failed to list skills");
		const fragment = document.createDocumentFragment();
		fragment.append(el("div", { class: "actions" },
			el("button", { text: T("importSkills"), onclick: () => showSkillImport(data.sources) }),
			el("button", { text: T("importZip"), onclick: () => showZipImport() }),
			// The hub's own header refreshes an embedded panel, so it hides this one.
			inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() })));
		fragment.append(el("div", { class: "muted", text: `${data.skills.length} ${T("summary")} · ${data.counts?.enabled ?? "?"}/${data.counts?.total ?? "?"} ${T("enabled")}` }));
		if (data.skills.length === 0) fragment.append(el("div", { class: "note", text: T("noSkills") }));
		for (const skill of data.skills) {
			fragment.append(row(skill.name, skill.description || (skill.enabled ? T("enabled") : T("disabled")), skill.enabled,
				(enabled) => postJson(`${API}/skills`, { action: "toggle", name: skill.name, enabled }).then(assertOk),
				[el("button", {
					class: "danger",
					text: T("remove"),
					onclick: async () => {
						try {
							await postJson(`${API}/skills`, { action: "delete", name: skill.name }).then(assertOk);
						} catch (error) {
							toast(T("failed"), String(error?.message ?? error));
						}
						void render();
					}
				})]));
		}
		return fragment;
	}

	/** Conflict policy select, shared by both import dialogs. */
	function conflictSelect() {
		return el("select", {},
			el("option", { value: "skip", text: T("conflictSkip") }),
			el("option", { value: "overwrite", text: T("conflictOverwrite") }));
	}

	/** A tickable row for one importable skill. */
	function skillChoice(skill, selected, checked) {
		const box = el("input", { type: "checkbox" });
		box.checked = checked;
		box.addEventListener("change", () => (box.checked ? selected.add(skill.name) : selected.delete(skill.name)));
		return el("label", { class: "row" }, box,
			el("div", { class: "row-main" },
				el("div", { class: "row-name", text: skill.name }),
				el("div", { class: "row-sub", text: [skill.description, skill.conflict ? T("alreadyInstalled") : ""].filter(Boolean).join(" · ") })));
	}

	/** Import dialog: pick a source, tick skills, choose the conflict policy. */
	function showSkillImport(sources) {
		const selected = new Set();
		const policy = conflictSelect();
		const list = el("div", {});
		const sourceSelect = el("select", {});
		for (const source of sources) {
			sourceSelect.append(el("option", { value: source.id, text: `${source.label}${source.available ? "" : ` (${T("notAvailable")})`}`, disabled: !source.available }));
		}
		const paint = () => {
			const source = sources.find((entry) => entry.id === sourceSelect.value);
			selected.clear();
			list.replaceChildren();
			if (source === undefined || !source.available || source.skills.length === 0) {
				list.append(el("div", { class: "note", text: T("noSkills") }));
				return;
			}
			for (const skill of source.skills) list.append(skillChoice(skill, selected, false));
		};
		sourceSelect.addEventListener("change", paint);
		paint();
		const close = () => showView(renderSkills);
		showView(async () => el("div", {},
			el("div", { class: "field" }, el("label", { text: T("source") }), sourceSelect),
			list,
			el("div", { class: "field" }, el("label", { text: T("onConflict") }), policy),
			el("div", { class: "actions" },
				el("button", {
					class: "primary",
					text: T("import"),
					onclick: async () => {
						const result = await postJson(`${API}/skills`, { action: "import", source: sourceSelect.value, names: [...selected], onConflict: policy.value });
						if (result.ok !== true) {
							toast(T("failed"), result.error);
							return;
						}
						toast(T("import"), `${result.imported.length} → ${result.skipped.length} ${T("conflictSkip")}`);
						close();
					}
				}),
				el("button", { text: T("cancel"), onclick: close }))));
	}

	/** ZIP import, step one: pick the file and upload it for inspection. */
	function showZipImport() {
		const input = el("input", { type: "file", accept: ".zip,application/zip", style: "display:none" });
		document.body.append(input);
		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			input.remove();
			if (file === undefined) return;
			let result;
			try {
				const response = await fetch(`${API}/skills/zip?name=${encodeURIComponent(file.name)}`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/zip" },
					body: file
				});
				result = await response.json();
			} catch (error) {
				toast(T("failed"), String(error?.message ?? error));
				return;
			}
			if (result?.ok !== true) {
				toast(T("failed"), result?.error ?? T("badZip"));
				return;
			}
			showZipPicker(result.uploadId, result.skills ?? [], file.name);
		});
		input.click();
	}

	/** ZIP import, step two: tick the discovered skills and confirm. */
	function showZipPicker(uploadId, skills, archiveName) {
		// Non-conflicting skills start ticked: the common case is "import all".
		const selected = new Set(skills.filter((skill) => skill.conflict !== true).map((skill) => skill.name));
		const policy = conflictSelect();
		const list = el("div", {});
		for (const skill of skills) list.append(skillChoice(skill, selected, selected.has(skill.name)));
		const close = () => showView(renderSkills);
		showView(async () => el("div", {},
			el("div", { class: "note", text: `${archiveName} · ${T("zipHint")}` }),
			list,
			el("div", { class: "field" }, el("label", { text: T("onConflict") }), policy),
			el("div", { class: "actions" },
				el("button", {
					class: "primary",
					text: T("import"),
					onclick: async () => {
						const result = await postJson(`${API}/skills`, { action: "import-zip", uploadId, names: [...selected], onConflict: policy.value });
						if (result.ok !== true) {
							toast(T("failed"), result.error);
							return;
						}
						const failed = (result.errors ?? []).length;
						toast(T("import"), `${result.imported.length} → ${result.skipped.length} ${T("conflictSkip")}${failed > 0 ? ` · ${failed} ${T("failed")}` : ""}`);
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
			el("span", { class: "dsh-launch-icon", text: "S" }),
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
		const root = el("div", { id: "dsh-skills-root" });
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
			skills: {
				title: T("title"),
				icon: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5L8 2z",
				order: 10,
				mount: mountInline
			}
		});
	}

	/** True when the host half answers — the panel is useless without it. */
	async function reachable() {
		try {
			const data = await getJson("/dsh-skills/api/skills");
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
