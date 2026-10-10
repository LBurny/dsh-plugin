# dsh-plugin — notes for agents

A collection of independent dsh plugins, one feature per package. Read this before changing
anything here; it is short and most of it is a trap someone already walked into.

## Shape

- `packages/<name>/` is a **complete, standalone dsh plugin**. Nothing may import from a sibling
  package — that is the whole point of the split. Shared helpers are duplicated on purpose.
- Each package ships the three-file core (`package.json` with `dsh.bundle.patch`, `cordis.patch.yml`,
  `index.js`) plus `lib/` (host logic), `assets/` (browser half, plain DOM, no build step),
  `locale/` (bilingual name/description for dsh's plugin management page) and `test/`.
- The package name is the npm name; the module's exported `name` and the patch row `id` are the short
  name (`dsh-skills` → `skills`). Row ids are first-come, first-served across the whole plugin tree.
- `packages/dsh-features/` is the exception in shape, not in independence: it is the **hub** (功能管理)
  and the only package with a browser *client* half (`dsh.client` + `exports["./client"]` →
  `assets/client.js`, a `__ModuleLoader__.load({id, factory})` classic script, not a module). A real
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
  styles are duplicated identically in every `panel.css`. Panel styles are scoped under
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
    key and the order must match in both places; `test/hub-contract.test.mjs` fails if they drift.
  - `mount(host)` is called again on every visit and the hub drops the DOM when you leave the page, so
    it must rebuild from scratch (see `mountInline` in any feature's `panel.js`).
  - The hub page is a vertical nav plus a stage. The reader's drag order lives in
    `localStorage["dsh-features:nav-order"]` (an array of keys; new features append by their default
    order). Reordering must not remount the open panel — the mount effect depends on the merged
    snapshot, and the positional default selection is pinned to its key before a shuffle.
  - The hub's stage header owns the single refresh button (rescan + remount re-fetches a panel's
    data), so a panel with its own refresh button must hide it when embedded: `inHub ? undefined : …`.
    Keep the standalone floating panel's button — without the hub it is the only refresh.
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
cd packages/<name> && node test/<name>.test.mjs
```

`packages/dsh-features` needs no runtime at all: its suite evaluates the browser bundle in a `vm` with a
minimal React (state/effect/ref), so the sidebar slot, its order, the skin and the `mount` hand-off are
asserted without a browser. The cross-package agreement cannot live in a package suite (an installed
copy has no siblings), so it is checked from the repository root:

```bash
node test/hub-contract.test.mjs
```

Verification is per package and the totals are in the root README. Two things are worth re-checking
after any change: all six installed **together** still boot (`--dump-config` then `web --port N
--no-open`, and look for the ready line), and dsh-remote's live suite
(`node test/remote-live.mjs <baseUrl> <proxyPort> <token>` against a sandbox with remote access on).

## Not here

`dsh-desktop-kit` in the DSHPlugin repository is the original single-package version; this repository
is the per-feature split. Language/theme following, page-error reporting and the `/init` fallback
were dropped in the split — see the root README for why.
