# dsh-plugin

English | [中文](README.zh.md)

Small, independent [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins — one feature per package, each installable on its own. They were ported out of [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)'s convenience layer, so the same features exist inside dsh itself: no desktop shell, no Tauri, no extra process.

## Plugins

| Package | What it does | Command |
| ------- | ------------ | ------- |
| `dsh-features` | The hub (Features): one sidebar entry, between Plugins and Scheduled tasks, that lists every installed feature plugin as a row like dsh's own Plugins page, opens one on click, and reorders them by drag. Install it to lose the floating corner buttons | — |
| `dsh-skills` | Manage skills: enable / disable / delete / import, including local ZIP archives | `/skills` |
| `dsh-mcp` | Manage MCP servers in the active profile's patch layer: add / edit / delete / enable / import | `/mcp` |
| `dsh-doctor` | Harness diagnostics: version, port, pid, profile, log tail | `/doctor` |
| `dsh-zoom` | Page zoom with rebindable shortcuts | `/zoom` |
| `dsh-notify` | Task reminders: in-page popup, bundled sounds, browser notification | `/notify` |
| `dsh-remote` | Phone remote access: authenticated reverse proxy, QR link, optional Cloudflare tunnel, mobile UI rewrite, project browser | `/remote` |

Each one is a normal dsh plugin: it declares `dsh.bundle.patch`, so `dsh plugin add` mounts its layer automatically. They never import each other, so any subset works.

`dsh-features` is not a feature: it is the hub the other packages plug into. It is the only one with a
browser half (`dsh.client` → `lib/client.js`), because a real navigation entry can only be added by
a dsh client plugin. With it installed, a feature panel moves onto the hub's page and its floating
corner button disappears; uninstall it and the buttons come back, unchanged.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-skills
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` is DSHDesktop's shell profile; the official desktop app uses `--profile desktop`. The plugin panel accepts the same specs, one at a time.

**Pinning a commit on Windows.** `dsh plugin` there runs through the app's `dsh.cmd` shim, and cmd.exe
eats the `&` in `#<sha>&path:/dsh…`, so pnpm is handed a bare `#<sha>` and refuses it. Pin from
the app's plugin panel (the spec goes straight to pnpm) or install the branch spec above.

Restart dsh afterwards — plugins have no HMR.

**If pnpm cannot reach github.com.** It fetches with its own TLS stack and ignores the system proxy, so on a network that intercepts TLS it fails with `TypeError: fetch failed`. Give it a `$DSH_HOME/profiles/<profile>/.npmrc` containing `https-proxy=http://127.0.0.1:7890` and `proxy=http://127.0.0.1:7890`, or install with no network at all: copy a package into `$DSH_HOME/profiles/plugins/<name>/` and paste its absolute path into the panel.

## Conventions

- **Independent by construction.** No package imports another; each duplicates the small layout and HTTP helpers it needs, so nothing breaks because a sibling is missing, drifted or uninstalled.
- **One DOM-level agreement.** Launchers dock into a shared `#dsh-launchers` corner container and panels clear it via the published `--dsh-launcher-stack` height.
- **The hub agreement.** A feature publishes `{ title, order, mount(host) }` to `window.__dshFeatures` and declares `dsh.ui.feature` in its package.json; the hub mounts it inline and hides `#dsh-launchers`. Nothing is imported in either direction.
- **Bilingual panels, theme-following colours.** Language from `navigator.language` — deliberately *not* dsh's `locale`, which would mean parsing the profile patch from every package. Colours prefer the shell's own `--dsw-alias-*` tokens (so a panel follows dsh's light/dark setting) and fall back to hardcoded values under `prefers-color-scheme`.
- **Compared to the single-package `dsh-desktop-kit`:** no page-error reporting, no fallback `/init`.

Development notes and the traps worth knowing live in [AGENTS.md](AGENTS.md).

## Test

```bash
cd <name> && node tests/<name>.test.mjs
node tests/hub-contract.test.mjs          # repo-wide: the hub agreement, from the root
node tests/panel-embed.test.mjs           # repo-wide: every panel boots without the hub
```

Offline suites: 75 (dsh-features) / 60 / 20 / 23 / 23 / 38 / 81 checks, plus 279 repo-wide contract
checks and 78 cross-package panel checks. `tools/visual/` holds a screenshot harness for the UI work
these numbers cannot see — see its README. `dsh-features`' suite evaluates its browser half for real
(a vm with a minimal React), so the sidebar slot, its order, the list, the drill-down and the mount
hand-off are asserted without a browser; `panel-embed.test.mjs` runs all six feature panels' scripts
in a DOM stub to prove none of them docks a corner button or a second refresh control while the hub
is installed. `dsh-remote` also ships a live suite (`tests/remote-live.mjs`) that needs a sandbox
instance with remote access enabled.

## License

MIT. Sounds under `dsh-notify/lib/sounds/` come from opencode via DSHDesktop; the mobile assets under `dsh-remote/lib/assets/` are vendored from DSHDesktop.
