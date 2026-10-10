/**
 * dsh-remote — browser half.
 *
 * Injected into dsh's own web UI by the host half through the web server's
 * structured index injection, so it runs same-origin with the harness and can
 * call `/dsh-remote/api/*` directly.
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
	if (window.__dshRemoteLoaded === true) return;
	window.__dshRemoteLoaded = true;

	const BASE = "/dsh-remote";
	const API = `${BASE}/api`;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Remote", "手机远程"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		refresh: ["Refresh", "刷新"],
		remoteHint: ["Turning this on publishes your harness to whoever holds the link, on your local network or to the whole internet in tunnel mode. The link is the only credential.", "开启后，任何拿到链接的人都能访问你的 harness：局域网模式下是同网段，隧道模式下是整个互联网。链接就是唯一的凭证。"],
		stateOff: ["off", "已关闭"],
		stateStarting: ["starting…", "启动中…"],
		stateUp: ["up", "已开启"],
		stateError: ["error", "出错"],
		remoteMode: ["Channel", "通道"],
		modeTunnel: ["Cloudflare tunnel (works from any network)", "Cloudflare 隧道（任何网络都能连）"],
		modeLan: ["Local network only (nothing leaves your LAN)", "仅局域网（不出网）"],
		remoteEnable: ["Enable", "开启"],
		remoteDisable: ["Disable", "关闭"],
		resetLink: ["Reset link", "重置链接"],
		resetLinkHint: ["Issues a fresh credential: every link shared before this stops working", "换发新凭证：此前分享过的链接全部失效"],
		remoteLink: ["Link (send this to your phone)", "链接（发给手机）"],
		linkIsCredential: ["Treat the link as a credential: do not share it, and reset it if it leaks.", "把链接当凭证看待：不要外传；怀疑泄露就重置。"],
		qr: ["QR code", "二维码"],
		qrUnavailable: ["The qrcode package is not installed, so only the link is shown. Install it with:", "未安装 qrcode 包，因此只显示链接。安装命令："],
		remoteLanUrls: ["Local network addresses", "局域网地址"],
		copy: ["Copy", "复制"],
		copied: ["Copied", "已复制"],
		cloudflaredMissing: ["cloudflared was not found next to the dsh runtime, so tunnel mode cannot start. LAN mode still works.", "在 dsh 运行时旁没找到 cloudflared，隧道模式起不来；局域网模式仍可用。"],
		hint: ["On the phone, the harness UI is rewritten for a narrow screen, and a Project tab appears for browsing the current workspace.", "手机上 harness 界面会按窄屏改写，并多出一个「项目」标签页，可浏览当前工作区。"]
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

	let remote;
	let qrPath;
	let qrAvailable = false;
	let cloudflared;

	/** Copy text to the clipboard, with a fallback for non-secure contexts. */
	async function copy(text) {
		try {
			await navigator.clipboard.writeText(text);
			toast(T("copied"), text.slice(0, 60));
			return;
		} catch {
			/* fall through: the clipboard API needs a secure context */
		}
		const area = el("textarea", { style: "position:fixed;opacity:0" });
		area.value = text;
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		toast(ok ? T("copied") : T("failed"), ok ? text.slice(0, 60) : "clipboard unavailable");
	}

	/**
	 * Re-render while the tunnel is still coming up: an `enable` returns as soon
	 * as the proxy is listening, but cloudflared needs a few more seconds to print
	 * its hostname.
	 */
	function pollWhileStarting() {
		if (remote?.state === "starting" && (inHub || (panel !== undefined && !panel.hidden))) setTimeout(() => void render(), 2000);
	}

	async function render() {
		body.replaceChildren(el("div", { class: "muted", text: "…" }));
		try {
			const data = await getJson(`${API}/remote`);
			if (data.ok !== true) throw new Error(data.error ?? "failed to read remote state");
			remote = data.remote;
			qrPath = data.qrPath;
			qrAvailable = data.qrAvailable === true;
			cloudflared = data.cloudflared;
			body.replaceChildren(renderRemote());
			pollWhileStarting();
		} catch (error) {
			body.replaceChildren(el("div", { class: "row-sub", text: `${T("failed")}: ${String(error?.message ?? error)}` }));
		}
	}

	/** A read-only URL with a copy button. The URL clamps to two lines, so the
	    full link rides on the tooltip. */
	function linkRow(url) {
		return el("div", { class: "row" },
			el("div", { class: "row-main" }, el("div", { class: "row-sub", text: url, title: url })),
			el("div", { class: "row-actions" }, el("button", { text: T("copy"), onclick: () => void copy(url) })));
	}

	async function act(payload) {
		const result = await postJson(`${API}/remote`, payload);
		if (result.ok !== true) {
			toast(T("failed"), result.error);
			return;
		}
		void render();
	}

	function renderRemote() {
		const label = { off: T("stateOff"), starting: T("stateStarting"), up: T("stateUp"), error: T("stateError") }[remote.state] ?? remote.state;
		const fragment = document.createDocumentFragment();
		fragment.append(el("div", { class: "note", text: T("remoteHint") }));
		fragment.append(el("div", { class: "row" },
			el("div", { class: "row-main" },
				el("div", { class: "row-name", text: label }),
				el("div", { class: "row-sub", text: [remote.error, remote.tunnel === undefined ? "" : `tunnel: ${remote.tunnel}`, remote.proxyPort === undefined ? "" : `port ${String(remote.proxyPort)}`].filter(Boolean).join(" · ") }))));

		const mode = el("select", {},
			el("option", { value: "tunnel", text: T("modeTunnel"), selected: remote.mode === "tunnel" }),
			el("option", { value: "lan", text: T("modeLan"), selected: remote.mode === "lan" }));
		mode.addEventListener("change", () => void act({ action: "mode", mode: mode.value }));
		fragment.append(el("div", { class: "field" }, el("label", { text: T("remoteMode") }), mode));

		fragment.append(el("div", { class: "actions" },
			remote.enabled
				? el("button", { text: T("remoteDisable"), onclick: () => void act({ action: "disable" }) })
				: el("button", { class: "primary", text: T("remoteEnable"), onclick: () => void act({ action: "enable", mode: mode.value }) }),
			remote.enabled
				? el("button", { class: "danger", text: T("resetLink"), title: T("resetLinkHint"), onclick: () => void act({ action: "reset-token" }) })
				: undefined,
			// The hub's own header refreshes an embedded panel, so it hides this one.
			inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() })));

		if (cloudflared === null && remote.mode === "tunnel") fragment.append(el("div", { class: "note", text: T("cloudflaredMissing") }));

		const link = remote.link ?? remote.lanUrls?.[0];
		if (link !== undefined) {
			fragment.append(el("div", { class: "field" }, el("label", { text: T("remoteLink") }), linkRow(link)));
			fragment.append(el("div", { class: "note", text: T("linkIsCredential") }));
			fragment.append(el("div", { class: "field" }, el("label", { text: T("qr") }),
				qrAvailable
					// The QR encodes the link, so it is regenerated per render.
					? el("img", { src: `${qrPath}?v=${String(Date.now())}`, alt: "remote link QR code", style: "width:200px;height:200px;background:#fff;border-radius:8px;padding:6px" })
					: el("div", { class: "note", text: `${T("qrUnavailable")} dsh plugin --profile web add dsh-remote` })));
			fragment.append(el("div", { class: "note", text: T("hint") }));
		}

		// The LAN addresses stay useful as a fallback while a tunnel is up.
		if (remote.enabled && remote.mode === "tunnel" && (remote.lanUrls?.length ?? 0) > 0) {
			fragment.append(el("div", { class: "field" }, el("label", { text: T("remoteLanUrls") }),
				...remote.lanUrls.map((url) => linkRow(url))));
		}
		return fragment;
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
			el("span", { class: "dsh-launch-icon", text: "R" }),
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
		const root = el("div", { id: "dsh-remote-root" });
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
			remote: {
				title: T("title"),
				icon: "M5.5 2h5a1 1 0 011 1v10a1 1 0 01-1 1h-5a1 1 0 01-1-1V3a1 1 0 011-1zM7.2 12.3h1.6",
				order: 60,
				mount: mountInline
			}
		});
	}

	/** True when the host half answers — the panel is useless without it. */
	async function reachable() {
		try {
			const data = await getJson("/dsh-remote/api/remote");
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
