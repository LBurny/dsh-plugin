/**
 * Remote access: reach the harness from a phone.
 *
 * Three parts, all inside the dsh process — no native shell involved:
 *
 *  1. An authenticating reverse proxy on its own port, forwarding to dsh's own
 *     web server. The phone authenticates against the proxy with the token
 *     embedded in the link; the proxy then authenticates *itself* to dsh by
 *     exchanging this process's launch token for the authority-bound `dsh-auth`
 *     cookie (the same exchange the desktop shell performs).
 *  2. Three transports. `lan` binds the proxy to all interfaces, so a phone on the
 *     same network connects directly and nothing leaves the machine. `tailnet` binds
 *     it to this machine's Tailscale address (`100.64.0.0/10`) only, so the link is
 *     stable across restarts and reachable from any device on the same tailnet, still
 *     without publishing anything. `tunnel` additionally spawns the bundled
 *     cloudflared quick tunnel, which makes the link work from anywhere.
 *  3. Link/QR plumbing: one random 32-byte token is the whole credential, and it
 *     is persisted so a link the phone already saved keeps working across a
 *     restart.
 *
 * Why the proxy has to exist: dsh binds a loopback address and its browser-auth
 * cookie is bound to the authority that minted it, so a remote authority (a
 * trycloudflare hostname, a LAN IP) can never present a valid cookie directly.
 * The proxy terminates the remote authority and re-issues the request to dsh
 * under the loopback authority it holds a cookie for.
 *
 * Security model, identical to the desktop shell's: the link *is* the credential
 * — a 256-bit random token, compared in constant time, exchanged on first use
 * for an HttpOnly cookie. The token is never logged, and disabling revokes it.
 *
 * @module dsh-remote/lib/remote
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCloudflared } from "./cloudflared.js";
import { respond as respondEnhanced } from "./enhance.js";
import { handleProjectRoute, PROJECT_API_PREFIX, PROJECT_PREFIX } from "./project.js";
import { canAdopt, clearSession, loadSession, saveSession } from "./session.js";
import { discoverTailnet, findTailscale, tailnetAddresses, tailnetLink } from "./tailnet.js";
import { bridgeSockets } from "./wsbridge.js";

/** The transports this proxy offers. */
export const MODES = ["lan", "tailnet", "tunnel"];

/** Coerce a mode name into one of `MODES`, defaulting to `tunnel`. */
export const normalizeMode = (mode) => (MODES.includes(mode) ? mode : "tunnel");

/** Cookie the proxy issues to a remote browser. */
const GATE_COOKIE = "__dsh_remote";
/** Cookie lifetime, matching the desktop shell's 30-day session. */
const GATE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Bodies up to this size are buffered so a stale upstream cookie can be retried. */
const BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
/** Paths that are always streamed, because they carry large uploads. */
const STREAM_PATH_HINT = "uploadFileBinary";
/** How long cloudflared may take to report a tunnel URL. */
const TUNNEL_URL_TIMEOUT_MS = 60_000;
/** Restart backoff for a crashed tunnel. */
const TUNNEL_RETRY_MIN_MS = 500;
const TUNNEL_RETRY_MAX_MS = 30_000;
/** How long a recorded tunnel gets to prove it is still alive. */
const TUNNEL_PROBE_TIMEOUT_MS = 6_000;
/** Hop-by-hop headers that must not be forwarded. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
/** Browser markers dsh's fence reads; from dsh's point of view the proxy is the origin. */
const FENCE_MARKERS = ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];
/** Vendored mobile/splash/project assets served by the response-side transforms. */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

/**
 * Load the vendored enhancement assets once. A packaging mistake (missing
 * file) degrades the proxy to plain passthrough — it must never 502.
 * @returns `{ mobileCss, mobileJs, splashCss, splashJs, projectPage } | undefined`.
 */
function createAssetLoader(log) {
	let cache;
	return () => {
		cache ??= (async () => {
			try {
				const [mobileCss, mobileJs, splashCss, splashJs, projectPage] = await Promise.all([
					readFile(join(ASSETS_DIR, "mobile.css"), "utf8"),
					readFile(join(ASSETS_DIR, "mobile.js"), "utf8"),
					readFile(join(ASSETS_DIR, "splash.css"), "utf8"),
					readFile(join(ASSETS_DIR, "splash.js"), "utf8"),
					readFile(join(ASSETS_DIR, "project.html"), "utf8")
				]);
				return { mobileCss, mobileJs, splashCss, splashJs, projectPage };
			} catch (cause) {
				log(`remote assets unavailable, running without enhancements: ${String(cause?.message ?? cause)}`);
				return undefined;
			}
		})();
		return cache;
	};
}

/** A fresh 256-bit link credential, lowercase hex. */
export function generateToken() {
	return randomBytes(32).toString("hex");
}

/** Constant-time token comparison. */
function tokenEquals(actual, expected) {
	if (typeof actual !== "string" || typeof expected !== "string" || actual.length !== expected.length || actual.length === 0) return false;
	return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Interface names that are almost never the address a phone should use:
 * hypervisor switches, container/WSL bridges, VPN overlays, Bluetooth PAN and
 * capture drivers. They all report plausible-looking IPv4 addresses, so a raw
 * address list puts a Docker bridge first and the real Wi-Fi address last.
 */
const VIRTUAL_INTERFACE = /vEthernet|Hyper-V|VMware|VirtualBox|WSL|Docker|Loopback|Tailscale|ZeroTier|Wintun|WireGuard|Bluetooth|Npcap|TAP-Windows/iu;

/** Rank a candidate address: home/office LANs first, container bridges last. */
function lanRank(address) {
	const octets = address.split(".").map(Number);
	if (octets[0] === 192 && octets[1] === 168) return 0;
	if (octets[0] === 10) return 1;
	if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return 3;
	return 2;
}

/**
 * IPv4 addresses a phone on the same network could reach, best candidate first.
 * Link-local (169.254.x) addresses are dropped: they are APIPA placeholders that
 * nothing routes to.
 * @returns ordered addresses.
 */
export function lanAddresses() {
	const physical = [];
	const virtual = [];
	for (const [name, list] of Object.entries(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.family !== "IPv4" || iface.internal || iface.address.startsWith("169.254.")) continue;
			(VIRTUAL_INTERFACE.test(name) ? virtual : physical).push(iface.address);
		}
	}
	const byRank = (a, b) => lanRank(a) - lanRank(b);
	physical.sort(byRank);
	virtual.sort(byRank);
	return [...physical, ...virtual];
}

/**
 * Pull the quick-tunnel URL out of a cloudflared log chunk. cloudflared prints it
 * inside a boxed banner, so the match is anchored on the hostname shape rather
 * than on line structure.
 * @param text - a chunk of cloudflared's stdout or stderr.
 * @returns the tunnel URL, or undefined when this chunk does not carry one.
 */
export function parseTunnelUrl(text) {
	return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u.exec(String(text))?.[0];
}

/**
 * Supervise a cloudflared quick tunnel: spawn it, read the URL off its log, and
 * restart with backoff while the intent to run is still set.
 *
 * Two properties matter more than the supervision itself:
 *
 * - **The tunnel outlives dsh.** It is spawned detached, with its output going to a
 *   log file rather than to our pipes (a pipe would break the moment we exit, and
 *   cloudflared dying on a write error is exactly the link churn this avoids), so the
 *   hostname — the link — survives a restart.
 * - **A survivor can be adopted.** `adopt()` attaches this handle to a tunnel recorded
 *   in the session file without spawning anything, which is what keeps the link
 *   byte-identical across restarts. Adoption is deliberately unable to stop the
 *   process it did not spawn unless the reader disables remote access.
 *
 * @param options - binary path, local target, log sink, log file path and a logger.
 * @returns start/adopt/stop handle plus a status snapshot.
 */
function createTunnel({ exe, target, logPath, onSession, log }) {
	let child;
	let url = "";
	let adoptedPid;
	let state = "off";
	let error;
	let failures = 0;
	let retryTimer;
	let poll;
	let deadline;
	let stopping = true;
	const listeners = new Set();

	const status = () => ({ state, url, error });
	const notify = () => {
		for (const listener of listeners) listener(status());
	};

	/**
	 * Drop both attempt timers. Every path that ends an attempt goes through here, which
	 * is what keeps `stop()` honest: it can end a run whose child keeps running (the
	 * deliberate "leave the tunnel alive" case), and no `exit` event will arrive then to
	 * clean up after it. An orphaned poll would otherwise read the log file twice a second
	 * and report a URL into a handle that has already stopped.
	 */
	const clearTimers = () => {
		clearTimeout(deadline);
		clearInterval(poll);
		deadline = undefined;
		poll = undefined;
	};

	/** Record the live tunnel so the next start can adopt it. */
	const remember = (pid) => {
		if (url === "" || !Number.isInteger(pid) || pid <= 0) return;
		try {
			// onSession returns the write's promise; a failed write (read-only home, full
			// disk) must be a log line here, never an unhandled rejection in the harness.
			void Promise.resolve(onSession({ tunnelUrl: url, tunnelPid: pid, cloudflaredExe: exe, target })).catch((cause) => {
				log(`could not record the tunnel session: ${String(cause?.message ?? cause)}`);
			});
		} catch (cause) {
			log(`could not record the tunnel session: ${String(cause?.message ?? cause)}`);
		}
	};

	const scheduleRetry = () => {
		if (stopping) return;
		failures += 1;
		const delay = Math.min(TUNNEL_RETRY_MAX_MS, TUNNEL_RETRY_MIN_MS * 2 ** (failures - 1));
		log(`tunnel restarting in ${String(delay)}ms (failure ${String(failures)})`);
		retryTimer = setTimeout(start, delay);
		retryTimer.unref?.();
	};

	function start() {
		if (stopping || child !== undefined) return;
		state = "starting";
		error = undefined;
		notify();
		clearTimers();
		// http2 is pinned on purpose: the desktop shell found QUIC/UDP gets killed by
		// some carriers, which shows up as a tunnel that dies mid-session.
		let sink;
		try {
			// Truncated, not appended: the URL is read back from this file, and a previous
			// session's banner would still be in an appended tail — the poll would then
			// report the hostname of a tunnel that no longer exists.
			sink = openSync(logPath, "w");
		} catch {
			sink = "ignore";
		}
		let spawnFailure;
		try {
			child = spawn(exe, ["tunnel", "--url", target, "--no-autoupdate", "--protocol", "http2"], {
				windowsHide: true,
				// Detached is the whole point: this is the process that keeps the hostname
				// alive while dsh is not running.
				detached: true,
				stdio: ["ignore", sink, sink]
			});
		} catch (cause) {
			// A synchronous throw is the same failure as an `error` event below, and this
			// runs inside a retry timer as well, where a throw is an uncaught exception.
			spawnFailure = cause;
		} finally {
			// The child has its own copy of the descriptor. Without closing ours, every
			// start and every retry leaks one for as long as the harness runs.
			if (typeof sink === "number") closeSync(sink);
		}
		if (spawnFailure !== undefined) {
			state = "error";
			error = `cloudflared could not start: ${String(spawnFailure?.message ?? spawnFailure)}`;
			log(error);
			notify();
			scheduleRetry();
			return;
		}
		child.unref();
		// Every handler below belongs to this one attempt: a stale child's `error`/`exit`
		// (SIGTERM can land long after `stopChild` killed it) must not clear the *current*
		// attempt's poll and deadline or double-schedule a retry.
		const attempt = child;
		deadline = setTimeout(() => {
			if (child !== attempt) return;
			if (state === "starting") {
				error = "cloudflared did not report a tunnel url";
				log(error);
				stopChild();
				scheduleRetry();
			}
		}, TUNNEL_URL_TIMEOUT_MS);
		deadline.unref?.();
		// The URL is read back from the log file rather than from a pipe, because a
		// detached tunnel keeps writing after we are gone.
		poll = setInterval(() => {
			if (url !== "") {
				clearInterval(poll);
				return;
			}
			let text = "";
			try {
				text = readFileSync(logPath, "utf8").slice(-8192);
			} catch {
				return;
			}
			const found = parseTunnelUrl(text);
			if (found === undefined) return;
			clearInterval(poll);
			url = found;
			state = "up";
			error = undefined;
			failures = 0;
			clearTimeout(deadline);
			remember(child?.pid ?? adoptedPid);
			log("tunnel up");
			notify();
		}, 500);
		poll.unref?.();
		// A spawn that fails emits `error` and never `exit`, and an `error` with no listener
		// is an uncaught exception inside the harness process. The search rules out a missing
		// file, not one that exists and cannot be executed.
		child.on("error", (cause) => {
			if (child !== attempt) return;
			clearTimers();
			child = undefined;
			if (stopping) return;
			state = "error";
			error = `cloudflared could not start: ${String(cause?.message ?? cause)}`;
			log(error);
			notify();
			scheduleRetry();
		});
		child.on("exit", (code) => {
			if (child !== attempt) return;
			clearTimers();
			child = undefined;
			if (stopping) return;
			state = "error";
			error = `cloudflared exited (${String(code)})`;
			notify();
			scheduleRetry();
		});
	}

	/** Kill the current child without touching the run intent. */
	function stopChild() {
		if (child === undefined) return;
		const victim = child;
		child = undefined;
		try {
			victim.kill();
		} catch {
			/* already gone */
		}
	}

	/**
	 * Stop supervising.
	 * @param options - `revoke: true` (the reader turned remote access off) also kills
	 *   the tunnel, which is what makes a new link on the next enable. The default
	 *   leaves it running so the link survives this process.
	 */
	function stop({ revoke = false } = {}) {
		stopping = true;
		clearTimeout(retryTimer);
		// Both attempt timers, not just the retry: the non-revoke path deliberately leaves
		// the child running, so no `exit` event will come and clean up after it.
		clearTimers();
		if (revoke) {
			stopChild();
			killStale(adoptedPid);
		} else {
			// Leaving the child alive means dropping our handle to it, not killing it.
			child = undefined;
		}
		adoptedPid = undefined;
		state = "off";
		url = "";
		error = undefined;
		notify();
	}

	return {
		start() {
			stopping = false;
			failures = 0;
			start();
		},
		/**
		 * Take over a tunnel recorded in the session file: no spawn, same hostname, so
		 * the link a phone already has keeps working.
		 * @param saved - `{ tunnelUrl, tunnelPid }` from the session record.
		 */
		adopt(saved) {
			stopping = false;
			adoptedPid = saved.tunnelPid;
			url = saved.tunnelUrl;
			state = "up";
			error = undefined;
			log("tunnel adopted, link unchanged");
			notify();
		},
		stop,
		status,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}

/**
 * Kill a process this run does not own, best effort. Used on a recorded tunnel that
 * turned out to be unusable, so a long-lived machine does not collect cloudflared
 * processes that nobody will ever adopt, and on an adopted tunnel the reader turns off.
 * @param pid - the recorded pid.
 */
function killStale(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			// An `error` with no listener on a ChildProcess is an uncaught exception, and a
			// pid that is already gone is the expected case here.
			killer.on("error", () => {});
			killer.unref();
		} else {
			process.kill(pid);
		}
	} catch {
		/* already gone */
	}
}

/**
 * Whether a recorded tunnel still answers for this token. A quick tunnel whose
 * process is gone, or whose target is a proxy port that no longer exists, answers
 * with an error page — so this one probe covers both, and beats trusting a pid
 * (which can be recycled by an unrelated process).
 * @param url - the recorded tunnel base URL.
 * @param token - the current link token.
 * @param timeoutMs - how long to wait for an answer.
 * @returns true when the tunnel is alive and pointing at this proxy.
 */
async function tunnelAnswers(url, token, timeoutMs = TUNNEL_PROBE_TIMEOUT_MS) {
	try {
		const response = await fetch(`${url}/?token=${encodeURIComponent(token)}`, {
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs)
		});
		return response.status === 200 || response.status === 303;
	} catch {
		return false;
	}
}

/**
 * The remote-access manager: owns the proxy, the tunnel and the token.
 * @param options - context, path layout, settings accessor/saver, a logger, and the
 *   binary probe. That probe is injectable because it reads the real environment: on a
 *   machine that already has cloudflared the real one would be spawned by a test.
 */
export function createRemoteManager({ ctx, layout, config, save, log, findBinary = findCloudflared }) {
	let server;
	let tunnel;
	/** An in-flight tunnel start; a concurrent caller joins it instead of spawning twice. */
	let tunnelOpening;
	/** Set by `suspend`: after unload nothing may spawn a tunnel again. */
	let disposed = false;
	/** Last tailnet resolution, refreshed when the channel is enabled. */
	let tailnet;
	let authCookie;
	let state = "off";
	let error;
	let link;
	let resumed = false;
	const listeners = new Set();
	const loadAssets = createAssetLoader(log);

	/**
	 * Settings snapshot. The gate runs on every request and on every WebSocket
	 * upgrade, so reads must be synchronous; the manager refreshes this cache
	 * whenever it loads or writes settings instead.
	 */
	let cachedSettings;
	const settings = () => cachedSettings ?? { enabled: false, mode: "tunnel", port: 0, token: "", cloudflaredPath: "", cloudflaredProxy: "" };
	/** Reload the snapshot from this plugin's settings store. */
	async function refreshSettings() {
		cachedSettings = await config();
		return cachedSettings;
	}
	/** Persist a patch and refresh the snapshot. */
	async function persist(patch) {
		await save(patch);
		return refreshSettings();
	}

	/**
	 * Lifecycle steps run one at a time through this chain. `enable` awaits several
	 * things (settings, tailnet discovery, the cookie exchange, `listen`) before it ever
	 * assigns `server`, so two overlapping calls — the load-time resume against a panel's
	 * enable — both see it unset, both bind a listener, and the second assignment orphans
	 * the first: a listener that still authenticates and can never be closed. `disable`
	 * has the mirror problem, reporting success while an enable is parked on an await and
	 * still coming up. Serializing removes both interleavings.
	 * @param operation - the lifecycle step to run.
	 * @returns whatever the step returns.
	 */
	let lifecycle = Promise.resolve();
	function serialized(operation) {
		// Run on both settle paths: a failed step must not wedge the queue.
		const run = lifecycle.then(operation, operation);
		lifecycle = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Proxy port, or undefined while stopped. */
	const proxyPort = () => server?.address()?.port;

	/**
	 * LAN links for the current proxy port. Only `lan` binds every interface, so only
	 * `lan` has any: `tailnet` binds one address (its own link carries the name) and
	 * `tunnel` binds loopback, where a LAN address answers nothing. Advertising
	 * addresses the proxy is not listening on is worse than showing none.
	 */
	function lanUrls() {
		const port = proxyPort();
		const token = settings().token;
		if (settings().mode !== "lan" || port === undefined || typeof token !== "string" || token.length === 0) return [];
		return lanAddresses().map((address) => `http://${address}:${String(port)}/?token=${token}`);
	}

	/**
	 * What the tailnet channel can see right now, for the panel to explain itself
	 * before the reader turns it on. The interface scan is synchronous, so this stays
	 * safe on every request; the CLI is only consulted while enabling, because it
	 * spawns a process. `last` carries whatever that run found.
	 */
	const tailnetStatus = () => {
		// One interface scan, not two: this runs on every `/api/remote` read and on every
		// publish, and `networkInterfaces()` is a synchronous syscall.
		const addresses = tailnetAddresses();
		return {
			addresses,
			address: tailnet?.address ?? addresses[0],
			dnsName: tailnet?.dnsName,
			backendState: tailnet?.backendState,
			source: tailnet?.source,
			cli: findTailscale() ?? null
		};
	};

	const snapshot = () => ({
		state,
		enabled: server !== undefined,
		mode: settings().mode,
		link,
		proxyPort: proxyPort(),
		lanUrls: lanUrls(),
		tailnet: tailnetStatus(),
		tunnel: tunnel?.status(),
		// True when this session adopted the tunnel the last one left behind, which is
		// what the panel reports as "the link did not change".
		resumed,
		// null rather than undefined so the field always survives JSON and the panel
		// can tell "not found" from "not reported". The configured path rides along so
		// the panel can show what is set, or let the reader set it.
		cloudflared: findBinary(settings().cloudflaredPath, layout().dshHome) ?? null,
		cloudflaredPath: settings().cloudflaredPath,
		cloudflaredProxy: settings().cloudflaredProxy,
		error
	});

	const publish = () => {
		for (const listener of listeners) listener(snapshot());
	};

	/** This dsh web server's loopback port and authority. */
	function upstream() {
		const port = ctx.get("webServer")?.port;
		if (port === undefined) throw new Error("webServer service is not available");
		return { port, authority: `127.0.0.1:${String(port)}` };
	}

	/**
	 * Exchange this process's launch token for the authority-bound cookie.
	 * `authenticatedUrl` is the documented way to read the token back out; the
	 * `browserAuth.launchToken` field is the fallback.
	 */
	async function refreshAuthCookie() {
		const { port, authority } = upstream();
		const connection = ctx.get("connection");
		if (connection === undefined) throw new Error("connection service is not available");
		let token;
		try {
			token = new URL(connection.authenticatedUrl(`http://${authority}`)).searchParams.get("token");
		} catch {
			token = undefined;
		}
		token ??= connection.browserAuth?.launchToken;
		if (typeof token !== "string" || token.length === 0) throw new Error("no launch token is available for this harness process");
		const response = await fetch(`http://127.0.0.1:${String(port)}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
		const cookie = (response.headers.getSetCookie?.() ?? [])[0];
		if (typeof cookie !== "string" || cookie.length === 0) throw new Error(`launch-token exchange failed (status ${String(response.status)})`);
		authCookie = cookie.split(";", 1)[0];
		return authCookie;
	}

	/**
	 * Headers for an upstream request: loopback authority, our cookie, and no
	 * browser markers. Compression is dropped so responses stay identity-encoded
	 * and the proxy never has to reason about content encoding.
	 * @param req - the remote request.
	 * @param options - `upgrade` keeps `connection`/`upgrade`, which are hop-by-hop
	 *   for an ordinary request but are exactly what makes an upgrade an upgrade.
	 */
	function upstreamHeaders(req, options = {}) {
		const headers = {};
		for (const [key, value] of Object.entries(req.headers)) {
			const lower = key.toLowerCase();
			if (lower === "accept-encoding" || lower === "cookie" || lower === "host") continue;
			if (FENCE_MARKERS.includes(lower)) continue;
			if (HOP_BY_HOP.has(lower) && !(options.upgrade === true && (lower === "connection" || lower === "upgrade"))) continue;
			headers[key] = value;
		}
		headers.host = upstream().authority;
		headers.cookie = authCookie;
		return headers;
	}

	/** Read one cookie value out of a Cookie header. */
	function gateCookie(header) {
		if (typeof header !== "string") return undefined;
		for (const part of header.split(";")) {
			const at = part.indexOf("=");
			if (at !== -1 && part.slice(0, at).trim() === GATE_COOKIE) return part.slice(at + 1).trim();
		}
		return undefined;
	}

	/** Whether a remote request carries the link token or the gate cookie. */
	function admitted(req) {
		const expected = settings().token;
		const url = new URL(req.url ?? "/", "http://remote.invalid");
		const presented = url.searchParams.get("token");
		if (presented !== null) return { ok: tokenEquals(presented, expected), presented: true, url };
		return { ok: tokenEquals(gateCookie(req.headers.cookie), expected), presented: false, url };
	}

	/** Refuse a request that presented no usable credential. */
	async function refuse(res, slow) {
		// A wrong token waits, so the gate cannot be probed for free.
		if (slow) await new Promise((resolve) => setTimeout(resolve, 500));
		res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end("<!doctype html><meta charset=utf-8><title>dsh remote</title><p><b>403</b>. Open the full link, including its <code>?token=</code>, as shown in the dsh-remote panel.</p>");
	}

	/**
	 * Forward one HTTP request. The response side runs through the enhancement
	 * pipeline (HTML rewrite / gzip / SSE keepalive), which owns `res`.
	 * @param req - the remote request.
	 * @param res - the remote response.
	 */
	function forward(req, res) {
		const { port } = upstream();
		const streaming = Number(req.headers["content-length"] ?? "0") > BUFFER_LIMIT_BYTES || String(req.url ?? "").includes(STREAM_PATH_HINT);
		const headers = upstreamHeaders(req);

		/** Hand the upstream response to the enhancement pipeline. */
		const answer = (upstreamRes) => {
			loadAssets()
				.then((assets) => respondEnhanced({ req, res, upstreamRes, assets, log }))
				.catch((cause) => fail(res, cause));
		};

		/**
		 * Pipe the request body straight through, with no cookie retry: a body this large
		 * cannot be held twice, so a stale cookie costs this one request instead of the upload.
		 * @param lead - bytes already read off the request, written ahead of the rest.
		 * @param dropLength - drop `content-length` (the body outgrew what it declared, so the
		 *   only honest framing left is chunked: Node refuses a request that writes past the
		 *   length it announced).
		 */
		const streamUp = (lead, dropLength) => {
			const requestHeaders = { ...headers };
			if (dropLength) {
				for (const key of Object.keys(requestHeaders)) {
					if (key.toLowerCase() === "content-length") delete requestHeaders[key];
				}
			}
			const upstreamReq = httpRequest({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: requestHeaders }, answer);
			upstreamReq.on("error", (cause) => fail(res, cause));
			if (lead !== undefined && lead.length > 0) upstreamReq.write(lead);
			req.pipe(upstreamReq);
		};

		if (streaming) {
			streamUp(undefined, false);
			return;
		}

		const chunks = [];
		let size = 0;
		/** Set once the body outgrew the buffer and went upstream as a stream instead. */
		let piped = false;
		/**
		 * Send an already-buffered body upstream. This is its own function, not another
		 * call to `forward`, because the retry below runs after the request stream has
		 * ended: re-attaching `data`/`end` to an ended readable never fires again, so a
		 * recursive call would send nothing and answer nothing, hanging the request.
		 * @param body - the bytes to send.
		 * @param retried - true once the session cookie has been re-exchanged, so a
		 *   second 401 is passed through instead of looping.
		 */
		const send = (body, retried) => {
			const requestHeaders = { ...headers, "content-length": String(body.length) };
			const upstreamReq = httpRequest({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: requestHeaders }, (upstreamRes) => {
				if (upstreamRes.statusCode === 401 && !retried) {
					upstreamRes.resume();
					log("upstream rejected the session cookie; re-exchanging and replaying once");
					refreshAuthCookie()
						.then(() => send(body, true))
						.catch((cause) => fail(res, new Error(`re-authentication failed: ${String(cause?.message ?? cause)}`)));
					return;
				}
				answer(upstreamRes);
			});
			upstreamReq.on("error", (cause) => fail(res, cause));
			if (body.length > 0) upstreamReq.write(body);
			upstreamReq.end();
		};

		req.on("data", (chunk) => {
			if (piped === true) return;
			chunks.push(chunk);
			size += chunk.length;
			if (size <= BUFFER_LIMIT_BYTES) return;
			// The buffer is full and the body keeps arriving: the declared length was absent
			// (chunked) or lied. Destroying the request here, as this used to do, loses the
			// upload with nothing but a reset at the phone; forward what has arrived and stream
			// the rest instead, which is what a declared length over the limit already does.
			piped = true;
			const lead = Buffer.concat(chunks);
			chunks.length = 0;
			streamUp(lead, true);
		});
		req.on("error", (cause) => fail(res, cause));
		req.on("end", () => {
			// A streamed body has already been answered by `streamUp`; only a buffered one is
			// sent here (and only here can the stale-cookie retry apply).
			if (piped !== true) send(Buffer.concat(chunks), false);
		});
	}

	/** Report an upstream failure on a response that has not been written yet. */
	function fail(res, cause) {
		const message = `dsh remote: upstream error: ${String(cause?.message ?? cause)}`;
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(message);
		else res.end();
	}

	/**
	 * Forward a WebSocket upgrade. The request line and headers are re-emitted
	 * against the loopback authority with our cookie; once connected, the two
	 * sockets are bridged at frame level so the proxy can inject an idle Ping
	 * without ever splitting a frame.
	 */
	function forwardUpgrade(req, socket, head) {
		const { port } = upstream();
		const headers = upstreamHeaders(req, { upgrade: true });
		const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
		for (const [key, value] of Object.entries(headers)) {
			if (value === undefined) continue;
			lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
		}
		const upstreamSocket = netConnect(port, "127.0.0.1", () => {
			upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (head !== undefined && head.length > 0) upstreamSocket.write(head);
			bridgeSockets(socket, upstreamSocket, { log });
		});
		const close = () => {
			socket.destroy();
			upstreamSocket.destroy();
		};
		socket.on("error", close);
		upstreamSocket.on("error", close);
		socket.on("close", close);
		upstreamSocket.on("close", close);
	}

	/** Route one proxied request. */
	async function handle(req, res) {
		const verdict = admitted(req);
		if (!verdict.ok) {
			await refuse(res, verdict.presented);
			return;
		}
		if (verdict.presented) {
			// Strip the token from the address bar and remember it in a cookie, so the
			// phone's later requests and its WebSocket upgrades are authenticated.
			const rest = new URLSearchParams(verdict.url.search);
			rest.delete("token");
			const query = rest.toString();
			res.writeHead(303, {
				location: query === "" ? verdict.url.pathname : `${verdict.url.pathname}?${query}`,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"set-cookie": `${GATE_COOKIE}=${settings().token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(GATE_MAX_AGE_SECONDS)}`
			});
			res.end();
			return;
		}
		// The kit's own read-only routes (phone project browser) sit behind the
		// same gate; they answer locally instead of being forwarded to dsh.
		const path = verdict.url.pathname;
		if ((req.method ?? "GET") === "GET" && (path === PROJECT_PREFIX || path.startsWith(`${PROJECT_API_PREFIX}/`))) {
			const assets = await loadAssets();
			if (assets?.projectPage !== undefined) {
				await handleProjectRoute(req, res, verdict.url, { workspaceStorePath: layout().workspaceStorePath, page: assets.projectPage });
				return;
			}
		}
		forward(req, res);
	}

	/**
	 * Bring up the tunnel for an enabled tunnel-mode proxy.
	 *
	 * Separate from `enable` because the binary can arrive *after* the reader turned the
	 * channel on: the installer runs in the background, so the first enable on a machine
	 * without cloudflared reports the binary missing seconds before the download lands.
	 * Being able to call this again then is what makes the channel work the moment the
	 * file exists, instead of leaving the reader to toggle the mode before they notice.
	 *
	 * Idempotent on purpose: a proxy that is not running, a mode that is not `tunnel`, and a
	 * tunnel that already exists all return the current snapshot untouched. Two callers can
	 * still pass that guard together (the load-time provisioning overlaps a fresh enable, and
	 * the adoption probe below awaits), so the attempt itself is shared: the second caller
	 * joins it rather than spawning a second cloudflared that would orphan the first.
	 * @returns the snapshot after the attempt.
	 */
	async function startTunnelNow() {
		if (server === undefined || disposed || settings().mode !== "tunnel" || tunnel !== undefined) return snapshot();
		tunnelOpening ??= openTunnel().finally(() => {
			tunnelOpening = undefined;
		});
		await tunnelOpening;
		return snapshot();
	}

	/** One tunnel attempt: adopt the recorded one when it still answers, else spawn. */
	async function openTunnel() {
		const exe = findBinary(settings().cloudflaredPath, layout().dshHome);
		if (exe === undefined) {
			state = "error";
			// The panel explains where it looked and takes a path; this string is the
			// short form for the status row, and carries no em dash.
			error = "cloudflared binary not found";
			log(error);
			publish();
			return;
		}
		const target = `http://127.0.0.1:${String(proxyPort())}`;
		const paths = layout();
		// The link is a credential the reader has already handed to a phone, so a restart
		// should not silently invalidate it: adopt the tunnel the previous session left
		// running whenever it is still ours and still answers.
		const saved = loadSession(paths.sessionPath);
		const adopt = canAdopt(saved, { exe, target }) && (await tunnelAnswers(saved.tunnelUrl, settings().token));
		// The liveness probe above awaits, so a disable or an unload may have run in the
		// meantime. Spawning now would leave a detached cloudflared answering a proxy that
		// is gone, which nothing supervises and nothing can reach.
		if (disposed || server === undefined || settings().mode !== "tunnel") return;
		tunnel = createTunnel({
			exe,
			target,
			logPath: paths.tunnelLogPath,
			onSession: (state_) => saveSession(paths.sessionPath, state_),
			log
		});
		// Subscribe before starting or adopting: both notify synchronously, and a listener
		// attached afterwards never hears about the transition that carries the URL. That is
		// why the panel used to show no link (and no QR) until it was remounted, and why an
		// adopted tunnel could go a whole session without one.
		tunnel.onChange((tunnelStatus) => {
			state = tunnelStatus.state === "up" ? "up" : tunnelStatus.state === "off" ? "off" : "starting";
			error = tunnelStatus.error;
			if (tunnelStatus.url !== "") link = `${tunnelStatus.url}/?token=${settings().token}`;
			publish();
		});
		if (adopt) {
			tunnel.adopt(saved);
			resumed = true;
		} else {
			// A recorded tunnel that cannot be adopted is dead weight: kill it so a
			// long-lived machine does not accumulate cloudflared processes.
			if (saved !== undefined) killStale(saved.tunnelPid);
			clearSession(paths.sessionPath);
			resumed = false;
			tunnel.start();
		}
	}

	/** Start the proxy, and in tunnel mode bring up cloudflared. */
	async function enableNow(mode) {
		const wanted = normalizeMode(mode);
		if (server !== undefined) {
			// Already running: an enable that asks for the other transport means switch,
			// not "keep what is there".
			if (settings().mode === wanted) return snapshot();
			return setModeNow(wanted);
		}
		const current = await refreshSettings();
		// The tailnet channel binds one specific address, so the address has to exist
		// before the listener does. It must not fall back to every interface: the reader
		// chose a private channel, and silently serving the whole LAN instead is a
		// different decision than the one they made.
		tailnet = wanted === "tailnet" ? await discoverTailnet() : undefined;
		const token = typeof current.token === "string" && current.token.length > 0 ? current.token : generateToken();
		await persist({ token, enabled: true, mode: wanted });
		if (wanted === "tailnet" && tailnet.address === undefined) {
			state = "error";
			// The panel turns this into an instruction (install Tailscale here and sign
			// in); the string is the short form for the status row, and carries no em dash.
			error = "no Tailscale address found (is Tailscale installed and signed in?)";
			log(error);
			// The settings must not claim an enable that never happened, or the next boot
			// resumes a mode that cannot work and logs a failure on every restart.
			await persist({ enabled: false });
			publish();
			return snapshot();
		}
		// Must happen before the proxy accepts a request, or the first proxied
		// request would go upstream without a session cookie.
		await refreshAuthCookie();

		if (disposed) return snapshot();

		const listening = createServer((req, res) => {
			handle(req, res).catch((cause) => fail(res, cause));
		});
		listening.on("upgrade", (req, socket, head) => {
			if (!admitted(req).ok) {
				socket.destroy();
				return;
			}
			forwardUpgrade(req, socket, head);
		});
		const bind = wanted === "lan" ? "0.0.0.0" : wanted === "tailnet" ? tailnet.address : "127.0.0.1";
		/**
		 * Bind, reusing the remembered port so a shared link keeps working after a
		 * restart. A port taken by something else falls back to an ephemeral one
		 * rather than refusing to start.
		 */
		const listen = (port) =>
			new Promise((resolve, reject) => {
				const onError = (error) => {
					if (port !== 0 && error.code === "EADDRINUSE") {
						listening.removeListener("error", onError);
						log(`remote port ${String(port)} is taken; falling back to an ephemeral port`);
						listen(0).then(resolve, reject);
						return;
					}
					reject(error);
				};
				listening.once("error", onError);
				listening.listen(port, bind, () => {
					listening.removeListener("error", onError);
					resolve();
				});
			});
		await listen(current.port ?? 0);
		if (disposed) {
			// Unloaded while this was binding: a listener that outlives the plugin has no
			// route left that could ever close it, so drop it instead of publishing it.
			listening.close();
			listening.closeAllConnections?.();
			return snapshot();
		}
		server = listening;
		const port = listening.address().port;
		state = "up";
		error = undefined;
		// The tailnet link prefers the MagicDNS name, so it survives the address being
		// reassigned; the `lan` link is whatever interface the phone should use.
		link =
			wanted === "lan"
				? (lanUrls()[0] ?? undefined)
				: wanted === "tailnet"
					? tailnetLink({ host: tailnet.dnsName ?? tailnet.address, port, token: settings().token })
					: undefined;
		if (port !== current.port) await persist({ port });
		log(`remote proxy listening on ${bind}:${String(port)}${wanted === "tailnet" && tailnet.dnsName !== undefined ? ` (${tailnet.dnsName})` : ""}`);
		publish();

		if (wanted === "tunnel") await startTunnelNow();
		return snapshot();
	}

	/** Stop everything and revoke the credential, tunnel included. */
	async function disableNow() {
		tunnel?.stop({ revoke: true });
		tunnel = undefined;
		resumed = false;
		clearSession(layout().sessionPath);
		if (server !== undefined) {
			const victim = server;
			server = undefined;
			// `close()` stops accepting but its callback only runs once every open
			// connection has ended, and the phone holds SSE streams and bridged
			// WebSockets open indefinitely. Without dropping them this promise never
			// settles and Disable looks frozen; revoking access is the point of the call,
			// so the sockets go with it.
			await new Promise((resolve) => {
				victim.close(() => resolve());
				victim.closeAllConnections?.();
			});
		}
		authCookie = undefined;
		state = "off";
		error = undefined;
		link = undefined;
		await persist({ enabled: false });
		log("remote access disabled");
		publish();
		return snapshot();
	}

	/**
	 * dsh is going away, remote access is not. Leave the tunnel running so its
	 * hostname — and therefore the phone's link — survives, and keep the session file
	 * so the next start can adopt it. Only the proxy dies, with the process.
	 */
	function suspend() {
		// From here on this manager is done: an install that lands after unload must not
		// start a tunnel on a plugin dsh has already unloaded.
		disposed = true;
		// The proxy listener belongs to this manager, not to the tunnel. On a real process
		// exit it dies with the process, but on an unload that is not an exit it would keep
		// answering and still accept the persisted token, and no route would be left that
		// could ever close it.
		if (server !== undefined) {
			const victim = server;
			server = undefined;
			victim.close();
			victim.closeAllConnections?.();
		}
		if (tunnel === undefined) return;
		tunnel.stop();
		tunnel = undefined;
		log("remote suspended: tunnel left alive, link unchanged");
	}

	/** Switch transport, keeping the token so a saved link keeps working. */
	async function setModeNow(mode) {
		const next = normalizeMode(mode);
		const wasEnabled = server !== undefined;
		if (wasEnabled) await disableNow();
		await persist({ mode: next });
		if (wasEnabled) return enableNow(next);
		state = "off";
		publish();
		return snapshot();
	}

	/** Issue a fresh credential; every link shared before this stops working. */
	async function resetTokenNow() {
		const wasEnabled = server !== undefined;
		const mode = settings().mode;
		if (wasEnabled) await disableNow();
		await persist({ token: generateToken(), enabled: false });
		log("remote token reset");
		if (wasEnabled) return enableNow(mode);
		publish();
		return snapshot();
	}

	return {
		snapshot,
		/** Reload the synchronous settings snapshot from the settings store. */
		sync: refreshSettings,
		onStatus(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		// Every entry point that starts or stops the proxy goes through the one-at-a-time
		// queue. The internal `…Now` steps call each other directly, so a switch does not
		// deadlock against the queue it is already running in.
		enable: (mode) => serialized(() => enableNow(mode)),
		disable: () => serialized(() => disableNow()),
		suspend,
		setMode: (mode) => serialized(() => setModeNow(mode)),
		startTunnel: () => serialized(() => startTunnelNow()),
		resetToken: () => serialized(() => resetTokenNow()),
		refresh: refreshAuthCookie,
		/**
		 * Point the tunnel at a specific binary. A path that does not exist is refused
		 * (the caller reports it) instead of being saved and silently ignored later.
		 * @param path - absolute path, or an empty string to go back to auto-discovery.
		 */
		async setCloudflaredPath(path) {
			const next = typeof path === "string" ? path.trim() : "";
			if (next !== "" && !existsSync(next)) throw new Error(`no file at ${next}`);
			await persist({ cloudflaredPath: next });
			log(next === "" ? "cloudflared path cleared" : `cloudflared path set to ${next}`);
			return snapshot();
		},
		cloudflared: () => findBinary(settings().cloudflaredPath, layout().dshHome),
		/** The Tailscale CLI, when it is installed. Optional: the channel does not need it. */
		tailscale: () => findTailscale()
	};
}
