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
	/** How often an open panel re-asks while an enable has not produced its link yet. */
	const LINK_POLL_MS = 2000;
	/** Stop waiting for a link after this long; a channel with no usable address never makes one. */
	const LINK_WAIT_MS = 90_000;

	// ------------------------------------------------------------------ i18n

	const ZH = (navigator.language || "").toLowerCase().startsWith("zh");
	const STRINGS = {
		title: ["Remote", "手机远程"],
		close: ["Close", "关闭"],
		failed: ["Failed", "失败"],
		working: ["Working…", "处理中…"],
		refresh: ["Refresh", "刷新"],
		remoteHint: ["Turning this on serves your harness to whoever holds the link: inside your Tailscale tailnet, or on your local network, or, in tunnel mode, to the whole internet. The link is the only credential.", "开启后，任何拿到链接的人都能访问你的 harness：Tailscale 私有网络或局域网范围内可连，隧道模式下则是整个互联网。链接就是唯一的凭证。"],
		stateOff: ["off", "已关闭"],
		stateStarting: ["starting…", "启动中…"],
		stateUp: ["up", "已开启"],
		stateError: ["error", "出错"],
		remoteMode: ["Channel", "通道"],
		modeTailnet: ["Tailscale tailnet (private, stable address)", "Tailscale 私有网络（地址稳定）"],
		modeTunnel: ["Cloudflare tunnel (works from any network)", "Cloudflare 隧道（任何网络都能连）"],
		modeLan: ["Local network only (only devices on your Wi-Fi)", "仅局域网（只有同 Wi-Fi 的设备能连）"],
		tailnetHint: ["Join this machine and your phone to the same tailnet and this channel answers only inside it. Nothing is published to the internet, no port is opened, and the link stays the same across restarts.", "把这台机器和手机加入同一个 tailnet，这个通道只在 tailnet 内应答。不发布到公网、不开放端口，链接在重启后保持不变。"],
		tailnetMissing: ["No Tailscale address was found on this machine. Install Tailscale here, sign in, then enable again. The phone has to join the same tailnet.", "本机没找到 Tailscale 地址。请在这里安装 Tailscale 并登录后再开启；手机需要加入同一个 tailnet。"],
		tailnetNotRunning: ["Tailscale is installed but its backend is not running. Open Tailscale on this machine and sign in.", "Tailscale 已安装但后端未运行。请在本机打开 Tailscale 并登录。"],
		tailnetCliMissing: ["The tailscale CLI was not found, so the link uses the address instead of the MagicDNS name. That still works; the name only matters if the device is removed from the tailnet and added again.", "没找到 tailscale 命令行，链接会用地址代替 MagicDNS 名称。这仍然可用；只有设备被移出 tailnet 再重新加入时名称才重要。"],
		remoteEnable: ["Enable", "开启"],
		remoteDisable: ["Disable", "关闭"],
		resetLink: ["Reset link", "重置链接"],
		resetLinkHint: ["Issues a fresh credential: every link shared before this stops working", "换发新凭证：此前分享过的链接全部失效"],
		remoteLink: ["Link (send this to your phone)", "链接（发给手机）"],
		linkIsCredential: ["Treat the link as a credential: do not share it, and reset it if it leaks.", "把链接当凭证看待：不要外传；怀疑泄露就重置。"],
		linkKept: ["Link unchanged: the tunnel from the last session is still running, so the phone keeps working.", "链接未变：沿用了上次留下的隧道，手机上那条不用重新扫码。"],
		qr: ["QR code", "二维码"],
		qrUnavailable: ["The qrcode package is not installed, so only the link is shown. Install it with:", "未安装 qrcode 包，因此只显示链接。安装命令："],
		copy: ["Copy", "复制"],
		copied: ["Copied", "已复制"],
		cloudflaredMissing: ["Tunnel mode needs the cloudflared binary, and neither app ships one. It was not on PATH, next to the dsh runtime, nor in <dsh home>/../tunnel. Install it (winget install Cloudflare.cloudflared), or paste its path below. LAN mode needs nothing, and Tailscale mode needs only Tailscale.", "隧道模式需要 cloudflared 程序，两个应用都没自带。PATH、dsh 运行时旁、<dsh home>/../tunnel 都没找到。可先安装（winget install Cloudflare.cloudflared），或在下面填上它的路径。局域网模式什么都不需要，Tailscale 模式只需要 Tailscale 本身。"],
		binary: ["Tunnel binary", "隧道程序"],
		binaryFound: ["cloudflared found", "已找到 cloudflared"],
		binaryPath: ["Path to cloudflared", "cloudflared 路径"],
		binaryPlaceholder: ["C:/path/to/cloudflared.exe", "C:/路径/cloudflared.exe"],
		binarySave: ["Save path", "保存路径"],
		binaryClear: ["Search automatically", "自动查找"],
		binaryFoundHere: ["found on this machine", "本机已装"],
		binaryInstalled: ["installed by the plugin", "插件自动装好"],
		binaryManual: ["path set by you", "手动指定"],
		installChecking: ["Checking whether this machine has cloudflared.", "正在检查本机有没有 cloudflared。"],
		installDownloading: ["Downloading cloudflared from Cloudflare:", "正在从 Cloudflare 下载 cloudflared："],
		installRetry: ["Install it for me", "帮我安装"],
		installErrorManifest: ["Cloudflare's release list could not be read. Check the network, or set a proxy below.", "读不到 Cloudflare 的发布清单。检查网络，或在下面填一个代理。"],
		installErrorDownload: ["The download failed. Where GitHub is unreachable, a proxy fixes it.", "下载失败。在 GitHub 不可达的网络里，填一个代理通常就能解决。"],
		installErrorChecksum: ["The downloaded file did not match Cloudflare's checksum, so it was discarded.", "下载的文件与 Cloudflare 公布的校验值不符，已丢弃。"],
		installErrorSignature: ["The downloaded file is not signed by Cloudflare, so it was discarded.", "下载的文件没有 Cloudflare 的签名，已丢弃。"],
		installErrorUnpack: ["The downloaded archive held no usable cloudflared binary, so it was discarded.", "下载的压缩包里没有可用的 cloudflared，已丢弃。"],
		installErrorUnsupported: ["This platform has no cloudflared build to fetch automatically. Set a path below.", "这个平台上没有可自动获取的 cloudflared 版本，请在下面填一个路径。"],
		proxyLabel: ["Proxy for the download", "下载用代理"],
		proxyHint: ["Optional. Empty means the HTTPS_PROXY environment variable is used. For example http://127.0.0.1:7890.", "可选。留空则只看 HTTPS_PROXY 环境变量。例如 http://127.0.0.1:7890。"],
		proxySave: ["Save proxy", "保存代理"],
		proxyPlaceholder: ["http://127.0.0.1:7890", "http://127.0.0.1:7890"],
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
	/** What the host half's installer last reported: `{state, source?, version?, error?}`. */
	let cloudflaredSetup = {};
	/** When this panel started waiting for a link, or undefined while it is not waiting. */
	let waitingSince;
	/** The path the reader configured, if any (empty means "search automatically"). */
	let cloudflaredPath;

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
	 * Re-render while a link is still on its way. An `enable` answers as soon as the
	 * proxy is listening, but in tunnel mode the link only exists once cloudflared has
	 * printed its hostname, seconds later, and the manager already reads "up" by then.
	 * Waiting on that state name alone therefore left the panel showing no link and no
	 * QR until the page was remounted, so this waits on the link itself too. The
	 * deadline stops it asking forever when a channel has no address to link to.
	 */
	function pollWhileStarting() {
		if (!(inHub || (panel !== undefined && !panel.hidden))) return;
		const noLink = (remote?.link ?? remote?.lanUrls?.[0]) === undefined;
		const waiting = remote?.state === "starting"
			|| remote?.tunnel?.state === "starting"
			|| (remote?.enabled === true && noLink);
		if (!waiting) {
			waitingSince = undefined;
			return;
		}
		waitingSince ??= Date.now();
		if (Date.now() - waitingSince > LINK_WAIT_MS) {
			waitingSince = undefined;
			return;
		}
		setTimeout(() => void render(), LINK_POLL_MS);
	}

	/**
	 * Keep asking while the plugin is fetching cloudflared: the download runs for
	 * seconds to minutes, and a panel painted once would sit on "downloading" forever.
	 * A settled state (ready, failed, or no report at all) schedules nothing.
	 */
	function pollWhileInstalling() {
		if (!(inHub || (panel !== undefined && !panel.hidden))) return;
		const state = cloudflaredSetup.state;
		if (state !== "checking" && state !== "downloading") return;
		setTimeout(() => void render(), LINK_POLL_MS);
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
			cloudflaredPath = data.remote?.cloudflaredPath;
			// Absent from a host half that predates the installer, so it reads as "no
			// report" rather than breaking the panel.
			cloudflaredSetup = data.cloudflaredSetup ?? {};
			body.replaceChildren(renderRemote());
			pollWhileStarting();
			pollWhileInstalling();
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
		// The tunnel's own state, never its handle: the snapshot carries `{state, url, error}`
		// there, and stringifying that whole object into this row prints "[object Object]".
		const tunnel = remote.tunnel === undefined ? "" : typeof remote.tunnel === "string" ? remote.tunnel : remote.tunnel.state;
		const fragment = document.createDocumentFragment();
		fragment.append(el("div", { class: "note", text: T("remoteHint") }));
		fragment.append(el("div", { class: "row" },
			el("div", { class: "row-main" },
				el("div", { class: "row-name", text: label }),
				el("div", { class: "row-sub", text: [remote.error, tunnel === "" ? "" : `tunnel: ${tunnel}`, remote.proxyPort === undefined ? "" : `port ${String(remote.proxyPort)}`].filter(Boolean).join(" · ") }))));

		const mode = el("select", {},
			el("option", { value: "tailnet", text: T("modeTailnet"), selected: remote.mode === "tailnet" }),
			el("option", { value: "lan", text: T("modeLan"), selected: remote.mode === "lan" }),
			el("option", { value: "tunnel", text: T("modeTunnel"), selected: remote.mode === "tunnel" }));
		mode.addEventListener("change", () => void act({ action: "mode", mode: mode.value }));
		fragment.append(el("div", { class: "field" }, el("label", { text: T("remoteMode") }), mode));

		// The tailnet is the only channel with a prerequisite on this machine, so it
		// explains itself: that it stays private, and what to do when the address is
		// missing or Tailscale is installed but not running.
		if (remote.mode === "tailnet") {
			fragment.append(el("div", { class: "note", text: T("tailnetHint") }));
			const info = remote.tailnet ?? {};
			const notRunning = typeof info.backendState === "string" && info.backendState !== "Running";
			if (info.address === undefined) fragment.append(el("div", { class: "note", text: notRunning ? T("tailnetNotRunning") : T("tailnetMissing") }));
			else if (notRunning) fragment.append(el("div", { class: "note", text: T("tailnetNotRunning") }));
			else if (info.dnsName === undefined && info.cli === null) fragment.append(el("div", { class: "note", text: T("tailnetCliMissing") }));
		}

		fragment.append(el("div", { class: "actions" },
			remote.enabled
				? el("button", { text: T("remoteDisable"), onclick: () => void act({ action: "disable" }) })
				: el("button", { class: "primary", text: T("remoteEnable"), onclick: () => void act({ action: "enable", mode: mode.value }) }),
			remote.enabled
				? el("button", { class: "danger", text: T("resetLink"), title: T("resetLinkHint"), onclick: () => void act({ action: "reset-token" }) })
				: undefined,
			// The hub's own header refreshes an embedded panel, so it hides this one.
			inHub ? undefined : el("button", { "data-dsh-refresh": "", text: T("refresh"), onclick: () => void render() })));

		// The tunnel binary is a prerequisite neither app supplies, and the host half now
		// installs one itself, so the panel reports where it came from and only falls back
		// to asking for a path when that install could not run.
		const source = { found: T("binaryFoundHere"), manual: T("binaryManual"), installed: T("binaryInstalled") }[cloudflaredSetup.source];
		if (typeof cloudflared === "string") {
			fragment.append(el("div", { class: "field" }, el("label", { text: T("binary") }),
				el("div", { class: "row" },
					el("div", { class: "row-main" },
						el("div", { class: "row-name", text: T("binaryFound") }),
						el("div", { class: "row-sub", text: [cloudflared, source, cloudflaredSetup.version].filter(Boolean).join(" · "), title: cloudflared })),
					el("div", { class: "row-actions" },
						cloudflaredPath === "" ? undefined : el("button", { text: T("binaryClear"), onclick: () => void act({ action: "cloudflared", path: "" }) })))));
		} else if (remote.mode !== "tunnel") {
			// Only the tunnel channel needs a binary, so the others stay quiet about it.
		} else if (cloudflaredSetup.state === "checking" || cloudflaredSetup.state === "downloading") {
			fragment.append(el("div", { class: "note", text: cloudflaredSetup.state === "checking"
				? T("installChecking")
				: [T("installDownloading"), cloudflaredSetup.version].filter(Boolean).join(" ") }));
		} else {
			fragment.append(el("div", { class: "note", text: installErrorText() }));
			const field = el("input", { type: "text", value: cloudflaredPath ?? "", placeholder: T("binaryPlaceholder") });
			fragment.append(el("div", { class: "field" }, el("label", { text: T("binaryPath") }), field,
				el("div", { class: "actions" },
					el("button", { class: "primary", text: T("installRetry"), onclick: () => void act({ action: "cloudflared-install" }) }),
					el("button", { text: T("binarySave"), onclick: () => void act({ action: "cloudflared", path: field.value }) }))));
		}

		// The proxy only matters for reaching Cloudflare's release host, so it sits with
		// the binary, and only where it can matter.
		if (remote.mode === "tunnel") {
			const proxy = el("input", { type: "text", value: remote.cloudflaredProxy ?? "", placeholder: T("proxyPlaceholder") });
			fragment.append(el("div", { class: "field" }, el("label", { text: T("proxyLabel") }), proxy,
				el("div", { class: "note", text: T("proxyHint") }),
				el("div", { class: "actions" }, el("button", { text: T("proxySave"), onclick: () => void act({ action: "cloudflared-proxy", proxy: proxy.value }) }))));
		}

		/** The install failure reason in the reader's language; the codes are the host's. */
		function installErrorText() {
			return {
				manifest: T("installErrorManifest"),
				download: T("installErrorDownload"),
				checksum: T("installErrorChecksum"),
				signature: T("installErrorSignature"),
				unpack: T("installErrorUnpack"),
				unsupported: T("installErrorUnsupported")
			}[cloudflaredSetup.error] ?? T("cloudflaredMissing");
		}

		const link = remote.link ?? remote.lanUrls?.[0];
		if (link !== undefined) {
			fragment.append(el("div", { class: "field" }, el("label", { text: T("remoteLink") }), linkRow(link)));
			// The link is the credential a phone already holds, so a restart that kept it
			// is worth saying out loud: it is the difference between "carry on" and
			// "re-scan this".
			if (remote.resumed === true) fragment.append(el("div", { class: "note", text: T("linkKept") }));
			fragment.append(el("div", { class: "note", text: T("linkIsCredential") }));
			fragment.append(el("div", { class: "field" }, el("label", { text: T("qr") }),
				qrAvailable
					// The QR encodes the link, so it is regenerated per render.
					? el("img", { src: `${qrPath}?v=${String(Date.now())}`, alt: "remote link QR code", style: "width:200px;height:200px;background:#fff;border-radius:8px;padding:6px" })
					: el("div", { class: "note", text: `${T("qrUnavailable")} dsh plugin --profile web add dsh-remote` })));
			fragment.append(el("div", { class: "note", text: T("hint") }));
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
