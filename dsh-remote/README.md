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
| Tunnel | the public internet | also spawns `cloudflared` (Cloudflare quick tunnel); see the caveat below about finding it |

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
| GET | `/dsh-remote/client.js` `/dsh-remote/client.css` | browser half |
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

## The phone's page

The proxy rewrites dsh's HTML: it injects `assets/mobile.css` + `assets/mobile.js` before `</head>`, which
is where the phone-only fixes live — the project browser tab, the attachment button, the viewport reset,
and three compensations for upstream behaviour that will not change:

- **The preview notice is re-shown on every remote load.** Upstream stores its acknowledgement in a
  settings scope whose persistence follows the transport, and for a remote browser that scope is
  memory-mode ("the acknowledgement stays process-local here"), so it never persists. `mobile.js` clicks
  its Continue control as soon as the modal appears and marks its portal, which `mobile.css` hides — the
  click matters as much as the hide, because the modal holds `#root` inert while it is up.
- **The settings sheet cannot work as designed at 390 px.** Its panel is 800 px wide with a fixed 188 px nav
  column beside the content, which on a phone leaves the content a sliver; the sheet is made a full-screen
  flex column whose nav becomes a centred tab strip with a safe-area inset at the top. Measured on the real
  page, four tabs are 401 px of content in a 390 px screen, so the strip centres them and wraps rather than
  scrolling — a scrollbar at that size just means the last tab is invisible and nobody discovers it.
- **The models tab cannot read settings from a remote page at all.** Upstream loads the provider directory
  from a settings "describe face", and a remote transport has no view for it, so the page fails with
  `加载提供商目录失败: settings are unavailable in this browser` and Retry never helps. That boundary is
  deliberate — it is what stops a link-holder from rewriting the host's settings and API keys — so the layer
  does not fake a loopback origin. It only adds a line under the failure saying where to change it.

All three match on the exact upstream wording and on `[class*="_…"]` local-name substrings, so an upstream
rename degrades to "the phone looks like it did before" rather than breaking the page.

## The link survives a restart

The link is the credential, so a restart must not invalidate it. A Cloudflare *quick* tunnel gets a fresh
random hostname every time cloudflared starts, which would mean re-scanning the QR code after every restart —
so, like the desktop shell, this plugin keeps the tunnel instead:

- cloudflared is spawned **detached**, with its output going to `<DSH_HOME>/dsh-remote-tunnel.log` rather
  than to the plugin's pipes. A pipe would break the moment dsh exits, and cloudflared dying on a write
  error is exactly the churn this avoids.
- Its hostname, pid and target are recorded in `<DSH_HOME>/dsh-remote-session.json`.
- The next start **adopts** that tunnel instead of spawning one, provided the record agrees with this run
  (same binary, same proxy target) **and** the tunnel still answers for the current token — one probe
  covers both a dead process and a tunnel pointing at a proxy port that no longer exists. The panel then
  says the link is unchanged.
- The proxy rebinds the remembered port for the same reason, so the tunnel's target stays valid.
- Disabling remote access is the one path that kills the tunnel and forgets the session (the next enable
  then mints a new link, which is what "disable" has to mean). On unload the plugin only stops supervising.

If any check fails, the plugin kills the stale tunnel and starts a fresh one — a new hostname, the same
token, so the old link stops working and the panel shows the new one.

## Caveats

- **Tunnel mode needs a cloudflared binary, and neither app ships one.** The search is, in order: the
  `cloudflaredPath` setting, the directory holding the running runtime (`process.execPath`, which is
  where the shell keeps its own copy), `<dsh home>/../tunnel/`, every `PATH` entry, then the winget shim
  and the MSI install directory. On a machine with none of those the panel says where it looked and
  takes a path (saved to `$DSH_HOME/dsh-remote.json`); `winget install Cloudflare.cloudflared` is the
  one-line fix. LAN mode needs no binary at all.
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

For the phone page itself, the rewritten UI this plugin exists for, drive a **browser at a phone
viewport against the running sandbox** (the layer keys off `max-width: 700px`, not the user agent):
resize to 390x844, open the proxy origin with its token, then **enter a session with content before
asserting anything**, because the layer gives up silently when its anchors are missing. The full
procedure, what it must show, and the one console error that is expected are in the repository's
AGENTS.md, under "The phone path is tested in a browser sized like a phone".

## License

MIT. The mobile assets under `lib/assets/` are vendored from DSHDesktop (also MIT).
