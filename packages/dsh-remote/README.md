# dsh-remote

Reach your DeepSeek Harness from your phone.

dsh binds the loopback address only, and its browser session cookie is bound to the authority it was
issued for — so a remote authority (a LAN address, a tunnel hostname) can never present a valid
cookie. This plugin therefore runs a small **authenticated reverse proxy inside the dsh process**:
the phone talks to the proxy, the proxy re-issues the request to dsh's loopback address with a cookie
it holds. The cookie comes from dsh's public API (`ctx.connection`'s launch token, exchanged exactly
the way the desktop shell does it).

Ported from DSHDesktop's remote page, including its response-side work.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-remote
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-remote
```

`--profile web` is DSHDesktop's shell profile; the official dsh desktop app uses `--profile desktop`
(check `$DSH_HOME/profiles/`). The plugin panel needs no profile flag.

Restart dsh afterwards — plugins have no HMR.

## Channels

| Channel | Reaches | Notes |
| ------- | ------- | ----- |
| LAN | nothing leaves your network | The proxy binds `0.0.0.0`; open `http://<your-lan-ip>:<port>/?token=…` on the phone. Needs no extra binary. |
| Tunnel | the public internet | Also spawns the `cloudflared` binary that ships next to the dsh runtime, opening a Cloudflare quick tunnel. Works from any network. |

**Off by default.** The link is the only credential: enabling publishes your harness to whoever holds
it. Turn it off when you are done.

## What it does on the response side

The proxy is not a plain passthrough. Four rewrites, all needle-anchored so a drifted dsh frontend
simply skips them:

- **Mobile UI** — a document navigation (`Accept: text/html`) gets `mobile.css`/`mobile.js` injected
  (narrow-screen layout, the iOS keyboard and viewport fixes), a splash overlay while the SPA boots,
  and its viewport meta rewritten to the no-zoom form. Asset fetches are never rewritten.
- **Project browser** — `/dsh-remote/project` serves a read-only file tree. It maps the current
  session to its workspace through dsh's own `storages/workspace.json`, then lists directories,
  previews text and images (8 MB cap) and offers downloads (64 MB cap, RFC 5987 filenames). Paths are
  strictly confined to the workspace.
- **gzip** — text assets ≥4 KB are gzipped for clients that ask for it (dsh does not compress itself;
  on the tunnel this saves the Cloudflare leg).
- **Idle keepalives** — against Cloudflare's ~100 s idle connection kill: the WebSocket bridge emits
  its own Ping after 30 s of downstream silence, but only when no partial frame is buffered (frame
  boundaries are parsed, so a Ping never lands inside a half frame); any `text/event-stream` upstream
  that goes quiet for 30 s gets a `: keepalive` comment line. A busy channel gets no keepalive at all.

If the bundled assets are missing (a broken packaging job) the proxy degrades to plain passthrough
rather than failing requests.

## Routes

These hang off dsh's own origin and are protected by its gate:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-remote/panel.js` `/dsh-remote/panel.css` | browser half |
| GET | `/dsh-remote/api/remote` | state, link, LAN addresses, cloudflared path |
| POST | `/dsh-remote/api/remote` | `enable` · `disable` · `mode` · `reset-token` |
| GET | `/dsh-remote/api/status` | the same state **without** the credential |
| GET | `/dsh-remote/qr.svg` | QR code for the current link |

The project browser and its API are served by the **proxy**, so they are reachable only with the
link's token: `/dsh-remote/project` and `/dsh-remote/project/api/*`.

## The gate

- 256-bit random token, lowercase hex, compared in constant time.
- The first request carrying `?token=…` is answered with a 303 to `/` and an `HttpOnly` cookie; the
  token never appears in a URL the browser keeps.
- A wrong token is refused after a 500 ms delay, so the link cannot be probed cheaply.
- The token is never logged.
- Disabling revokes the cookie; *Reset link* issues a fresh credential and invalidates every link
  shared before it.

## Data

| What | Where |
| ---- | ----- |
| Enabled, channel, port, token, cloudflared path | `$DSH_HOME/dsh-remote.json` |

The token and port persist, so **a saved LAN link keeps working across a dsh restart** (a tunnel URL
never does — Cloudflare assigns a new hostname each time).

## Caveats

- **The tunnel process does not survive dsh.** The desktop shell keeps cloudflared outside its Job
  Object so it outlives the app; a plugin inside the process cannot, so the tunnel URL changes on
  every restart. Reconnects use exponential backoff (500 ms → 30 s, then slow retries forever).
- **A quick tunnel has one connection and no redundancy.** If your ISP reclaims idle QUIC/UDP
  sessions, the whole link dies; that is why the tunnel is spawned pinned to `--protocol http2`.
- **The QR code needs the `qrcode` dependency.** A `dsh plugin add` from the repository (git or npm)
  installs it for you — verified end to end. A *local path* install makes a `link:` dependency, and
  pnpm does not materialize a linked package's own dependencies, so in that case run
  `npm install` inside the plugin directory, or use a profile-level install. Without it the panel
  shows the install command instead of the symbol, and the link stays usable.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-remote"
node test/proxy.test.mjs        # frame bridge, HTML/gzip/SSE rewrites, project routes
```

There is also a live suite that needs a running instance with remote access enabled — it opens and
closes remote access on the instance it is pointed at, so use a sandbox, never a harness someone is
using:

```bash
# <baseUrl> is dsh's origin plus this plugin's prefix; the port and token come
# from GET <baseUrl>/api/remote
node test/remote-live.mjs http://127.0.0.1:<dsh port>/dsh-remote <proxy port> <token>
```

It checks the gate (refusal, delay, cookie), the mobile rewrite markers, the identity-vs-gzip pair,
the project page and its API, that this plugin's own API still reaches dsh through the proxy, the
WebSocket upgrade, the QR route, and that the summarized status leaks no credential.

## License

MIT. The mobile assets under `assets/` are vendored from DSHDesktop (also MIT).
