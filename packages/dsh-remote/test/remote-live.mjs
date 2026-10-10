/**
 * Live checks for the remote proxy. Needs a running dsh with this plugin
 * installed and remote access enabled:
 *
 *   node test/remote-live.mjs <baseUrl> <proxyPort> <token>
 *
 * `<baseUrl>` is dsh's own origin plus this plugin's prefix, e.g.
 * `http://127.0.0.1:7481/dsh-remote`; `<proxyPort>` and the token come from
 * `GET <baseUrl>/api/remote`. Never point this at a harness someone is using —
 * it opens and closes remote access on the instance it is given.
 */
import { connect } from "node:net";

const [base, proxyPortRaw, token] = process.argv.slice(2);
const proxyPort = Number(proxyPortRaw);
if (base === undefined || !Number.isInteger(proxyPort) || token === undefined) {
	console.error("usage: node test/remote-live.mjs <baseUrl> <proxyPort> <token>");
	process.exit(2);
}

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });
const proxy = `http://127.0.0.1:${String(proxyPort)}`;

/** Fetch, never following redirects so the gate's answer stays visible. */
const raw = (url, headers = {}) => fetch(url, { redirect: "manual", headers });

// --- gate: no credential --------------------------------------------------
const bare = await raw(`${proxy}/`);
check(bare.status === 403, "no credential is refused with 403", String(bare.status));

// --- gate: wrong token ----------------------------------------------------
const started = Date.now();
const wrong = await raw(`${proxy}/?token=${"0".repeat(64)}`);
const elapsed = Date.now() - started;
check(wrong.status === 403, "a wrong token is refused with 403", String(wrong.status));
check(elapsed >= 450, "a wrong token is delayed (anti-probe)", `${String(elapsed)}ms`);

// --- gate: right token mints the cookie ----------------------------------
const entry = await raw(`${proxy}/?token=${token}`);
check(entry.status === 303, "the correct token redirects (303)", String(entry.status));
check(entry.headers.get("location") === "/", "the redirect strips the token from the address", String(entry.headers.get("location")));
const setCookie = entry.headers.getSetCookie?.() ?? [];
const gate = setCookie[0]?.split(";", 1)[0] ?? "";
check(gate.startsWith("__dsh_remote="), "a gate cookie is issued", gate.slice(0, 24));
check(/HttpOnly/i.test(setCookie[0] ?? ""), "the gate cookie is HttpOnly");

// --- HTML rewrite (document navigation only) ------------------------------
const cookie = { cookie: gate };
const documentAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const index = await raw(`${proxy}/`, { ...cookie, accept: documentAccept });
const html = await index.text();
check(index.status === 200, "the cookie authenticates the index", String(index.status));
check(html.includes("<!-- dsh-remote-mobile -->"), "the proxied document carries the mobile injection marker");
check(html.includes("maximum-scale=1, user-scalable=no"), "the viewport is rewritten to the no-zoom form");
check(html.includes("dsh-splash"), "the splash overlay is injected");

// An asset fetch must NOT be rewritten.
const assetPath = html.match(/src="(\/[^"]+\.js)"/u)?.[1];
if (assetPath === undefined) {
	check(false, "a script asset is found in the document");
} else {
	const asset = await raw(`${proxy}${assetPath}`, { ...cookie, accept: "*/*" });
	const body = await asset.text();
	check(!body.includes("maximum-scale=1, user-scalable=no"), "an asset fetch is not rewritten", assetPath);
}

// --- gzip -----------------------------------------------------------------
// Upstream dsh does not compress; only the proxy's transform produces this pair.
if (assetPath !== undefined) {
	const plain = await raw(`${proxy}${assetPath}`, { ...cookie, "accept-encoding": "identity", accept: "*/*" });
	await plain.arrayBuffer();
	const gzipped = await raw(`${proxy}${assetPath}`, { ...cookie, "accept-encoding": "gzip", accept: "*/*" });
	await gzipped.arrayBuffer();
	check(plain.headers.get("content-encoding") === null, "an identity fetch is not compressed", String(plain.headers.get("content-encoding")));
	check(gzipped.headers.get("content-encoding") === "gzip", "a gzip fetch is compressed by the proxy", `${String(gzipped.status)} ${assetPath}`);
}

// --- project browser (behind the same gate) -------------------------------
const projectPage = await raw(`${proxy}/dsh-remote/project`, cookie);
const projectHtml = projectPage.status === 200 ? await projectPage.text() : "";
check(projectPage.status === 200 && projectHtml.includes("dsh-remote-project"), "the project page is served through the proxy", String(projectPage.status));
const projectApi = await raw(`${proxy}/dsh-remote/project/api/resolve?sid=${"f".repeat(32)}`, cookie);
check(projectApi.status === 404, "an unknown session 404s on resolve", String(projectApi.status));
await projectApi.body?.cancel?.();
// The project routes must not shadow this plugin's own API: the phone loads the
// panel through the same origin.
const panelApi = await raw(`${proxy}/dsh-remote/api/status`, cookie);
check(panelApi.status === 200, "this plugin's own API still reaches dsh through the proxy", String(panelApi.status));
await panelApi.body?.cancel?.();

// --- WebSocket upgrade ----------------------------------------------------
function upgrade(path, extraHeaders) {
	return new Promise((resolve) => {
		const socket = connect(proxyPort, "127.0.0.1", () => {
			socket.write(
				`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(proxyPort)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extraHeaders}\r\n`
			);
		});
		let data = "";
		socket.on("data", (chunk) => {
			data += String(chunk);
			if (data.includes("\r\n\r\n")) {
				socket.destroy();
				resolve(data.split("\r\n", 1)[0]);
			}
		});
		socket.on("error", () => resolve("socket error"));
		socket.on("close", () => resolve(data.split("\r\n", 1)[0] ?? "closed"));
		setTimeout(() => {
			socket.destroy();
			resolve(data.split("\r\n", 1)[0] ?? "timeout");
		}, 5000);
	});
}

const denied = await upgrade("/api/remote.mux", "Cookie: __dsh_remote=nope\r\n");
check(denied !== "HTTP/1.1 101 Switching Protocols", "an upgrade without a valid cookie is refused", denied);
const granted = await upgrade("/api/remote.mux", `Cookie: ${gate}\r\n`);
check(granted === "HTTP/1.1 101 Switching Protocols", "an upgrade with the gate cookie is proxied to dsh", granted);

// --- QR -------------------------------------------------------------------
const qr = await raw(`${base}/qr.svg`);
const qrBody = qr.status === 200 ? await qr.text() : "";
check(qr.status === 200 && qrBody.includes("<svg"), "the QR route returns an SVG", `${String(qr.status)} / ${String(qrBody.length)}B`);

// --- status route must not leak the credential ----------------------------
const status = await raw(`${base}/api/status`);
const statusJson = await status.json().catch(() => ({}));
check(statusJson.status?.link === undefined && statusJson.status?.token === undefined, "the summarized status carries no credential", JSON.stringify(statusJson).slice(0, 120));

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? `\nREMOTE LIVE PASS (${String(results.length)})` : `\nREMOTE LIVE FAIL (${String(failed.length)})`);
if (failed.length > 0) process.exitCode = 1;
