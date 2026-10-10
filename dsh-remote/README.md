# dsh-remote

Reach your DeepSeek Harness from your phone.

dsh binds the loopback address only, and its session cookie is bound to the authority it was issued
for — so a remote authority (a LAN address, a tunnel hostname) can never present a valid cookie. This
plugin runs a small **authenticated reverse proxy inside the dsh process**: the phone talks to the
proxy, and the proxy re-issues the request to dsh's loopback address with a cookie it holds
(exchanged from `ctx.connection`'s launch token). Ported from DSHDesktop's remote page.

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub — a bare dsh, or a profile where it is
not installed — the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-remote
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-remote
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs no flag.

Restart dsh afterwards — plugins have no HMR.

## Channels

| Channel | Reaches | Notes |
| ------- | ------- | ----- |
| LAN | nothing leaves your network | binds `0.0.0.0`; open `http://<lan-ip>:<port>/?token=…` on the phone; no extra binary |
| Tunnel | the public internet | also spawns the `cloudflared` next to the dsh runtime (Cloudflare quick tunnel) |

**Off by default** — the link is the only credential, and enabling publishes your harness to whoever
holds it.

## Response-side work

Not a plain passthrough; four needle-anchored rewrites a drifted dsh frontend simply skips:

- **Mobile UI** — document navigations get `mobile.css`/`mobile.js` (narrow-screen layout, iOS
  keyboard/viewport fixes), a splash overlay, and a no-zoom viewport meta. Assets are never rewritten.
- **Project browser** — `/dsh-remote/project`: read-only file tree, mapped to the current session's
  workspace via dsh's `storages/workspace.json`; previews (8 MB) and downloads (64 MB, RFC 5987
  filenames), paths confined to the workspace.
- **gzip** — text assets ≥4 KB, on request (saves the Cloudflare leg).
- **Idle keepalives** — against Cloudflare's ~100 s idle kill: the WS bridge Pings after 30 s of
  downstream silence, but only with no partial frame buffered; a quiet `text/event-stream` gets a
  `: keepalive` line. A busy channel gets nothing.

If the bundled assets are missing the proxy degrades to passthrough rather than failing requests.

## Routes

Served by dsh's origin, behind its gate:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-remote/panel.js` `/dsh-remote/panel.css` | browser half |
| GET | `/dsh-remote/api/remote` | state, link, LAN addresses, cloudflared path |
| POST | `/dsh-remote/api/remote` | `enable` · `disable` · `mode` · `reset-token` |
| GET | `/dsh-remote/api/status` | the same state **without** the credential |
| GET | `/dsh-remote/qr.svg` | QR code for the current link |

The project browser is served by the **proxy**, so it needs the link's token:
`/dsh-remote/project` and `/dsh-remote/project/api/*`.

## The gate

256-bit token compared in constant time; `?token=…` is exchanged for an `HttpOnly` cookie via a 303
(the token never stays in an address bar); a wrong token waits 500 ms before its 403; the token is
never logged. Disabling revokes the cookie, and *Reset link* invalidates every link shared before it.

## Data

| What | Where |
| ---- | ----- |
| Enabled, channel, port, token, cloudflared path | `$DSH_HOME/dsh-remote.json` |

Token and port persist, so **a saved LAN link survives a dsh restart** (a tunnel URL cannot —
Cloudflare assigns a new hostname each time).

## Caveats

- **The tunnel does not survive dsh.** The desktop shell keeps cloudflared outside its Job Object; a
  plugin inside the process cannot, so the tunnel URL changes every restart. Reconnects back off
  500 ms → 30 s, then retry forever.
- **A quick tunnel is a single connection.** If your ISP reclaims idle QUIC/UDP sessions the link
  dies, which is why the tunnel is spawned pinned to `--protocol http2`.
- **The QR code needs `qrcode`.** A git/npm install brings it along, verified. A *local path* install
  makes a `link:` dependency and pnpm skips a linked package's own dependencies — run `npm install`
  inside the plugin directory in that case, or the panel shows the install hint instead of the symbol
  (the link still works).

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-remote"
node tests/proxy.test.mjs     # frame bridge, HTML/gzip/SSE rewrites, project routes
```

`tests/remote-live.mjs <baseUrl> <proxyPort> <token>` is a live suite; it opens and closes remote
access on the instance it targets, so point it at a sandbox — never at a harness someone is using.

## License

MIT. The mobile assets under `lib/assets/` are vendored from DSHDesktop (also MIT).
