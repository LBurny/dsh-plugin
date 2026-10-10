/**
 * The tailnet channel: reach this harness over a private Tailscale network.
 *
 * Tailscale gives every device a stable address in the carrier-grade NAT range
 * `100.64.0.0/10` and routes it over WireGuard, so this channel is mostly a bind:
 * the proxy listens on the tailnet interface only and nothing is published to the
 * internet. That is the whole difference from `lan` (every interface) and from
 * `tunnel` (a public Cloudflare hostname that changes on every restart). It is the
 * stable, private option, and it needs no account of ours and no open port.
 *
 * Deliberately *not* `tailscale serve`, which is what most community plugins use.
 * Serve puts dsh's own authority (`<machine>.<tailnet>.ts.net`) in front of the
 * harness, and dsh's browser fence rejects an authority it does not trust, so those
 * plugins have to also register a trusted host and enable HTTPS certificates on the
 * tailnet. This proxy already terminates the remote authority and re-issues every
 * request to dsh under the loopback authority, so the tailnet name never reaches the
 * fence and none of that plumbing is needed here.
 *
 * Nothing here requires the Tailscale CLI. The address is read off the network
 * interfaces, which is enough to bind and to hand out a working link; the CLI is
 * consulted only when it is there, for the stable MagicDNS name and for an honest
 * "installed but not running" report.
 *
 * @module dsh-remote/lib/tailnet
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Tailscale's IPv4 range, 100.64.0.0/10, written as a precise octet test. */
const TAILNET_V4 = /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3})\.(?:[0-9]{1,3})$/u;

/** How long `tailscale status --json` may take before it is treated as absent. */
const TAILNET_STATUS_TIMEOUT_MS = 5_000;

/**
 * Whether an address is in Tailscale's 100.64.0.0/10 range. A plain prefix test
 * would also accept 100.63.x and 100.128.x, which are not the tailnet.
 * @param address - candidate IPv4 address.
 * @returns true for 100.64.0.0 through 100.127.255.255.
 */
export function isTailnetAddress(address) {
	return typeof address === "string" && TAILNET_V4.test(address);
}

/**
 * Tailnet addresses this machine currently holds, best first.
 * @param interfaces - `networkInterfaces()` result, injectable for tests.
 * @returns ordered 100.64/10 addresses; empty when Tailscale is down or absent.
 */
export function tailnetAddresses(interfaces = networkInterfaces()) {
	const found = [];
	for (const list of Object.values(interfaces ?? {})) {
		for (const iface of list ?? []) {
			if (iface.family !== "IPv4" || iface.internal) continue;
			if (isTailnetAddress(iface.address)) found.push(iface.address);
		}
	}
	return found;
}

/**
 * Where the `tailscale` CLI may live, most specific first. Windows installs it to
 * `Program Files\Tailscale` and usually onto PATH; a Linux package does PATH only.
 * The CLI is optional (see the module note), so nothing depends on finding it.
 * @param env - environment to read (PATH, ProgramFiles, LOCALAPPDATA).
 * @param execPath - the runtime's node.exe, to look beside.
 * @param platform - `process.platform`.
 * @returns candidates in priority order.
 */
export function tailscaleCandidates(env = process.env, execPath = process.execPath, platform = process.platform) {
	const name = platform === "win32" ? "tailscale.exe" : "tailscale";
	const candidates = [join(dirname(execPath), name)];
	for (const dir of String(env.PATH ?? "").split(delimiter)) {
		if (dir.length > 0) candidates.push(join(dir, name));
	}
	if (platform === "win32") {
		for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
			if (typeof root === "string" && root.length > 0) candidates.push(join(root, "Tailscale", name));
		}
		if (typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.length > 0) candidates.push(join(env.LOCALAPPDATA, "Tailscale", name));
	}
	return candidates;
}

/**
 * Locate the Tailscale CLI, or undefined when it is not installed.
 * @param env - environment to read.
 * @param execPath - the runtime binary to look beside.
 * @param platform - `process.platform`.
 * @param exists - existence probe, injectable for tests.
 * @returns the first candidate that exists.
 */
export function findTailscale(env = process.env, execPath = process.execPath, platform = process.platform, exists = existsSync) {
	return tailscaleCandidates(env, execPath, platform).find((candidate) => exists(candidate));
}

/**
 * Read the fields this plugin needs out of `tailscale status --json`.
 *
 * `DNSName` carries a trailing dot (it is a fully qualified name) and is the stable
 * MagicDNS name, which is the point of preferring it over the address: the address
 * survives a restart, but only the name survives the device being removed and re-added
 * to the tailnet. `BackendState` is how a Windows machine that had Tailscale fully
 * exited reads as not running, which is otherwise invisible.
 *
 * @param text - the CLI's stdout.
 * @returns `{ dnsName, ipv4, backendState }`, or undefined for junk.
 */
export function parseTailnetStatus(text) {
	let parsed;
	try {
		parsed = JSON.parse(String(text));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const self = parsed.Self;
	if (typeof self !== "object" || self === null) return undefined;
	const dnsName = typeof self.DNSName === "string" && self.DNSName.length > 0 ? self.DNSName.replace(/\.$/u, "") : undefined;
	const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
	// IPv4 only: the tailnet address is what the proxy can bind, and a Tailscale node
	// also advertises an IPv6 address that is not reachable the same way.
	const ipv4 = ips.find((ip) => isTailnetAddress(ip));
	const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : undefined;
	if (dnsName === undefined && ipv4 === undefined && backendState === undefined) return undefined;
	return { dnsName, ipv4, backendState };
}

/**
 * Run `tailscale status --json`, tolerating a missing or slow CLI.
 * @param exe - the CLI path.
 * @param options - `run` (injectable command runner) and `timeoutMs`.
 * @returns the parsed status, or undefined when the CLI did not answer usably.
 */
export function readTailnetStatus(exe, options = {}) {
	const { run = runCommand, timeoutMs = TAILNET_STATUS_TIMEOUT_MS } = options;
	if (typeof exe !== "string" || exe.length === 0) return Promise.resolve(undefined);
	return Promise.resolve()
		.then(() => run(exe, ["status", "--json"], timeoutMs))
		.then((stdout) => parseTailnetStatus(stdout))
		.catch(() => undefined);
}

/**
 * Spawn a command and collect stdout. Output only: the CLI is read, never driven,
 * so a failure to run it simply means "no name", not an error the reader must see.
 * @param exe - executable path.
 * @param args - arguments.
 * @param timeoutMs - how long to wait before giving up and killing it.
 * @returns stdout text.
 */
function runCommand(exe, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		let out = "";
		let child;
		try {
			child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch (cause) {
			reject(cause);
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			reject(new Error("tailscale status timed out"));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			out += String(chunk);
		});
		child.on("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
	});
}

/**
 * Resolve what this machine can do on a tailnet right now.
 *
 * The local interface address wins over the CLI's, because binding a specific
 * address needs that address to exist on an interface: a node in userspace mode can
 * report an IP the machine has not got, and binding it would fail with EADDRNOTAVAIL.
 * The CLI still supplies the name and the backend state.
 *
 * @param options - injectable `interfaces`, `env`, `execPath`, `platform`, `exists`, `run`.
 * @returns `{ address, dnsName, backendState, source, exe, addresses }`; `address` is
 *   undefined when there is no tailnet to bind, and `source` says where it came from.
 */
export async function discoverTailnet(options = {}) {
	const { interfaces = networkInterfaces(), env = process.env, execPath = process.execPath, platform = process.platform, exists = existsSync, run } = options;
	const addresses = tailnetAddresses(interfaces);
	const exe = findTailscale(env, execPath, platform, exists);
	const status = exe === undefined ? undefined : await readTailnetStatus(exe, run === undefined ? {} : { run });
	const address = addresses[0] ?? status?.ipv4;
	const source = addresses.length > 0 ? "interface" : status?.ipv4 === undefined ? undefined : "cli";
	return { address, dnsName: status?.dnsName, backendState: status?.backendState, source, exe, addresses };
}

/**
 * The link a phone opens for a tailnet host. Prefers the MagicDNS name when there is
 * one, so the link outlives the address; falls back to the address otherwise.
 * @param options - `{ host, port, token }`.
 * @returns the link, or undefined when any part is missing.
 */
export function tailnetLink({ host, port, token }) {
	if (typeof host !== "string" || host.length === 0) return undefined;
	if (!Number.isInteger(port) || port <= 0) return undefined;
	if (typeof token !== "string" || token.length === 0) return undefined;
	return `http://${host}:${String(port)}/?token=${token}`;
}
