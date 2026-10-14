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
| Tailscale | devices on your tailnet | binds this machine's `100.64.0.0/10` address only; the link is `http://<machine>.<tailnet>.ts.net:<port>/?token=…` and is **stable across restarts**; needs Tailscale on both devices, no open port, nothing public |
| LAN | nothing leaves your network | binds `0.0.0.0`; open `http://<lan-ip>:<port>/?token=…` on the phone; no extra binary |
| Tunnel | the public internet | also spawns `cloudflared` (Cloudflare quick tunnel); see the caveat below about finding it |

**Off by default**: the link is the only credential, and enabling serves your harness to whoever
holds it.

## The tailnet channel

Tailscale hands every device a stable address in the carrier-grade NAT range `100.64.0.0/10` and a
MagicDNS name, and carries the traffic over WireGuard. So this channel is mostly a bind: the proxy
listens on **only** that address, and the link is built from the MagicDNS name when the CLI can name
it, falling back to the address. Nothing is published, no port is opened, and the link survives a
restart because the name does (the token is persisted too).

Deliberately **not** `tailscale serve`, which most community plugins use. Serve puts dsh's own
authority (`<machine>.<tailnet>.ts.net`) in front of the harness, and dsh's browser fence rejects an
authority it does not trust, so those plugins also have to register a trusted host and enable HTTPS
certificates on the tailnet. This proxy already terminates the remote authority and re-issues every
request to dsh under the loopback authority, so the tailnet name never reaches the fence and none of
that is needed here.

The Tailscale CLI is **optional**: the address is read off the network interfaces, which is enough to
bind and to hand out a working link. The CLI is consulted only when it is present, for the MagicDNS
name and for an honest "installed but not running" report in the panel.

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
| GET | `/dsh-remote/api/remote` | state, link, LAN addresses, tailnet status, cloudflared path, the installer's report (`cloudflaredSetup`), and what the profile patch says about the folder picker (`picker`) |
| POST | `/dsh-remote/api/remote` | `enable` · `disable` · `mode` (`tailnet` · `lan` · `tunnel`) · `reset-token` · `cloudflared` (a path) · `cloudflared-proxy` (a proxy URL) · `cloudflared-install` (start the install again) · `picker-pin` (`pinned`: ask for the in-page folder browser, or take the ask back) |
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
| Enabled, channel, port, token, cloudflared path and download proxy | `$DSH_HOME/dsh-remote.json` |

Token and port persist, so **a saved LAN or tailnet link survives a dsh restart** (a tunnel URL cannot,
because Cloudflare assigns a new hostname each time, while a tailnet link is stable because the MagicDNS
name is).

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

## Picking a folder from the phone

Adding a workspace needs a directory chooser, and dsh resolves which one it composes **once, at boot**:
`@deepseek-ai/dsh-host-directory-picker-auto` reads its own bind host, and a loopback bind means the
`native` backend, whose chooser is an OS folder dialog on this machine's screen. A phone can neither see
nor drive that dialog, so 添加工作区 did nothing on the phone (an error until 2026-10-14, a window on the
PC after that), while the app's own window never notices: it carries `__DSH_DIRECTORY_PICKER__` from the
app's preload and picks through Electron.

dsh ships the interaction for this case: the `browse` backend and its client surface render a folder
browser inside the page, so the desktop and the phone share one shape. Nothing selects it for a loopback
bind, and tunnel mode is exactly that, so this plugin asks for it in the profile patch document, the same
pin DSHDesktop's Rust bootstrap writes (`bootstrap/patches/picker.rs` in
`LBurny/deepseek-harness-desktop`): an id-targeted op disabling the row `directory-picker`, plus insert
rows for `directory-picker-browse` (`@deepseek-ai/dsh-host-directory-picker-browse`) and
`ui-directory-picker-browse` (`@deepseek-ai/dsh-client-ui-directory-picker-browse`). The plugin writes it
at every load (`lib/picker.js`), idempotently, keeping every comment and `!!js` tag of that shared file,
and the panel shows what the file says, with a switch that takes the ask back. The composition is read
when dsh starts, so a change applies after the next restart.

Three things ride on the mounted picker, because the files a DSHDesktop-style patch would edit sit inside
the official app's `app.asar`, where a plugin cannot reach them:

- **The drive level.** dsh's browse backend lists one level of one fully qualified path, so a reader who
  starts in the home directory can walk down but never sideways: another drive has no entry and no crumb.
  The plugin wraps the capability object the workspace controller resolves per call
  (`ctx.directoryPicker.capability().list`), answers the sentinel path `dsh:drives` with one row per
  readable drive root, puts a `This PC` crumb in front of a drive root's chain, and answers the client's
  opening request (no path at all) with that level: it is what Windows' own chooser does, and the only
  view from which every drive is one tap away, because the client folds the crumb chain inside the home
  subtree into a single Home crumb. The backend's own listing is never reimplemented, only amended.
- **The phone's footer.** The native footer wraps `打开` onto a second line at a phone width, and the
  hidden-entries switch is not something a phone needs. `mobile.css` hides the switch and lays the
  remaining three controls out on one row (`flex: 1 1 auto`, so measured content decides the shares: at
  the phone's inherited page zoom of 1.14 the footer is 335 device px, and an equal split gives
  `新建文件夹` 99 px where its content needs about 103, which wraps the label).
- **The client-side companion.** `lib/client.js` presses that hidden switch once per dialog open (upstream
  resets it to off every time, and dot-directories are common workspace locations), renames the drive
  level's crumb on a Chinese page (the host names it before any client exists, so it cannot know the
  language), and disables `打开` and `新建文件夹` on the drive level itself, where `dsh:drives` is not a
  directory and picking it would only fail in the workspace controller. Each edit is a property or a text
  node React re-renders from its own state, so a re-render can undo one and the observer puts it back.

Two limits worth knowing: the pin is a profile-patch fact, so uninstalling this plugin leaves it behind
(take the ask back from the panel first), and inside the home subtree the folded crumb chain means the
drives are reached by reopening the dialog rather than by a crumb.

## The link survives a restart

The link is the credential, so a restart must not invalidate it. The tailnet channel is stable by
construction (the MagicDNS name does not change), and the LAN channel only has to keep its port; the
tunnel is the hard case, because a Cloudflare *quick* tunnel gets a fresh random hostname every time
cloudflared starts, which would mean re-scanning the QR code after every restart. So, like the desktop
shell, this plugin keeps the tunnel instead:

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

- **Tailnet mode needs Tailscale on both devices**, signed into the same tailnet, and a tailnet
  address on this machine (the interface scan is what finds it). If Tailscale is installed but its
  backend is not running, the panel says so; if there is no address at all, enabling reports an error
  and binds nothing, because a tailnet-only channel must not quietly fall back to serving the LAN.
  Windows Firewall may prompt the first time the port is bound on the Tailscale interface. No
  certificate and no `tailscale serve` are needed (see "The tailnet channel" above).
- **Tunnel mode needs a cloudflared binary, and neither app ships one.** The search runs on every plugin
  load, in order: the `cloudflaredPath` setting, the directory holding the running runtime
  (`process.execPath`, which is where the shell keeps its own copy), `<dsh home>/../tunnel/`, every `PATH`
  entry, then the winget shim and the MSI install directory. When that finds nothing the plugin installs
  one itself, to `<dsh home>/../tunnel/`, before the panel can ask for anything: the version and the
  sha256 come from Cloudflare's own update endpoint (`https://update.argotunnel.com/?os=&arch=`), the
  bytes arrive through `curl`, and nothing is kept unless the digest matches, plus the Authenticode
  signature on Windows. Where `github.com` cannot be reached (DNS-poisoned on some networks, measured on
  a China Unicom line) set `cloudflaredProxy` in the panel, or the standard `HTTPS_PROXY`; a path typed
  by hand still wins over everything. LAN mode needs no binary at all.
- **The download is verified against Cloudflare, not against whoever served it.** That is what lets the
  bytes come from a proxy or a mirror at all: the manifest is read from Cloudflare over HTTPS, and a
  file whose sha256 differs is discarded rather than installed (the temporary download is removed, and
  the panel names the reason: manifest, download, checksum, signature, unpack, or an unsupported
  platform).
- **On macOS the release is a tarball and the checksum is the binary inside it.** Measured against the
  darwin release: the `.tgz` hashes to `903845b8…` while the 42,328,240-byte Mach-O it holds hashes to
  `0560c9ab…`, which is what the manifest publishes. So a compressed release is unpacked first and the
  digest is checked on the file that gets installed. Installing the archive instead would leave a tarball
  named `cloudflared` whose digest the manifest accepts, which the search then reports as ready on every
  later run and which can never run.
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
node tests/picker.test.mjs    # the profile-patch pin, the drive level, and the capability wrap
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
