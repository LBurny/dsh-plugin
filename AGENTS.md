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
- `dsh-features/` is the exception in shape, not in independence: it is the **hub** (功能管理)
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
- **The browser halves share exactly two things, both DOM-level:** the `#dsh-launchers` corner
  container and the `--dsh-launcher-stack` custom property, plus the `.dsh-launch` button class whose
  styles are duplicated identically in every `client.css`. Panel styles are scoped under
  `#<package>-root` so six stylesheets cannot fight. Keep both properties when adding a package.
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
  - The hub page is a **list of rows plus a drill-down**, modelled on dsh's own 插件 page: one row per
    feature (glyph, name, summary, chevron), clicking one opens it and puts a back control in the
    head. It is deliberately *not* a left-hand nav rail — that reads as a second level of dsh's own
    sidebar. The reader's drag order lives in `localStorage["dsh-features:nav-order"]` (an array of
    keys; new features append by their default order). Reordering must not remount the open panel:
    the mount effect depends on the merged snapshot, and the open feature is looked up by key.
  - The page head owns the **only** refresh control (rescan + remount re-fetches the panel's data).
    A panel that has one of its own hides it while embedded — `inHub ? undefined : …` — and marks it
    `data-dsh-refresh` so the hub can drop it either way. The hub additionally sweeps the mount point
    (`stripDuplicateRefresh`: the marker, or a bare 刷新/Refresh label) on every mutation, because a
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
  - `tests/panel-embed.test.mjs` boots every panel's script in a DOM stub for both directions (hub
    present and absent). Its stubs are load-bearing: panels append with `child instanceof Node`, read
    `panel.hidden`/`element.id` as *properties* (the `hidden` and `id` attributes are reflected), and
    the hub sweeps through `querySelectorAll` + `MutationObserver`. Feeding them a thin `{ ok: true }`
    payload makes the render throw, and then every "no refresh button here" assertion passes
    vacuously — so each package declares its real payload shape (see `PAYLOADS` there).
  - A feature probes `GET /dsh-features/api/status` at boot and **skips its floating panel when the
    hub answers**. Without the hub (bare dsh, or the package uninstalled) the launcher must still be
    built exactly as before — that path is what the panels were originally written for.
  - The hub hides `#dsh-launchers` from its own stylesheet. Do not "fix" a feature by re-showing it.
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
  managed root ends up with real files, not links into a foreign farm. This is what made 导入技能 show
  "没有找到技能" while `~/.codex/skills` held ten skills.
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

## Not here

`dsh-desktop-kit` in the DSHPlugin repository is the original single-package version; this repository
is the per-feature split. Language/theme following, page-error reporting and the `/init` fallback
were dropped in the split — see the root README for why.
