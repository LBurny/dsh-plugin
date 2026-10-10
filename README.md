# dsh-plugin

English | [中文](README.zh.md)

Small independent [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins: one feature per package, each installable on its own. Ported out of [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)'s convenience layer, so the same features run inside dsh itself: no desktop shell, no Tauri, no extra process.

## Plugins

| Package | What it does | Command |
| ------- | ------------ | ------- |
| `dsh-features` | The hub (Features): one sidebar entry between Plugins and Scheduled tasks, lists every installed feature plugin as a row like dsh's own Plugins page, opens one on click, reorders by drag. Install it to lose the floating corner buttons | |
| `dsh-skills` | Manage skills: enable / disable / delete / import, including local ZIP archives | `/skills` |
| `dsh-mcp` | Manage MCP servers in the active profile's patch layer: add / edit / delete / enable / import | `/mcp` |
| `dsh-doctor` | Debug this set of plugins: the harness's own log records read in-process, every row of the plugin tree with its activation state, and whichever log files exist | `/doctor` |
| `dsh-zoom` | Page zoom with rebindable shortcuts | `/zoom` |
| `dsh-notify` | Task reminders: in-page popup, bundled sounds, browser notification | `/notify` |
| `dsh-remote` | Phone remote access: authenticated reverse proxy, QR link, optional Cloudflare tunnel, mobile UI rewrite, project browser | `/remote` |
| `dsh-init` | Write or update this workspace's `AGENTS.md`, the instruction file dsh loads into every session there | `/init` |

Each one is a normal dsh plugin: it declares `dsh.bundle.patch`, so `dsh plugin add` mounts its layer automatically. They never import each other, so any subset works.

`dsh-init` is a command, not a feature: no browser half, no panel, no `dsh.ui.feature` marker, so
`dsh-features` does not list it. That matches the built-in `/init` it was ported from. Its prompt is
written against the harness's real instruction-loading chain (the root `AGENTS.md` and `CLAUDE.md`,
the personal overlays, nested files, and the user-global file it must not touch), and it arrives as a
collapsed context row rather than a long user message.

`dsh-features` is not a feature but the hub the other packages plug into. It is the only one with a
browser half (`dsh.client` → `lib/client.js`), because a real navigation entry can only be added by
a dsh client plugin. With it installed, feature panels move onto the hub's page and their floating
corner buttons disappear; uninstall it and the buttons come back, unchanged.

## Install

Each package installs on its own, and both routes take the same specs: the desktop app's **Plugins**
page, or `dsh plugin add` from a command line. Restart dsh afterwards; plugins have no HMR.

### One by one in the desktop app

The official desktop app manages its own `desktop` profile, and the command line cannot change that
one. Open **Plugins**, then **Add plugin**, paste one spec, install, and repeat for the next. The
box accepts a package name, a Git repository address, or a local directory path.

```text
github:LBurny/dsh-plugin#path:/dsh-features
github:LBurny/dsh-plugin#path:/dsh-skills
github:LBurny/dsh-plugin#path:/dsh-mcp
github:LBurny/dsh-plugin#path:/dsh-doctor
github:LBurny/dsh-plugin#path:/dsh-zoom
github:LBurny/dsh-plugin#path:/dsh-notify
github:LBurny/dsh-plugin#path:/dsh-remote
github:LBurny/dsh-plugin#path:/dsh-init
```

`#path:/<package>` is pnpm's subdirectory-of-a-repository form; all eight live in this one
repository, so every spec carries it. Order does not matter, and a subset is fine. Install
`dsh-features` too and the feature panels move onto its single sidebar entry instead of one
floating corner button each. A pinned spec needs no escaping here; the `&` trap belongs to the
command line, not to the page.

The page itself tells you two things. Upgrading is uninstall, then install the new version: there
is no auto-update, so a fix arrives by reinstalling the spec, pinned if you want it reproducible.
And when GitHub cannot be reached, retry with the page's **Install source** choice: default, npm
official, China mirror, or custom.

### From the command line

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-skills
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` is DSHDesktop's shell profile; the desktop app's profile goes through its page, above.

**Pinning a commit on Windows.** `dsh plugin` runs through the app's `dsh.cmd` shim, and cmd.exe
eats the `&` in `#<sha>&path:/dsh…`, so pnpm receives a bare `#<sha>` and refuses it. Pin from
the app's page, where the spec goes straight to pnpm, or install the branch spec instead.

**If pnpm cannot reach github.com.** It fetches with its own TLS stack and ignores the system
proxy, so a TLS-intercepting network fails with `TypeError: fetch failed`. Write
`https-proxy=http://127.0.0.1:7890` and `proxy=http://127.0.0.1:7890` into
`$DSH_HOME/profiles/<profile>/.npmrc`, or install offline: copy a package into
`$DSH_HOME/profiles/plugins/<name>/` and add that directory path.

## Conventions

- **Independent by construction.** No package imports another; each duplicates the small layout and HTTP helpers it needs, so a missing, drifted or uninstalled sibling breaks nothing.
- **One DOM-level agreement.** Launchers dock into a shared `#dsh-launchers` corner container, and panels clear it via the published `--dsh-launcher-stack` height.
- **The hub agreement.** A feature publishes `{ title, order, mount(host) }` to `window.__dshFeatures` and declares `dsh.ui.feature` in its package.json; the hub mounts it inline and hides `#dsh-launchers`. Nothing is imported in either direction.
- **Bilingual panels, theme-following colours.** Language comes from `navigator.language`, deliberately not dsh's `locale`, which would make every package parse the profile patch. Colours prefer the shell's own `--dsw-alias-*` tokens, so a panel follows dsh's light/dark setting, and fall back to hardcoded values under `prefers-color-scheme`.
- **Compared to the retired single-package `dsh-desktop-kit`:** no page-error reporting. That package was the origin these were split from and is no longer developed.

Development notes and the traps worth knowing live in [AGENTS.md](AGENTS.md).

## Test

```bash
cd <name> && node tests/<name>.test.mjs
node tests/hub-contract.test.mjs          # repo-wide: the hub agreement, from the root
node tests/panel-embed.test.mjs           # repo-wide: every panel boots without the hub
node tests/mobile-layer.test.mjs          # repo-wide: the phone layer's DOM behaviour
node tests/manifest.test.mjs              # repo-wide: the directory name, and every import declared
```

Offline suites: 88 (dsh-features) / 60 / 20 / 63 / 23 / 38 / 99 checks, plus 49 (dsh-init) and 279
repo-wide contract checks, 78 cross-package panel checks, 7 mobile-layer checks and 17 manifest
checks.

`dsh-features`' suite evaluates its browser half for real (a vm with a minimal React), so the
sidebar slot, its order, the list, the drill-down and the mount hand-off are asserted without a
browser. `dsh-init`'s suite runs the runtime's own session-format V4 admission on the message it
injects, with a negative fixture proving the probe can fail, so the one regression that makes `/init`
register and then do nothing stays caught. `panel-embed.test.mjs` runs all six feature panels'
scripts in a DOM stub to prove none of them docks a corner button or a second refresh control while
the hub is installed. `mobile-layer.test.mjs` does the same for the browser half of the phone layer,
where a remote-origin settings page has to lose upstream's dead Retry.
`tools/visual/` holds a screenshot harness for the UI work these numbers cannot see; see its README.
`dsh-remote` also ships a live suite (`tests/remote-live.mjs`) that needs a sandbox instance with
remote access enabled.

For the whole set running together there is a reusable sandbox: one command brings up a real dsh with
all eight packages installed from this working tree, and after the first run a code change only needs
a restart. It lives in `.sandbox/` (gitignored, never committed, and it refuses to touch your own
`~/.dsh`):

```bash
node tools/sandbox/sandbox.mjs up --restart   # reload the running instance
node tools/sandbox/sandbox.mjs url            # its URL, token included
node tools/sandbox/sandbox.mjs down           # stop it
```

See [tools/sandbox/README.md](tools/sandbox/README.md).

## License

MIT. Sounds under `dsh-notify/lib/sounds/` come from opencode via DSHDesktop; the mobile assets under `dsh-remote/lib/assets/` are vendored from DSHDesktop.
