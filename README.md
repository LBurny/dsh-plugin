# dsh-plugin

English | [中文](README.zh-CN.md)

Small, independent [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins — one feature per package, each installable on its own. They were ported out of [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)'s convenience layer, so the same features exist inside dsh itself: no desktop shell, no Tauri, no extra process.

## Plugins

| Package | What it does | Command |
| ------- | ------------ | ------- |
| `dsh-features` | 功能管理: the hub — one sidebar entry (between 插件 and 自动化任务) listing every installed feature plugin below, in one page and one skin. Install it to lose the floating corner buttons | — |
| `dsh-skills` | Manage skills: enable / disable / delete / import, including local ZIP archives | `/skills` |
| `dsh-mcp` | Manage MCP servers in the active profile's patch layer: add / edit / delete / enable / import | `/mcp` |
| `dsh-doctor` | Harness diagnostics: version, port, pid, profile, log tail | `/doctor` |
| `dsh-zoom` | Page zoom with rebindable shortcuts | `/zoom` |
| `dsh-notify` | Task reminders: in-page popup, bundled sounds, browser notification | `/notify` |
| `dsh-remote` | Phone remote access: authenticated reverse proxy, QR link, optional Cloudflare tunnel, mobile UI rewrite, project browser | `/remote` |

Each one is a normal dsh plugin: it declares `dsh.bundle.patch`, so `dsh plugin add` mounts its layer automatically. They never import each other, so any subset works.

`dsh-features` is not a feature: it is the hub the other packages plug into. It is the only one with a
browser half (`dsh.client` → `assets/client.js`), because a real navigation entry can only be added by
a dsh client plugin. With it installed, a feature panel moves onto the hub's page and its floating
corner button disappears; uninstall it and the buttons come back, unchanged.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-skills
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` is DSHDesktop's shell profile; the official desktop app uses `--profile desktop`. The plugin panel accepts the same specs, one at a time.

**Pinning a commit on Windows.** `dsh plugin` there runs through the app's `dsh.cmd` shim, and cmd.exe
eats the `&` in `#<sha>&path:/packages/…`, so pnpm is handed a bare `#<sha>` and refuses it. Pin from
the app's plugin panel (the spec goes straight to pnpm) or install the branch spec above.

Restart dsh afterwards — plugins have no HMR.

**If pnpm cannot reach github.com.** It fetches with its own TLS stack and ignores the system proxy, so on a network that intercepts TLS it fails with `TypeError: fetch failed`. Give it a `$DSH_HOME/profiles/<profile>/.npmrc` containing `https-proxy=http://127.0.0.1:7890` and `proxy=http://127.0.0.1:7890`, or install with no network at all: copy a package into `$DSH_HOME/profiles/plugins/<name>/` and paste its absolute path into the panel.

## Conventions

- **Independent by construction.** No package imports another; each duplicates the small layout and HTTP helpers it needs, so nothing breaks because a sibling is missing, drifted or uninstalled.
- **One DOM-level agreement.** Launchers dock into a shared `#dsh-launchers` corner container and panels clear it via the published `--dsh-launcher-stack` height.
- **The hub agreement.** A feature publishes `{ title, order, mount(host) }` to `window.__dshFeatures` and declares `dsh.ui.feature` in its package.json; the hub mounts it inline and hides `#dsh-launchers`. Nothing is imported in either direction.
- **Bilingual, scheme-aware panels.** Language from `navigator.language`, colours from `prefers-color-scheme` — deliberately *not* dsh's `locale` / `ui-theme`, which would mean parsing the profile patch from every package.
- **Compared to the single-package `dsh-desktop-kit`:** no page-error reporting, no fallback `/init`.

Development notes and the traps worth knowing live in [AGENTS.md](AGENTS.md).

## Test

```bash
cd packages/<name> && node test/<name>.test.mjs
node test/hub-contract.test.mjs          # repo-wide: the hub agreement, from the root
```

Offline suites: 54 (dsh-features) / 47 / 20 / 23 / 23 / 38 / 73 checks, plus 143 repo-wide contract
checks. `dsh-features`' suite evaluates its browser half for real (a vm with a minimal React), so the
sidebar slot, its order and the mount hand-off are asserted without a browser. `dsh-remote` also ships
a live suite (`test/remote-live.mjs`) that needs a sandbox instance with remote access enabled.

## License

MIT. Sounds under `packages/dsh-notify/sounds/` come from opencode via DSHDesktop; the mobile assets under `packages/dsh-remote/assets/` are vendored from DSHDesktop.
