# dsh-plugin: notes for agents

Independent dsh plugins, one feature per package. Most of what follows is a trap someone already
walked into, so read it before changing anything here.

This is the only working tree: `H:\My_Software\DSHPlugin` (git remote `LBurny/dsh-plugin`). Its own
READMEs and the authoring skill still write that path as `dsh-plugin`, which does not exist, so a
`dsh-plugin/...` path in any doc means this directory.

## Commands (there is no build, lint or typecheck step)

Every package is hand-written JavaScript, so nothing is compiled or bundled, there is no `scripts`
entry in any `package.json`, and the only checks are plain Node suites run with Node 22+. What each
suite asserts, and the `@deepseek-ai/*` resolution the offline ones need, is in **Test** below.

```bash
# the whole set installed together in a throwaway dsh home at .sandbox/ (gitignored)
node tools/sandbox/sandbox.mjs up            # first run: create the home, install all 8, boot, print the URL
node tools/sandbox/sandbox.mjs up --restart  # after an edit: reload the running instance (the usual loop)
node tools/sandbox/sandbox.mjs url           # print the running URL;  `down` stops it
# port defaults to 25499 and moves up if busy; it binds loopback only

node tests/hub-contract.test.mjs             # from the repository root: cross-package agreement
node tests/manifest.test.mjs                 #   directory name == package name; every import declared
node tests/host-half.test.mjs                #   every host half mounts; routes, assets, command legal
node tests/panel-embed.test.mjs              #   every panel boots with and without the hub
node tests/mobile-layer.test.mjs             #   the phone layer's DOM behaviour

cd <pkg> && node tests/*.test.mjs            # one package's sibling suite (named by role: hub, proxy, ...)
cd dsh-remote && node tests/cloudflared.test.mjs && node tests/proxy.test.mjs   # this package has two

"$NODE" .agents/skills/dsh-plugin-authoring/assets/plugin-selftest.mjs <plugin dir>   # exit 0/1
```

Set `NODE=/f/DSHDesktop/runtime/windows-x64/node.exe` for that last one. `node tools/visual/shot.mjs`
screenshots the real UI instead of inferring it, and `node tools/hotreload/hotreload.mjs up` mirrors
this tree into the installed app; each tool has its own `tools/*/README.md`, and those three READMEs
are worth reading before touching a stylesheet, a browser half, or the app.

## Environment (the official app is the target; measured, not assumed)

Everything below was verified against the **official DeepSeek Harness desktop app**,
`F:\Code\dsh\DeepSeek Harness.exe` (Electron). It packs its own dsh inside `resources/app.asar` at
`0.2.0-rc.2` and ships the CLI shim `F:\Code\dsh\resources\runtime\cli\bin\dsh.cmd`.

- `DSH_HOME` = `C:\Users\intel\.dsh`, profile `desktop` (a `web` profile sits beside it). The app owns
  that profile: `--dump-config` and a plain boot are refused with `profile "desktop" is managed
  exclusively by the Electron application`, while `plugin` subcommands are allowed (they tell you to
  quit the app first). Scripting goes through the shim; a human goes through the Plugins page.
- Installing is the app's **Plugins page, Add plugin**: a package name, a git URL or a local directory,
  e.g. `github:LBurny/dsh-plugin#path:/dsh-notify`. No `profiles/node_modules` link farm is needed here:
  the CLI resolves `@deepseek-ai/*` out of the app's own runtime.
- A fresh dsh home (and the sandbox on its first run) shows the app's own preview notice on the first
  page load; dismiss it before typing `/`.
- **Three dsh copies live on this machine.** The app's, above. The DSHDesktop shell at `F:\DSHDesktop`
  (packed dsh `0.2.0-rc.1`, home `%LOCALAPPDATA%\DSHDesktop\dsh-home`, profile `web`, port 25474). And an
  old global CLI on `PATH` (`F:\Code\pnpm\node_modules\@deepseek-ai\dsh`, plus one under `%APPDATA%\npm`)
  at `0.1.5-rc.2`, whose default home is `~/.dsh`, which is the app's: always pass `DSH_HOME` explicitly
  when that binary is what runs.
- The app's home resolves plugin dependencies out of somebody else's tree. The links under
  `~/.dsh/profiles/node_modules` point into `H:\My_Software\DSHDesktop\src-tauri\runtime\windows-x64\dsh\node_modules`
  (the shell's dev tree) and none at the app itself, so that tree is load-bearing: delete or rebuild it
  and the app's plugins fail with `Cannot find package`; edit the runtime in it and the app changes with
  it. Remember this whenever a change seems to have no effect.
- DSHDesktop is the **secondary** target and nothing here depends on it: its conveniences are its own
  Svelte pages, and it preinstalls `dsh-command-init` (whose row id `init` collides with `dsh-init`'s).

Junk goes to `.trash/` (gitignored): "deletable but not yet" moves there instead of being removed. MSYS
`rm` on a read-only or busy file reports Permission denied, so clear ReadOnly and use PowerShell
`Remove-Item -Recurse -Force`.

## Shape

One directory per feature at the repository root, each a complete, standalone plugin you can install on
its own (`dsh plugin add <that dir>`). Nothing may import a sibling package. Shared helpers are
duplicated on purpose.

```
<name>/
  package.json       dsh.bundle.patch + main: lib/index.js + files: lib/**
  cordis.patch.yml   the `- insert:` row that mounts the package
  README.md  LICENSE
  lib/               host half, flat, one responsibility per file, named by role
    index.js         the plugin body (name/inject/apply) + routes + index injection
    <role>.js        http.js, layout.js, the feature's own modules
    client.js        browser half (plain DOM, no build step), served by this package's routes
    client.css       its stylesheet
    sounds/ assets/  asset clusters that ship as a set
  tests/             sibling suite, one per package, named by role: hub, proxy, doctor, ...
  locale/            bilingual name/description for dsh's plugin management page
```

This is the official dsh package shape: `lib/` is flat and modules are named by role, `tests/` is a
sibling and never co-located, and the runtime itself keeps only build output (`lib/types/`), asset
clusters and a worker entrypoint as directories under `lib/`. Our packages are hand-written JavaScript
with no build step, so `lib/` is both source and published artifact and `main` points straight at
`lib/index.js`.

- The npm package name, the module's exported `name` and the patch row `id` are not the same string:
  `dsh-skills` is the package, `skills` is the other two. Row ids are first-come, first-served across
  the whole plugin tree.
- `dsh-features/` is the hub (the Features page) and the only package with a browser *client* half
  (`dsh.client` + `exports["./client"]` to `lib/client.js`, a `__ModuleLoader__.load({id, factory})`
  classic script, not a module). Only a dsh client plugin can add a real sidebar entry, which is why the
  hub cannot be an injected script like the rest.
- `dsh-init/` is the only pure command package: no browser half, no panel, no `dsh.ui.feature` marker,
  so the hub does not list it (supported, not accidental: `dsh-features/lib/inventory.js` skips any
  package without the marker). Two things there are load-bearing. Its row id is `init`, which
  DSHDesktop's preseeded `dsh-command-init` also claims, so registration is guarded to leave a warning
  instead of a stack. And its message source is `plugin:dsh-init`, because session format V4 refuses the
  retired generic `kind:"plugin"` wrapper; a refused write fails the whole turn, the nastiest shape a bug
  takes here, where the command registers, answers the palette, and does nothing.
  `tests/init.test.mjs` runs the runtime's own V4 admission as the probe.

## Rules that are easy to get wrong

**Installing and activating**

- `package.json` must declare `dsh.bundle.patch`. Without it `dsh plugin add` installs the package as a
  plain dependency and mounts no layer, and the symptom is silence, not an error. `--dump-config` is how
  you catch it.
- A broken row never stops dsh from booting, which is worse for an author than a crash: it costs that one
  row and says almost nothing. An import failure, a throw while the module evaluates, a throw from
  `apply`, and an unresolvable entry in `dsh.profile.bundles` each print one
  `warning: N entries did not activate` and the boot carries on (measured on dsh 0.2.0-rc.1 and rc.2).
  The only fatal ids are the seven in `dsh-app-boot`'s `requiredStartupEntryIds`
  (`agent-loop webserver modules connection headless-runner acp sdk-jsonrpc-server`), so never take one
  of those as a row id. Command names are first-come, first-served, and a clash degrades to a warning, so
  registration is guarded: an exception from `apply` would take the tree down.
- Verify in a sandbox before touching a real `DSH_HOME`, then mirror the change into the installed app
  (the rule at the end of **Test**). Editing this tree alone is not enough: the app installs a published
  copy of the package and cannot see it.

**The browser halves**

- Panels follow dsh's theme through its own tokens: `--dsw-alias-bg-base`, `-label-primary`,
  `-label-caption`, `-border-l2`, `-interactive-bg-hover`, defined on `body` (light) and
  `body[data-ds-dark-theme]` (dark) by `@deepseek-ai/dsh-client-ui-theme`. Write
  `var(--dsw-..., <hardcoded fallback>)`, keep the fallback, and keep the `prefers-color-scheme` block
  beside it so a shell without those tokens still looks right. Language comes from `navigator.language`,
  deliberately not dsh's `locale`.
- The browser halves share exactly three DOM-level things: the `#dsh-launchers` corner container, the
  `--dsh-launcher-stack` custom property, and the `.dsh-launch` button class whose styles are duplicated
  identically in every `client.css`. Panel styles are scoped under `#<package>-root`. Keep all three when
  adding a package.
- `[class*="_nav"]` also matches `_navList`. CSS-modules substrings are not names: a rule written for the
  settings nav bar silently padded the tab *list*. Scope bar rules with `:has(> [class*="_nav"])` or a
  `>` step, and when a measurement refuses to match the CSS you wrote, suspect your own selector first.
  The same trap exists for `_headerActions`.
- `vh` units are device pixels under a CSS `zoom` (dsh-zoom can put `zoom: 1.06` on the page), so a
  centred full-screen sheet overflows top and bottom. Size full-screen layers from their container
  (`100%` of an `inset: 0` overlay), never in `vh`/`vw`. This is also why a headless phone run must pass
  the same `--zooms` the plugin applies.
- `zoom` on `<html>` is capped by dsh's own chrome, and the cap is measured, not assumed. The factor
  divides the layout viewport, and past `window height / sidebar requirement` the sidebar stack no longer
  fits: the shell clips it and the document never scrolls, putting 设置 / 意见反馈 / 退出登录 and the
  avatar menu out of reach. No constant expresses it (plugins add nav rows, a signed-in profile adds
  footer rows, the rail needs a different height from the expanded sidebar), so `dsh-zoom/lib/client.js`
  samples it: forcing an oversized zoom makes the sidebar column's `scrollHeight` report what the stack
  needs in layout px. Restore the sampling zoom in the same task, and re-measure on resize and when the
  sidebar mounts (the cap is read before it exists).
- Anything the reader arranges belongs on the host, not in browser storage. The hub's feature order lived
  in `localStorage`, which is per-origin, so a drag on the desktop never reached the phone (the shell
  opens dsh at `127.0.0.1:<port>`, the phone reaches it through the proxy at the tunnel's origin). It is
  written to `<DSH_HOME>/dsh-features.json` behind `POST /dsh-features/api/order` with `localStorage` kept
  only as the first-frame cache. dsh's own client store has the same trap.

**The hub contract** (three DOM-level facts, and each side works without the other: no package may
assume it exists)

- A feature publishes `window.__dshFeatures[key] = { title, icon?, order, mount(host) }` (`icon` is a
  16×16 stroke SVG path for the nav row) and declares `dsh.ui.feature` in its package.json (`key`,
  `order`, bilingual `title`/`summary`). The key and the order must match in both places, and
  `tests/hub-contract.test.mjs` fails if they drift.
- `mount(host)` is called again on every visit and the hub drops the DOM when you leave the page, so it
  must rebuild from scratch (see `mountInline`).
- The hub's stage (`.hub-stage`) carries `contain: layout`, which makes it the containing block for a
  mounted panel's `position: fixed` overlay. That is what puts a panel's toast over the panel's own
  column: `left: 50%` of the window is half a sidebar off, and in a floating panel the same rule
  resolves against the viewport, which is what standalone mode wants. Move to a real `transform` or drop
  the containment and every banner in the hub shifts sideways; `tests/hub-contract.test.mjs` pins it.
- The hub page is a list of rows plus a drill-down, modelled on dsh's own Plugins page, deliberately not
  a left-hand nav rail (that reads as a second level of dsh's own sidebar).
- The page head owns the only refresh control. A panel hides its own while embedded (`inHub ? undefined :
  ...`) and marks it `data-dsh-refresh`; the hub also sweeps the mount point for a stray refresh,
  because a panel copy that predates the rule must not be able to show two. Keep the standalone floating
  panel's button: without the hub it is the only refresh.
- That refresh does two things: it rescans the inventory and asks every install source whether it has moved
  (`GET /dsh-features/api/updates`). Applying is a second, explicit click (`POST /dsh-features/api/update`,
  which names the packages and runs `pnpm update` through the live `pluginManager`), because plugins have no
  HMR and the honest answer is always "restart dsh". The check covers the hub's own package as well (it is
  not a feature, so it has no row; the page names it instead of letting the count exceed the pills), since
  the Plugins page cannot update it. Re-installing the *same* spec updates nothing: pnpm
  prints "Lockfile is up to date, resolution step is skipped", and only `pnpm update <name>` re-resolves a
  git spec, `#path:/<sub>` included (measured 2026-10-11, pnpm 11.7 in the app runtime and 12.3 standalone).
- Every package ships `locale/en.json` + `locale/zh.json` with `meta.title` / `meta.description`, an
  `exports` entry for `./locale/*.json`, and `locale` in `files`. That is what makes the Plugins page name it
  in the reader's language instead of showing the package name, and `tests/hub-contract.test.mjs` fails a
  package missing any of the four (git installs are trimmed by `files`).
- Nothing a panel or the hub shows may contain an em dash. `tests/hub-contract.test.mjs` fails on one in
  any non-comment line; comment prose is exempt. That same test pins the row and card metrics and the one
  shared stylesheet block (byte-identical across the panels except for the per-package tails), so read it
  before changing a row's look and expect to move the test with the row. A read-only value inside a row of
  controls is a badge in the same box as those controls (dsh-zoom's `.level`), never bare text beside a
  button.
- Every hub page class is prefixed `hub-`, and no panel may use that prefix: a feature is mounted inside
  `#dsh-features-root`, so the hub's scope id does not keep its rules out of the panel. The contract test
  reads every selector in the hub's stylesheet and fails on one that neither carries a `hub-` class nor is
  an exemption (`#dsh-launchers`, the root itself). A row sits on the same gutter as its page's own
  buttons, with no negative horizontal margin.
- A feature probes `GET /dsh-features/api/status` at boot and skips its floating panel when the hub
  answers. Without the hub (bare dsh, or the package uninstalled) the launcher must be built exactly as
  before. The hub hides `#dsh-launchers` from its own stylesheet; do not "fix" a feature by re-showing it.
- The hub's client half is served from the row, not from a route: `dsh.client` + `exports["./client"]` is
  the whole wiring. If the entry does not appear, check `node --dump-config | grep features`.

**The phone (dsh-remote)**

- A feature may need something neither app ships, and the reader must not be sent into a config file.
  cloudflared is the case: tunnel mode spawns it, the shell bundles one beside its node, the official
  desktop app bundles nothing, and it is usually not on PATH. `findCloudflared` searches the setting, the
  running runtime's directory, `<dsh home>/../tunnel/`, every `PATH` entry and the common Windows install
  locations, and when that finds nothing `lib/cloudflared.js` installs one itself, on plugin load, to
  `<dsh home>/../tunnel/`. Keep the candidate list injectable (`cloudflaredCandidates`) so the search is
  tested without a binary on the machine, and keep the installer's probes injectable (`run`,
  `exists`, `fetchManifest`, `verifySignature`) for the same reason.
- Where that download comes from is measured, not assumed: the version and the sha256 are read from
  Cloudflare's own update endpoint `https://update.argotunnel.com/?os=<windows|darwin|linux>&arch=<amd64|arm64>`
  (the manifest cloudflared's built-in updater uses: Cloudflare-hosted, reachable from a line where
  `github.com` is DNS-poisoned, and not behind the GitHub API rate limit), while the bytes come from the
  `github.com` URL it returns, fetched with `curl` so the `cloudflaredProxy` setting or `HTTPS_PROXY` can
  carry them (measured: 55,365,048 bytes in 11 s through a local proxy, digest identical to the manifest's,
  versus 162 s and a truncated file from a community mirror). Nothing is installed until the digest matches
  and, on Windows, until the Authenticode signature is Cloudflare's, `powershell Get-AuthenticodeSignature`
  being the check that does not depend on a hash arriving from the same network as the bytes.
- **On a `compressed` platform the digest is the unpacked executable's, not the archive's**, and that
  ordering is not a detail: `darwin` ships a `.tgz`, and measured on the real release the archive hashes to
  `903845b8…` while the 42,328,240-byte Mach-O inside it hashes to `0560c9ab…`, which is the manifest's
  checksum. So unpack first (a hand-written 512-byte tar reader plus `zlib.gunzipSync`, no dependency), then
  hash the file that will be installed. Hashing the download instead fails every macOS install with
  "checksum"; installing the archive instead leaves a tarball named `cloudflared` that the manifest's own
  digest accepts, which the search then calls ready forever and `spawn` can never run. A unit test built on
  a self-made tarball passed with the wrong order, so check this class against real Cloudflare bytes
  (`curl --proxy` the release, then compare both digests) rather than against a fixture.
- The tunnel's own lifecycle is where a mistake is an uncaught exception or a slow leak, not a wrong
  pixel, and all three of these were real. `spawn` emits `error` and never `exit` when it cannot start the
  binary, and an `error` with no listener is an uncaught exception **inside the harness process**: the
  search rules out a missing file, not one that exists and cannot be executed. The detached log is opened
  with `openSync` and its descriptor belongs to the parent, so it has to be `closeSync`d right after the
  spawn or every start and every retry leaks one. And the log poll and the URL deadline have to be dropped
  by `stop()` itself: the "leave the tunnel alive" path deliberately leaves the child running, so no `exit`
  event ever arrives to clear them, and an orphaned poll keeps reading the log twice a second and reports a
  URL into a handle that already stopped.
- The installer runs at plugin load, so tunnel mode can be switched on while the download is still in
  flight and be told the binary is missing seconds before it lands. That is why the manager's tunnel step
  is its own idempotent `startTunnel()` (a proxy that is not running, another mode and an existing tunnel
  all return the snapshot untouched) and why provisioning ends by calling it: the channel comes up by
  itself instead of waiting to be toggled. The binary probe (`findBinary`) is injectable for the same
  reason `cloudflaredCandidates` is: it reads the real environment, so a test on a machine that already has
  cloudflared would otherwise spawn it.
- A phone link must survive a restart, so the tunnel outlives dsh. A Cloudflare quick tunnel picks a
  random hostname per process, so cloudflared is spawned **detached** with its output in
  `<DSH_HOME>/dsh-remote-tunnel.log` (a pipe breaks the moment dsh exits, and cloudflared dying on a write
  error is exactly the churn this avoids), with `{tunnelUrl, tunnelPid, cloudflaredExe, target}` recorded
  in `<DSH_HOME>/dsh-remote-session.json`. The next start **adopts** that tunnel when the record agrees
  with this run and the tunnel still answers for the current token; one probe covers both a dead process
  and a tunnel whose target port is gone, which is stronger than trusting a pid (recyclable), and is why
  adoption is allowed to fail (a link answering 502 is worse than a new one). `disable()` is the only path
  that kills the tunnel and forgets the session; unload only stops supervising. Ports stay remembered for
  the same reason.
- The tailnet channel is a bind, and the address it binds is the whole design. `tailnet` mode
  (`lib/tailnet.js`) reads this machine's Tailscale address out of `100.64.0.0/10` off the network
  interfaces and binds **only** that address, so the link is stable across restarts and nothing is public.
  `lanUrls()` therefore returns nothing unless the mode is `lan`: `lan` binds every interface, `tailnet`
  binds one address and `tunnel` binds loopback, and a LAN link in either of the last two points at a port
  that answers nothing. The MagicDNS name comes from `tailscale status --json` and is optional, so a
  missing CLI costs the name and never the channel (`BackendState` is the only way to see a Windows
  machine whose Tailscale was fully exited). `enable` refuses to fall back to every interface when there
  is no address: a reader who chose a private channel did not choose to serve the LAN. Community plugins
  use `tailscale serve` instead, which forces them to register a trusted host (dsh's browser fence rejects
  the `<machine>.<tailnet>.ts.net` authority, so "the page opens but every request 403s") and to enable
  HTTPS certificates; this proxy re-originates under loopback, so the tailnet name never reaches the fence
  and neither is needed.
- A package's own routes must not collide with the remote proxy's project routes. The proxy forwards a
  request to dsh unless it claims it, so anything under the proxy's project prefixes is invisible to the
  page. That is why the project browser lives under `/dsh-remote/project/api/*` while the plugin's own API
  is `/dsh-remote/api/*`.
- Never log a remote link or token. `/dsh-remote/api/status` exists precisely so there is a
  credential-free status.
- The phone gets a rewritten page, so its fixes live in the proxy's layer, never in dsh. Three rules are
  there because upstream will not change: the preview notice is re-shown on every remote load (upstream
  keeps its acknowledgement in a memory-mode settings scope for remote transports, so `mobile.js` clicks
  its Continue control and hides its portal); the settings sheet's tab strip is left-packed and clips its
  last tab at 390px (four tabs measure 401px of content in a 390px screen, so the strip centres and wraps
  rather than scrolling, and pads top and bottom equally, since 10px top / 0 bottom reads as "the tabs are
  not centred"); and the models page cannot read settings from a remote origin at all, so the layer hides
  that failure card, Retry included, and puts a line in its place pointing at the desktop window.
  `mobile.js` is injected before `</head>`, which is how it catches a modal before the first paint.
- Never insert a node into React's subtree from the mobile layer. The models note was first a `<p>` after
  the failed card, and React does not remove foreign nodes, so every settings section showed the same
  sentence and a reader reports it as "I cannot switch sections any more". The layer now only sets an
  **attribute** on the card (the localised sentence) and `mobile.css` renders it with `content: attr(...)`
  while hiding the card's own children. Attributes are not React's business, and a section switch replaces
  the node, so the mark leaves with it, plus a retraction path for when React reuses the node.
- Reproduce the phone's origin instead of guessing what a phone does. **The proxy always rewrites `Host`
  to the loopback authority**, so the server cannot tell the two apart: dsh decides the settings scope from
  the client's own `location.hostname`. A loopback run shows a working models page and a phone-origin run
  shows `加载提供商目录失败: settings are unavailable in this browser`, which is exactly what a remote
  transport gets. **Never make a remote page look like loopback to fix that**: the same scope is what stops
  a link-holder from rewriting host settings and API keys. Explain it in the layer; nothing else.

**Diagnostics and the runtime**

- A plugin can read the harness's own logs in-process, and that is the only way on the official app.
  `ctx.logger` is cordis's logger service: `ctx.logger.exporter({ levels: { default: 3 }, export })`
  registers a sink that receives every record from every module, and `ctx.logger.buffer` holds the
  service's own last 1000 records. Two limits matter before designing around it: the loader logs each
  row's `apply`/`unload` and its import/config errors through the logger (name `loader`), but the
  `N entries did not activate`, `startup failed` and `skipping profile bundle` lines are
  `process.stderr.write` calls and a thrown `StartupError` inside `dsh-app-boot`, so no exporter sees
  them; and the official app writes no log file at all, only `~/.dsh/logs/startup-*.log` when a required
  row fails, plus a crash report under `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`. `dsh-doctor` is built
  on this.
- "Did my row load?" is answerable in-process: `ctx.get("loader").entries()` yields every row with its
  `id`, `options` (the module `name`), `disabled` and `fiber.state`, the numeric `FiberState`
  (`0 pending, 1 loading, 2 active, 3 failed, 4 disposed, 5 unloading`). A disabled row has no fiber, so
  its state cannot be read the same way. This is the half the ready line cannot give.
- The official app's own dsh is inside `app.asar`. When a fix must target the build the phone actually
  runs (hashes and local-name prefixes differ per build), read it without Electron:
  `node tools/visual/asar.mjs <app.asar> --list|--cat|--grep <text>`. `--grep` names the packed file that
  carries a string, which is how the settings nav and the failure wording were found.
- `readdir({ withFileTypes: true })` reports lstat, so a symlinked directory is not `isDirectory()`. Skill
  farms are usually one shared checkout linked into every agent tool, so any directory scan must accept
  `isSymbolicLink()` too and follow it with `stat`, and `cp` must pass `dereference: true`. Getting this
  wrong reports an empty source instead of an error.

## Test

The whole set runs together in the reusable sandbox from **Commands**: a real dsh home at `.sandbox/`
(gitignored) with all eight packages installed as `link:` installs. Two guards are built in, both earned:
it forces `DSH_HOME` on every command it runs (without it, `dsh plugin add` writes into the user's real
`~/.dsh` silently and creates a profile there), and after installing it re-reads the profile manifest and
fails unless the packages are in both `dependencies` and `dsh.profile.bundles`. It refuses a home outside
this repository unless `--allow-foreign-home` is passed; never point it at `~/.dsh`.

The **installed app** has its own loop: `node tools/hotreload/hotreload.mjs up` mirrors this working tree
into `<home>/profiles/<profile>/node_modules/dsh-*` (the app installs a published commit, so editing here
changes nothing it can see), writes an `hmr` module-root block into that profile's patch and watches. A
`lib/client.js` edit to a **client plugin** (the hub) is then live by itself: `dsh-client-hmr`, mounted by
`dsh-web-app`, stats each client-module-graph row's bundle every 500ms and pushes a `rebuilt` frame the
browser applies in place, so only the page that was open is dropped. A **feature panel** is not in that
graph at all: its `client.js`/`client.css` are injected into the document as a plain `<script>`/`<link>`
by the host half, so the browser keeps them until the document is loaded again, and editing one produces
no frame (measured on the app: 2 frames for an edit of `dsh-features/lib/client.js` and its revert, none
for `dsh-mcp`, which never appears in the graph). A panel change therefore needs `restart` (or the reader
reloading the app) to be seen, and the tool will not restart for it. A **host half** cannot hot reload in
the app: `dsh-hmr` refuses to construct without
`--expose-internals` in `process.execArgv`, and even with it (the tool's `restart` passes it) a module write
reloads nothing there, so the tool restarts the app (about four seconds, debounced) on `lib/*.js` edits.
`status` reports drift, `sync` mirrors once, `down` stops watching and lifts the block out again. The same
block hot reloads a **CLI-launched** dsh (the sandbox), where the module watch does work; measurements and
the exact commands are in `tools/hotreload/README.md`.

**Run the mirror as the last step of every edit, without being asked.** The user reads the installed app,
not this working tree, so a change that is only here has not happened for them: `node
tools/hotreload/hotreload.mjs sync`, then `status` to see every package read `in sync`. `sync` needs no
watcher and restarts nothing. A client-half edit then goes live in the running app by itself; a host-half
edit is mirrored but not reloaded, so pair `sync` with `restart` when it has to be seen immediately. The
sandbox in the section above is for *verifying* a change, never a substitute for shipping it to the app.

Offline suites need `@deepseek-ai/*` (and `yaml` for dsh-mcp) to resolve. Run them from an installed copy,
or make the packages resolvable in the package's `node_modules`: they are published on npm under the
`next` tag at the version the official app ships (0.2.0-rc.2), so
`npm i --no-save @deepseek-ai/dsh-atomic-write@next @deepseek-ai/dsh-llm@next
@deepseek-ai/dsh-session-format-v3-to-v4@next` is enough, and junctions into a runtime also work.

`dsh-features` needs no runtime: its suite evaluates the browser bundle in a `vm` with a minimal React
(state/effect/ref), so the sidebar slot, its order, the skin and the `mount` hand-off are asserted without
a browser. `dsh-init` needs `@deepseek-ai/dsh-llm` for the module itself and
`@deepseek-ai/dsh-session-format-v3-to-v4` for the admission probe; leave the second out and the suite
prints a note and skips that one check.

The cross-package agreement cannot live in a package suite (an installed copy has no siblings), which is
why the five root suites in **Commands** exist. Each one is there for a reason worth knowing:

- `manifest.test.mjs` catches the package that imports something it never declared: it resolves here
  because the profile farm happens to carry it, and then fails on a user's machine as one missing row.
  Browser halves are exempt (a client bundle resolves dsh's own seed words, not npm packages).
- `host-half.test.mjs` mounts every `lib/index.js` against a fake context the way dsh would and then calls
  what it registered: the `commands` definition, the single `webServer` prefix (which must equal
  `/<package>`), the `webserver/index-inject` entries (one script in the body, one stylesheet in the head,
  both served by that prefix), those assets fetched back byte-for-byte, and the two negative cases (a path
  it does not know under its own prefix answers its own JSON 404, a path outside it is not answered at
  all). Its fake must expose services as context **properties** as well as through `ctx.get()`, because
  that is how every host half calls them.
- `panel-embed.test.mjs` boots every panel's script in a DOM stub for both directions. Its stubs are
  load-bearing: panels append with `child instanceof Node`, read `panel.hidden`/`element.id` as
  properties, and the hub sweeps through `querySelectorAll` + `MutationObserver`. Feeding them a thin
  `{ ok: true }` payload makes the render throw, and then every "no refresh button here" assertion passes
  vacuously, so each package declares its real payload shape (see `PAYLOADS`).
- `mobile-layer.test.mjs` does the same for `dsh-remote`'s browser half, which only runs on a phone. A DOM
  stub has to aggregate `textContent`, expose `parentElement` as well as `parent`, and match `[data-x]`
  presence selectors, or the layer's own guards silently pass and the test asserts nothing.

Two things are worth re-checking after any change: all eight installed **together** still boot
(`--dump-config` then `web --port N --no-open`, and look for the ready line), and dsh-remote's live suite
(`cd dsh-remote && node tests/remote-live.mjs <baseUrl> <proxyPort> <token>` against a sandbox with remote
access on).

### The phone path is tested in a browser sized like a phone

`dsh-remote` has no honest offline test for its whole point (the rewritten page a phone gets), so it is
driven through the browser MCP against the running sandbox, resized to a phone. The layer keys off
**width**, not the user agent (`matchMedia("(max-width: 700px)")`), so `browser_resize 390x844` *is* a
phone environment.

1. Enable remote in **LAN** mode on the sandbox and read the proxy URL from the answer. Never print it:
   `lanUrls[0]` and `snapshot.link` carry the token, which is the only credential. A tunnel publishes the
   harness to the internet and is the user's decision, never a test fixture.

   ```bash
   TOKEN=$(node -e "console.log(require('./.sandbox/sandbox.state.json').token)")
   curl -s -X POST -H "content-type: application/json" -d '{"action":"enable","mode":"lan"}' \
     "http://127.0.0.1:25499/dsh-remote/api/remote?token=$TOKEN"
   ```

2. Resize to 390x844, then open the proxy origin with its token.
3. Enter a session that has content before asserting anything. The layer is progressive: every step that
   cannot find its anchor gives up silently, and the blank new-session page has no `对话 / 轨迹` tab list
   and no composer stats row. Send one message or open an existing session and wait for the view.
4. What it must show, asserted through `browser_evaluate` (and a screenshot as the record):
   `html[data-dshmobile-enhanced]`; a tab strip reading `对话 / 轨迹 / 项目 / 信息` (the last two are the
   layer's, in that order); `[data-composer-stats]` present but `display: none` (the info tab took it
   over); the injected attach button on the composer's tool row.
5. Known and expected: `/manifest.webmanifest` answers 403 on the proxy origin, which is the whole of the
   phone page's console noise. dsh serves that file unauthenticated, the proxy gates every path on its own
   cookie, and the browser fetches a manifest **without credentials**. It costs the PWA metadata, not the
   chat. Do not "fix" it by loosening the proxy's gate as a side effect of a test run.
6. Clean up: disable remote and rotate the token, then confirm the port is free. A LAN listener left
   running on a test machine outlives the test.

   ```bash
   for action in disable reset-token; do curl -s -X POST -H "content-type: application/json" \
     -d "{\"action\":\"$action\"}" "http://127.0.0.1:25499/dsh-remote/api/remote?token=$TOKEN"; done
   ```

### Look at the UI, do not infer it

`tools/visual/shot.mjs` screenshots the real dsh web UI (headless Edge over CDP) at any viewport size,
`zoom` and host attribute, next to a geometry report; its README carries the flags and the measurement
facts. Use it for anything a stylesheet can get wrong, because a computed style that looks right on a panel
that renders wrong is the normal failure here and the suites cannot see it. Point it at the sandbox, never
at a running app. The parts worth knowing before opening that README: `--panel <pkg>` renders a panel
inside a copy of the hub page against `tools/visual/fixtures/<pkg>.json`, `--eval` injects the state you
need to reproduce, `--css` previews a fix before it is written, and `--ask` prints JSON from the real DOM,
which is how a rule gets written against measurement instead of a guess.

The phone is not a separate app (the proxy rewrites dsh's own page), so it is reproduced by shooting the
sandbox at a phone viewport, or the running instance's proxy port with `?token=`, where the deployed layer
is already in the page. Add `--browser-arg "--host-resolver-rules=MAP phone.test 127.0.0.1"` plus
`--browser-arg "--no-proxy-server"` to shoot from a phone *origin*; without the second flag the machine's
HTTP proxy swallows the fake host.

## Not here

`dsh-desktop-kit`, the original single-package version, was retired on 2026-10-10 and removed from the
working tree; it is recoverable from the tag `archive/kit-final` (commit `54db4af`) in
`LBurny/deepseek-harness-desktop`. Page-error reporting and the `/kit` command were dropped in the split
and never came back.

`.agents/skills/dsh-plugin-authoring/` is the authoring skill this repository both uses and describes
(plugin contract, extension points, delivery recipes, `assets/plugin-selftest.mjs`). Nothing there is
shipped: it is a workspace tool, not part of any package.

