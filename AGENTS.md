# dsh-plugin — notes for agents

A collection of independent dsh plugins, one feature per package. Read this before changing
anything here; it is short and most of it is a trap someone already walked into.

## Shape

One directory per feature at the repository root, each a **complete, standalone dsh plugin** you can
install on its own (`dsh plugin add <that dir>`). Nothing may import from a sibling package — that is
the whole point of the split. Shared helpers are duplicated on purpose.

```
<name>/
  package.json       dsh.bundle.patch + main: lib/index.js + files: lib/**
  cordis.patch.yml   the `- insert:` row that mounts the package
  README.md  LICENSE
  lib/               host half — every module flat, one responsibility per file
    index.js         the plugin body (name/inject/apply) + routes + index injection
    <role>.js        http.js, layout.js, the feature's own modules …
    client.js        browser half (plain DOM, no build step), served by this package's routes
    client.css       its stylesheet
    sounds/          an asset cluster that ships as a set (dsh-notify)
    assets/          page assets served verbatim (dsh-remote: mobile/splash/project)
  tests/             sibling suite: <name>.test.mjs (+ remote-live.mjs)
  locale/            bilingual name/description for dsh's plugin management page
```

This is the official dsh package shape: `lib/` is flat and modules are named by **role**, not grouped
by feature — `packages/core/tools/src/` upstream is `index / code-mode / json-schema / presentation /
py-types / schema / testing / types`, and across the 286 packages in a dsh runtime the only
directories under `lib/` are `lib/types/` (build output), asset clusters (`markdown/`,
`settings-form/`, `styles/`) and a separate execution entrypoint (`worker/`). Tests live in a sibling
`tests/`, never co-located. Our packages are hand-written JavaScript with no build step, so `lib/` is
both source and published artifact, and `main` points straight at `lib/index.js`.

- The package name is the npm name; the module's exported `name` and the patch row `id` are the short
  name (`dsh-skills` → `skills`). Row ids are first-come, first-served across the whole plugin tree.
- `dsh-features/` is the exception in shape, not in independence: it is the **hub** (the Features page)
  and the only package with a browser *client* half (`dsh.client` + `exports["./client"]` →
  `lib/client.js`, a `__ModuleLoader__.load({id, factory})` classic script, not a module). A real
  sidebar entry can only be added by a dsh client plugin, which is why the hub cannot be an injected
  script like the rest. It imports no sibling and needs none.

## Rules that are easy to get wrong

- **`package.json` must declare `dsh.bundle.patch`.** Without it `dsh plugin add` installs the package
  as a plain dependency and mounts no layer — the symptom is silence, not an error. This happened
  during the split; `--dump-config` is how you catch it.
- **A module-level failure takes the whole plugin tree down** — dsh will not start at all. Verify in a
  sandbox (`$TEMP\dshprobe`, see `DSHPlugin/.agents/skills/dsh-plugin-authoring/references/repo-delivery.md` §4)
  before touching a real `DSH_HOME`.
- **Colours prefer the shell's theme tokens.** `--dsw-alias-bg-base` / `-label-primary` /
  `-label-caption` / `-border-l2` / `-interactive-bg-hover` are defined on `body` (light) and
  `body[data-ds-dark-theme]` (dark) by `@deepseek-ai/dsh-client-ui-theme`, so `var(--dsw-…, <hardcoded
  fallback>)` follows dsh's own light/dark setting. Keep the fallback, and keep the
  `prefers-color-scheme` block beside it: a shell without those tokens must still look right.
- **`zoom` on `<html>` is capped by dsh's own chrome, and the cap is measured, not assumed.**
  The factor divides the layout viewport, so past `window height / sidebar requirement` the sidebar's
  stack no longer fits: the shell clips it (`overflow: hidden` on the sidebar column) and the document
  never scrolls, which puts 设置 / 意见反馈 / 退出登录 and the avatar menu off it out of reach. A constant
  cannot express the requirement — plugins add nav rows, a signed-in profile adds footer rows, and the
  stock rail needs a different height from the expanded sidebar. `dsh-zoom/lib/client.js` therefore
  samples it: forcing a deliberately oversized zoom makes the sidebar column's `scrollHeight` report
  exactly what the stack needs in layout px (its children are all `flex: none` except the session
  region). Restore the sampling zoom in the same task — no frame is painted oversized, and the shell's
  width watcher reads a viewport-space rect on the next animation frame, so it never sees it either.
  Re-measure on resize, and once more when the sidebar mounts, since the cap is read before it exists.
- **The browser halves share exactly two things, both DOM-level:** the `#dsh-launchers` corner
  container and the `--dsh-launcher-stack` custom property, plus the `.dsh-launch` button class whose
  styles are duplicated identically in every `client.css`. Panel styles are scoped under
  `#<package>-root` so six stylesheets cannot fight. Keep both properties when adding a package.
- **Anything the reader arranges belongs on the host, not in browser storage.** The hub's feature order
  lived in `localStorage`, which is per-origin: the desktop shell opens dsh at `127.0.0.1:<port>` while the
  phone reaches the same dsh through the proxy at the tunnel's origin, so a drag on the desktop never
  reached the phone. It is written to `<DSH_HOME>/dsh-features.json` behind `POST /dsh-features/api/order`
  and served with the inventory (one round trip), with `localStorage` kept only as the first-frame cache:
  the host answers and the page reconciles. Anything of that shape has the same trap, dsh's own client
  store included.
- **The phone gets a rewritten page, so its fixes live in the proxy's layer, never in dsh.** Three rules
  are there because upstream will not change: the preview notice is re-shown on every remote load
  (upstream keeps its acknowledgement in a memory-mode settings scope for remote transports, so it never
  persists — `mobile.js` clicks its Continue control and hides its portal); the settings sheet's tab strip
  is left-packed and clips its last tab at 390px (four tabs measure 401px of content in a 390px screen, so
  the strip centres its tabs and wraps rather than scrolling, which nobody would find, and it pads top and
  bottom equally — a bar padded 10px top / 0 bottom reads as *the tabs are not centred*, which is exactly
  what was reported twice); and the models page cannot read settings from a remote origin at all, so the
  layer hides that failure card — Retry included, it can never work — and puts a line in its place pointing
  at the desktop window. `mobile.js` is injected before `</head>`, which is why it can catch a modal before
  the first paint.
- **`[class*="_nav"]` also matches `_navList`.** CSS-modules substrings are not names: a rule written for
  the settings nav bar silently padded the tab *list*, which is why its pills sat at the bottom of the bar
  and looked off-centre no matter how the alignment was set. Scope bar rules with `:has(> [class*="_nav"])`
  or a `>` step, and when a measurement refuses to match the CSS you wrote, suspect your own selector
  before the browser. The same trap exists for `_headerActions` (which also matches the sidebar's), already
  noted for the session header.
- **Reproduce the phone's origin instead of guessing what a phone does.** `shot.mjs --browser-arg` exists
  for this: point the URL at a fake host and let the browser map it to the proxy
  (`--browser-arg "--host-resolver-rules=MAP phone.test 127.0.0.1"` plus `--browser-arg "--no-proxy-server"`,
  or the machine's HTTP proxy swallows the fake host). It matters because **the proxy always rewrites `Host`
  to the loopback authority** (`headers.host = upstream().authority`), so the server cannot tell the two
  apart — dsh decides the settings scope from the client's own `location.hostname`. That is why a loopback
  run shows a working models page and a phone-origin run shows
  `加载提供商目录失败: settings are unavailable in this browser`: upstream's models page fails its load when
  the settings "describe face" has no view (`mirrored.view === void 0`), which is exactly what a remote
  transport gets. **Never make a remote page look like loopback to fix that** — the same scope is what keeps
  a link-holder from rewriting host settings and API keys. Explain it in the layer; nothing else.
- **The official app's own dsh is inside `app.asar`.** When a fix must target the build the phone actually
  runs (hashes and local-name prefixes differ per build), read it without Electron:
  `node tools/visual/asar.mjs <app.asar> --list|--cat|--grep <text>`. `--grep` names the packed file that
  carries a string — that is how the settings nav was found in `dsh-client-ui-settings-general` and the
  failure wording in `dsh-client-ui-settings-models`.
- **A feature may need something neither app ships, and the reader must not be sent into a config
  file.** cloudflared is the case that bit: tunnel mode spawns it, the shell bundles one beside its node,
  the official desktop app bundles nothing, and it is usually not on PATH either. So `findCloudflared`
  searches the setting, the running runtime's directory, `<dsh home>/../tunnel/`, every `PATH` entry and
  the common Windows install locations, the panel names where it looked and takes a path, and the route
  refuses a path with no file behind it. Keep the candidate list injectable (`cloudflaredCandidates`)
  so the search is tested without a binary on the machine.
- **A package's own routes must not collide with the remote proxy's project routes.** The proxy
  forwards a request to dsh unless it claims it, so anything under the proxy's project prefixes is
  invisible to the page. That is why the project browser lives under
  `/dsh-remote/project/api/*` while this plugin's own API is `/dsh-remote/api/*`.
- **The hub contract is two DOM-level facts, and both directions must stay optional** — no package
  may assume the other exists.
  - A feature publishes itself to `window.__dshFeatures[key] = { title, icon?, order, mount(host) }`
    (`icon` is a 16×16 stroke SVG path for the nav row) and
    declares `dsh.ui.feature` in its package.json (`key`, `order`, bilingual `title`/`summary`). The
    key and the order must match in both places; `tests/hub-contract.test.mjs` fails if they drift.
  - `mount(host)` is called again on every visit and the hub drops the DOM when you leave the page, so
    it must rebuild from scratch (see `mountInline` in any feature's `client.js`).
  - The hub page is a **list of rows plus a drill-down**, modelled on dsh's own Plugins page: one row per
    feature (glyph, name, summary, chevron), clicking one opens it and puts a back control in the
    head. It is deliberately *not* a left-hand nav rail — that reads as a second level of dsh's own
    sidebar. The reader's drag order lives in `localStorage["dsh-features:nav-order"]` (an array of
    keys; new features append by their default order). Reordering must not remount the open panel:
    the mount effect depends on the merged snapshot, and the open feature is looked up by key.
  - The page head owns the **only** refresh control (rescan + remount re-fetches the panel's data).
    A panel that has one of its own hides it while embedded — `inHub ? undefined : …` — and marks it
    `data-dsh-refresh` so the hub can drop it either way. The hub additionally sweeps the mount point
    (`stripDuplicateRefresh`: the marker, or a bare refresh label, localized or not) on every mutation,
    because a
    panel copy predating this rule must not be able to put two refresh buttons on the page. Keep the
    standalone floating panel's button: without the hub it is the only refresh.
  - Nothing a panel or the hub shows may contain an em dash — `tests/hub-contract.test.mjs` fails on
    one in any non-comment line. Comment prose is exempt.
  - The six `client.css` files share **one byte-identical block** (everything up to the toast rule;
    only per-package tails differ) whose metrics mirror the official plugin page and settings form —
    the tokens were extracted from `dsh-client-ui-plugin-manager` and `dsh-client-ui-primitives`
    (14px/500 row titles, 13px/18px tertiary subtitles, hairline `0.5px` outlines, 32px buttons,
    the 36×20 switch, brand-token accent). Row text never breaks mid-word (`overflow-wrap: anywhere`
    is banned): subtitles clamp to two lines and keep the full string on the row's `title` tooltip.
    A list row is **one card per entry** — the same hairline stroke, `12px` radius, `12px 14px` padding
    and 8px rhythm the hub draws for its own rows — and `.row .row-sub` holds a two-line slot, so every
    entry in a list is one height whatever each description's length.
    `tests/hub-contract.test.mjs` pins the card's metrics and the hub's, so the two cannot drift apart.
    A read-only value that sits inside a row of controls is a **badge in the same box as those controls**
    (`dsh-zoom`'s `.level`: 32px, hairline stroke, tinted fill, tabular digits) — bare text beside a
    button reads as a stray number, which is what 106% looked like next to 重置为 100%. The badge keeps
    the filled half of the control language so it cannot be mistaken for a button that does nothing.
  - `tests/panel-embed.test.mjs` boots every panel's script in a DOM stub for both directions (hub
    present and absent). Its stubs are load-bearing: panels append with `child instanceof Node`, read
    `panel.hidden`/`element.id` as *properties* (the `hidden` and `id` attributes are reflected), and
    the hub sweeps through `querySelectorAll` + `MutationObserver`. Feeding them a thin `{ ok: true }`
    payload makes the render throw, and then every "no refresh button here" assertion passes
    vacuously — so each package declares its real payload shape (see `PAYLOADS` there).
  - `tests/mobile-layer.test.mjs` does the same for `dsh-remote`'s browser half, which only ever runs on
    a phone: a settings sheet from a remote origin, where upstream's provider catalog fails. A DOM stub
    is never the real thing — it has to answer `textContent` by aggregation, expose `parentElement` as
    well as `parent`, and match `[data-x]` presence selectors, or the layer's own guards silently pass
    and the test asserts nothing. Both of those bit while writing it.
  - A feature probes `GET /dsh-features/api/status` at boot and **skips its floating panel when the
    hub answers**. Without the hub (bare dsh, or the package uninstalled) the launcher must still be
    built exactly as before — that path is what the panels were originally written for.
  - The hub hides `#dsh-launchers` from its own stylesheet. Do not "fix" a feature by re-showing it.
  - **Every hub page class is prefixed `hub-`, and no panel may use that prefix.** A feature is mounted
    *inside* `#dsh-features-root`, so the scope id on the hub's rules does not keep them out of the
    mounted panel: a hub `#dsh-features-root .row` matched a panel's `.row` and handed it the hub's card
    border, `padding: 12px 14px` and `user-select: none` (the panel's own `.row` overrode only the
    padding, so the border stayed and the sub-page looked boxed and misaligned). Same for `head`,
    `row-name` and `note`, and for a bare element selector such as `#dsh-features-root h1` or
    `#dsh-features-root *`. `tests/hub-contract.test.mjs` now reads every selector in the hub's
    stylesheet and fails on one that is neither an exemption (`#dsh-launchers`, the root itself) nor
    carries a `hub-` class. Corollary for both sides: a row sits on the same gutter as its page's own
    buttons — no negative horizontal margin, which is what pushed panel rows 8px outside the hub's head
    controls — and since a row is a card, its stroke is what the eye lines up against the head's back and
    refresh controls. Card geometry lives in the shared block, so all six panels move together.
- **The hub's client half is served from the row, not from a route.** `dsh.client` + `exports["./client"]`
  is the whole wiring; the bundle URL, its revision and the boot-graph row are dsh's business. If the
  entry does not appear, check `node --dump-config | grep features` (the row must be mounted) before
  touching the bundle.
- **Command registration is guarded** (a name clash degrades to a warning). Do not "fix" that by
  registering unguarded: an exception during `apply` kills dsh.
- **`readdir({ withFileTypes: true })` reports lstat, so a symlinked directory is not
  `isDirectory()`.** Skill farms are usually one shared checkout linked into every agent tool, so any
  directory scan must accept `isSymbolicLink()` too and follow it with `stat` before deciding. Getting
  this wrong reports an empty source instead of an error; `cp` must pass `dereference: true` so the
  managed root ends up with real files, not links into a foreign farm. This is what made the Import
  skills dialog report that it found no skills while `~/.codex/skills` held ten skills.
- Never log a remote link or token; `/dsh-remote/api/status` exists precisely so there is a
  credential-free status.

## Test

Offline suites need `@deepseek-ai/*` (and `yaml` for dsh-mcp) to resolve. Either run them from an
installed copy, or create junctions in the package's `node_modules` pointing at the runtime's
packages. Then:

```bash
cd <name> && node tests/<name>.test.mjs
```

`dsh-features` needs no runtime at all: its suite evaluates the browser bundle in a `vm` with a
minimal React (state/effect/ref), so the sidebar slot, its order, the skin and the `mount` hand-off are
asserted without a browser. The cross-package agreement cannot live in a package suite (an installed
copy has no siblings), so it is checked from the repository root:

```bash
node tests/hub-contract.test.mjs
```

Verification is per package and the totals are in the root README. Two things are worth re-checking
after any change: all six installed **together** still boot (`--dump-config` then `web --port N
--no-open`, and look for the ready line), and dsh-remote's live suite
(`node tests/remote-live.mjs <baseUrl> <proxyPort> <token>` against a sandbox with remote access on).

## Look at the UI, do not infer it

`tools/visual/shot.mjs` screenshots the real dsh web UI (headless Edge over CDP) at any combination of
viewport size, `zoom` and host attribute, next to a geometry report — see `tools/visual/README.md`.
Use it for anything a stylesheet can get wrong; a computed style that looks right on a panel that
renders wrong is the normal failure here, and it is invisible in the suites.

```bash
RT=/f/DSHDesktop/runtime/windows-x64
"$RT/node.exe" "$RT/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" web --port 7411 --no-open   # token on stdout
"$RT/node.exe" tools/visual/shot.mjs --url "http://127.0.0.1:7411/?token=<t>" --sizes 1400x900 --zooms 1,2
```

It never touches a running app: the sandbox instance above answers with dsh's own chrome, which is what
most of these bugs are about. `--eval` injects the state you need to reproduce (extra footer rows, a
dialog, a collapsed sidebar), `--css` previews a fix before it is written, `--tree` prints the sidebar's
subtree with layout heights.

For a panel there is nothing to install either: `--panel dsh-skills` (any package in this repo) renders it
*inside a copy of the hub page* — the hub's own stylesheet, its head with back / title / package chip /
refresh, and a `hub-stage[data-view="feature"]` for the panel to mount into — with its routes answered
from `tools/visual/fixtures/<pkg>.json` and `--theme dark|light`. That is how to see a list's look, its
gutter against the head's controls, and whether every row is the same height, before touching an install.

The phone is not a separate app — the proxy rewrites dsh's own page — so it is reproduced by shooting the
sandbox at a phone viewport with that layer injected:

```bash
node tools/visual/shot.mjs --url "$URL" --sizes 390x844 --css dsh-remote/lib/assets/mobile.css      --script dsh-remote/lib/assets/mobile.js --theme dark      --eval "document.querySelector('[aria-label=\"设置\"]').click()"      --ask "(() => { const nav = document.querySelector('[class*=\"_navList\"]'); return nav.getBoundingClientRect().toJSON(); })()"
```

Better still, shoot the real thing: the running instance's proxy answers on its port with
`?token=<token>` (read the token out of the plugin's settings file, never print it), and the deployed layer is
already in the page — so a screenshot with no `--css`/`--script` is exactly what the phone shows. To see what
a *phone origin* does, add the fake host (see the `--browser-arg` note above).

`--ask` runs after `--eval`/`--click` and prints JSON, which is how a rule gets written against the real DOM
instead of a guess; a browser or computer MCP driver works the same way when interactive poking is genuinely
cheaper, but this scripted loop is repeatable and leaves the numbers behind. Panels and sheets open from
`aria-label` labels (设置, 插件, 功能管理) — at a phone viewport the trigger is a 36px icon with no text, so a
text click finds nothing. What this loop cannot show is iOS's own viewport behaviour (the toolbar collapsing
moves the visual viewport): say so instead of claiming a phone-side fix is verified.

Two numbers decide most zoom work, and both are easy to misread: `getBoundingClientRect` reports
**viewport** px while `scrollHeight`/`clientHeight` report **layout** px (at zoom 2 a 50 px row reports
100), and dsh **auto-collapses the sidebar to a rail below 1024 px of viewport width** — measure the
expanded sidebar at ≥ 1400 px wide or the answer is about a different sidebar.

## Not here

`dsh-desktop-kit` in the DSHPlugin repository is the original single-package version; this repository
is the per-feature split. Language/theme following, page-error reporting and the `/init` fallback
were dropped in the split — see the root README for why.
