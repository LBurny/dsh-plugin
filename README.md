# dsh-plugin

One feature, one plugin. Small, independent [dsh](https://github.com/deepseek-ai/deepseek-harness)
plugins — install only the ones you want, each works alone.

Everything here was carved out of [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)'s
convenience layer (a Tauri window shell) so the same features exist inside dsh itself: no native
window, no extra process, no shell.

| Package | What it does | Command | Panel |
| ------- | ------------ | ------- | ----- |
| [`dsh-skills`](packages/dsh-skills) | Manage skills: enable / disable / delete / import, plus local ZIP import | `/skills` | ✓ |
| [`dsh-mcp`](packages/dsh-mcp) | Manage MCP servers in the active profile's patch layer | `/mcp` | ✓ |
| [`dsh-doctor`](packages/dsh-doctor) | Harness diagnostics: version, port, pid, profile, log tail | `/doctor` | ✓ |
| [`dsh-zoom`](packages/dsh-zoom) | Page zoom with rebindable shortcuts | `/zoom` | ✓ |
| [`dsh-notify`](packages/dsh-notify) | Task reminders: popup + sound + browser notification | `/notify` | ✓ |
| [`dsh-remote`](packages/dsh-remote) | Phone remote access: authenticated reverse proxy, QR link, optional tunnel, mobile UI and project browser | `/remote` | ✓ |

Each package is a normal dsh plugin: it declares `dsh.bundle.patch`, so `dsh plugin add` mounts its
layer automatically. They are independent — any subset works, and each has its own slash command,
its own routes and its own corner launcher.

## Install

```bash
# from source (no build step needed — plain ESM)
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-skills

# pin a commit (recommended: a branch can move under you)
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-skills

# uninstall
dsh plugin --profile web remove dsh-skills
```

Restart dsh afterwards — plugins have no HMR. Install a few, or all six:

```bash
for p in dsh-skills dsh-mcp dsh-doctor dsh-zoom dsh-notify dsh-remote; do
  dsh plugin --profile web add "github:LBurny/dsh-plugin#path:/packages/$p"
done
```

**DSHDesktop users:** set `DSH_HOME` first — the desktop shell's home is
`%LOCALAPPDATA%\DSHDesktop\dsh-home`, not `~/.dsh`, and a plugin installed into the wrong home is
invisible in the app. Also note the app's plugin panel lists npm search results only; local paths
and git specs must go through the command line.

## The one cross-package agreement

Launchers live in a shared corner container so six plugins do not stack six buttons on top of each
other. Each client script appends its own button to `#dsh-launchers`, creating that element if it is
missing. It is a DOM convention, not a dependency: a single installed plugin still renders its own
button, and removing a package removes its button.

## Language and theme

Every panel is bilingual (Chinese / English, picked from `navigator.language`) and follows
`prefers-color-scheme`. This is deliberately *not* wired to dsh's own `locale` / `ui-theme`
preference: reading it means parsing the profile patch from each package, which is exactly the kind
of coupling these packages exist to avoid.

## Repository layout

```
packages/<package>/
├── package.json       # declares dsh.bundle.patch
├── cordis.patch.yml   # the layer row this plugin inserts
├── index.js           # host half: layout, HTTP routes, slash command
├── lib/               # feature logic (self-contained; no imports from sibling packages)
├── assets/            # browser half: panel script + styles (+ vendored mobile assets)
├── locale/            # bilingual name/description for dsh's plugin management page
└── test/              # offline checks (plain assert-style script, no test runner)
```

Each package duplicates the ~150 lines of layout/HTTP helpers it needs instead of sharing a
library. That is the point of the layout: nothing here breaks because a sibling package is missing,
version-drifted or uninstalled.

## Test

```bash
cd packages/<package>            # or the installed copy under $DSH_HOME/profiles/plugins/
node test/<package>.test.mjs
```

| Package | Offline suite | Live suite |
| ------- | ------------- | ---------- |
| dsh-skills | 47 checks | — |
| dsh-mcp | 20 checks | — |
| dsh-doctor | 23 checks | — |
| dsh-zoom | 23 checks | — |
| dsh-notify | 38 checks | — |
| dsh-remote | 73 checks | `test/remote-live.mjs` (needs remote access on; sandbox only) |

The tests use only Node built-ins plus each package's own modules, but the host modules import
`@deepseek-ai/*`, which resolves through the profile's `node_modules`. Either run them from an
installed copy, or add junctions from the plugin's `node_modules` to the runtime's copies.

## Differences from the single-package kit

These packages were carved out of `dsh-desktop-kit`, one dsh plugin that bundled everything behind a
single tabbed panel. Splitting it cost three small things, each a deliberate trade:

- **No panel follows dsh's `locale` / `ui-theme` preference row any more.** Reading it means parsing
  the profile patch from every package, which is exactly the coupling these packages exist to avoid.
  Each panel is bilingual from `navigator.language` and follows `prefers-color-scheme`.
- **No page-error reporting.** The kit captured page errors into its diagnostics panel; with
  per-package panels the browser console is the right place, and the shared `events.log` is the place
  to see everything at once.
- **No fallback `/init`.** It was a guarded extra in the kit; `/init` belongs to the official
  `dsh-command-init` plugin, so it is simply not here.

One thing is shared on purpose, and it is a DOM convention rather than a code dependency: the
`#dsh-launchers` corner container (see above).

## License

MIT. Sound effects under `packages/dsh-notify/sounds/` come from opencode via DSHDesktop, and the
mobile assets under `packages/dsh-remote/assets/` are vendored from DSHDesktop.

