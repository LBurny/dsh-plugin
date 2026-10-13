# Visual harness

Screenshots of the real dsh web UI, so a stylesheet change can be **looked at**
instead of inferred from computed styles. Node 22+ only — it drives the Edge/Chrome
already on the machine over the DevTools protocol; nothing to install.

```bash
RT=/f/DSHDesktop/runtime/windows-x64          # any dsh runtime with node.exe
"$RT/node.exe" "$RT/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" web --port 7411 --no-open &
# prints:  dsh web: http://127.0.0.1:7411/?token=<token>

node tools/visual/shot.mjs --url "http://127.0.0.1:7411/?token=<token>" \
     --sizes 1400x900,1000x600 --zooms 1,1.5,2 --click 继续 --name sidebar
```

Every combination of size and zoom writes `shots/<name>-z<zoom>-<w>x<h>.png` plus a
geometry report, and the console line names the one number that matters:

```
--- sidebar-z2-1400x900
    inner=900 zoom=2 titlebar=false required=214 (alt 220) ceiling=4.12 col=450 footerBottom=788
```

`required` is the height the sidebar needs in layout px (see `--tree` and the note
below), `ceiling` is `0.98 * inner / required` — the largest zoom at which the
sidebar's bottom block still fits. `FOOTER CLIPPED` means it does not.

## Options

| flag | meaning |
| --- | --- |
| `--url <url>` | dsh web URL **with its token** (required); the token is the only credential and it is per-process |
| `--out <dir>` | where PNGs and `<name>.report.json` land (default `tools/visual/shots`) |
| `--sizes <WxH,…>` | viewport sizes to shoot (default `1280x900`) |
| `--zooms <z,…>` | css zoom levels to set on `<html>` (default `1`) |
| `--titlebar on\|off\|keep` | toggles `html[data-windows-titlebar]`, which changes the sidebar's own heights |
| `--click <text>` | click the element whose trimmed text matches, before shooting (e.g. the onboarding dialog's 继续) |
| `--eval <js>` | run raw JS after the size/zoom step — the hook for reproducing a specific state |
| `--css <file>` | inject a stylesheet, to preview a fix live (repeatable) |
| `--tree` | print the sidebar column's subtree with layout heights and `flex-grow` |
| `--panel <pkg>` | render that package's panel **inside a copy of the hub page** (see below) |
| `--theme dark\|light\|keep` | toggles `body[data-ds-dark-theme]` (default keep) |
| `--settle <ms>` | wait after each change (default 500) |
| `--browser-arg <flag>` | pass a browser flag verbatim (repeatable) — see *Shooting a phone origin* |
| `--keep` | leave the browser running for a follow-up run |

## Shooting a phone origin

The proxy injects the mobile layer into dsh's HTML, so the phone's page is shot through the proxy's own port
(`http://127.0.0.1:<proxyPort>/?token=<token>`); the deployed layer is already in the document, which makes
that screenshot exactly what the phone shows. Give the browser the phone's *origin* as well when the question
is about what dsh lets a remote page do — dsh scopes settings from the client's `location.hostname`, and the
proxy rewrites `Host` to loopback, so the server cannot be asked:

```bash
node tools/visual/shot.mjs --url "http://phone.test:29274/?token=$TOKEN" \
  --browser-arg "--host-resolver-rules=MAP phone.test 127.0.0.1" --browser-arg "--no-proxy-server" \
  --sizes 390x844 --ask 'location.origin'
```

`--no-proxy-server` matters: without it the machine's HTTP proxy swallows the fake host and the page fails to
load. A phone viewport has no text labels on the rail's buttons, so open panels with `--eval` on an
`aria-label` (`document.querySelector('[aria-label=设置]').click()`) rather than `--click`. At that origin the
settings sheet's own limits show up: the models tab fails its load with
*settings are unavailable in this browser* — upstream's transport boundary, not something a stylesheet fixes.

The sandbox's own proxy is the usual target, and its URL carries a token that should not be pasted into a
command line (it lands in the shell history and in whatever transcript the run is pasted into).
`shot-proxy.sh` builds that URL from `.sandbox/dsh-remote.json` and execs shot.mjs, so the token never
appears in the invocation:

```bash
node tools/sandbox/sandbox.mjs up            # the proxy comes up with it once remote is enabled
bash tools/visual/shot-proxy.sh --sizes 390x844 \
  --eval 'document.querySelector("[aria-label=插件]").click()' --ask 'location.href'
```

Point it at the *app's* proxy instead when the question is about the build the user's phone really runs:
that port and token live in `<DSH_HOME>/dsh-remote.json`, and the layer is inlined into the HTML, so
`curl -H "Accept: text/html" "<proxy>/?token=…"` shows what is deployed without a browser. The Accept
header is load-bearing: the proxy only rewrites documents it recognises as HTML, and curl's default `*/*`
gets the untouched page (measured 2026-10-13). A proxy holds its assets in memory from the moment the
plugin loads, so a `mobile.css` edit reaches it only through a restart of the process serving it.

## Reviewing a panel

`--panel dsh-skills` needs no install: it puts the panel *inside a copy of the 功能管理 page* — the hub's
own stylesheet, its head (back / title / package chip / refresh) and a `hub-stage[data-view="feature"]`
for the panel to mount into — answers the panel's routes from `fixtures/<pkg>.json`, and fills the window
with it. The preview paints over the app behind it on purpose, so what is reviewed is the panel page at a
known size:

```bash
node tools/visual/shot.mjs --url "$URL" --sizes 1080x900 --panel dsh-skills --theme dark
```

Fixtures are per package and per route (`{"/dsh-skills/api/skills": {…}, "default": {"ok": true}}`); add a
key for a route a panel needs. What this buys: a list's row heights, its gutter against the head's own
back and refresh controls, and how a long description or a wrapped command reads — none of which a
dom-stub assertion can see.

## Facts worth knowing before reading a shot

- **dsh's own chrome is what caps zoom**, not the content. `zoom` on `<html>` divides
  the layout viewport by the factor; past `window height / sidebar requirement` the
  sidebar's stack no longer fits, the shell clips it (`overflow: hidden` on the
  sidebar column) and the document never scrolls. The bottom block — 设置, 意见反馈,
  退出登录 — and the avatar menu off it then become unreachable. This is the bug
  `dsh-zoom` caps, and `required` above is the number it divides by.
- **`required` is measured, not guessed**: the sidebar column is the shell's only
  non-shrinkable stack (every child is `flex: none` except the session region, which
  collapses to zero), so forcing a deliberately oversized zoom makes `scrollHeight`
  report exactly what the column needs — in layout px, which the factor does not
  scale. `alt` is the same number summed from the column's uncompressed children;
  they should agree within the container's padding.
- **Below 1024 px of viewport width dsh auto-collapses the sidebar to a rail**
  (`SIDEBAR_AUTO_COLLAPSE` in `dsh-client-ui-layout`), and a rail needs a very
  different height. Shoot at ≥ 1400 px wide for the expanded sidebar — the one a
  desktop window has — or you will measure the rail by accident.
- **`getBoundingClientRect` reports viewport px, `scrollHeight`/`clientHeight` report
  layout px.** At zoom 2 a 50 px row reports 100. Mixing the two is the easiest way to
  get a zoom answer wrong.
- **A bare sandbox instance is a faithful host for UI work**: dsh's own sidebar and
  layout are core, so a temp `DSH_HOME` shows the real chrome — you only lose the
  plugins that are not installed in it. The harness never touches a running app.
- Zoom changes never fire `resize`, so a shot taken right after `--zooms` needs the
  settle delay; the harness sleeps for you.

## Reading the app's own dsh

When a fix has to match the build the phone actually runs, that build is inside the
official app's `app.asar` — not in `app.asar.unpacked`, which only carries a few
packages. `asar.mjs` reads it without Electron:

```bash
node tools/visual/asar.mjs "<app>/resources/app.asar" --grep "navCell"     # which packed file
node tools/visual/asar.mjs "<app>/resources/app.asar" --cat "<that path>"  # read it
node tools/visual/asar.mjs "<app>/resources/app.asar" --list "dsh/node_modules/@deepseek-ai" 
```

The header size field is a pickle frame (`[payload size][string length][JSON][padding]`); the script scans
for the JSON's braces instead of trusting its offsets, because a wrong guess reads gigabytes of nonsense.
Hashes and local-name prefixes differ per build — `wCInkW_navCell` in the app versus a bare `navCell` in a
sandbox copy of the same geometry — which is why every rule matches on `[class*="_navCell"]`.

Artifacts (`shots/`, `browser-profile/`) are gitignored.
