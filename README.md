# dsh-plugin

English | [中文](README.zh.md)

A set of small plugins for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). One feature per package, every package installs on its own, and nothing depends on anything else in the set. Everything runs inside dsh itself, so there is no extra app to install and no extra process to keep alive.

## What you get

Eight packages. Pick the ones you want.

| Package | What it does | Command |
| ------- | ------------ | ------- |
| `dsh-features` | A **Features** entry in the sidebar, between Plugins and Scheduled tasks. It lists every installed feature plugin as a row like dsh's own Plugins page, opens one on click, and reorders rows by drag. With it installed, the floating corner buttons move onto that page | |
| `dsh-skills` | Manage skills: enable, disable, delete, import, local ZIP archives included | |
| `dsh-mcp` | Manage the MCP servers of the active profile: add, edit, delete, enable, import | |
| `dsh-doctor` | A debugging panel for plugins: the harness's own log records read in-process, every plugin row with its activation state, plus the log files that exist | `/doctor` |
| `dsh-zoom` | Page zoom with shortcuts you can rebind | |
| `dsh-notify` | Task reminders: in-page popup, bundled sounds, browser notification | |
| `dsh-remote` | dsh on your phone: an authenticated reverse proxy with a QR link, over LAN, a Tailscale tailnet or a Cloudflare tunnel, plus a mobile rewrite of the page and a project browser | |
| `dsh-init` | Write or update the workspace's `AGENTS.md`, the instruction file dsh loads into every session there | `/init` |

Two of them sit a little apart from the rest.

`dsh-features` is not a feature but the hub the others plug into, and the only package with a browser client, because only a dsh client plugin can add a real sidebar entry. Install it and the feature panels move onto its page; uninstall it and the corner buttons come back, unchanged.

`dsh-init` is a command, not a feature. It has no panel, so the hub does not list it. Its prompt follows the harness's real instruction-file rules, and the result arrives as a collapsed context row instead of a long user message.

Underneath, every package is an ordinary dsh plugin: it declares `dsh.bundle.patch`, so `dsh plugin add` mounts it automatically. Packages never import each other, which is why any subset works.

## Install

Two routes, one set of specs: the desktop app's **Plugins** page, or `dsh plugin add` in a terminal. Either way, restart dsh afterwards; plugins have no hot reload.

### In the desktop app

Open **Plugins**, click **Add plugin**, paste a spec, install, repeat. The box accepts a package name, a git URL, or a local directory path.

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

`#path:/<package>` is how pnpm names a subdirectory of a repository; all eight packages live in this one, so every spec carries it. Install order does not matter.

Two things worth knowing about that page. Upgrading is uninstall, then install again: there is no auto-update, and pinning a commit (`#<sha>&path:/<package>`) makes a spec reproducible. And if GitHub is unreachable, retry with the page's **Install source** option: default, npm official, China mirror, or custom.

### From the command line

```bash
dsh plugin add github:LBurny/dsh-plugin#path:/dsh-skills
# pin a commit:
dsh plugin add github:LBurny/dsh-plugin#<sha>&path:/dsh-skills
dsh plugin remove dsh-skills
```

Using the desktop app? Its profile is called `desktop` and the app manages it while it runs, so quit the app first and add `--profile desktop` to the same commands. The Plugins page above is usually the easier route.

**Pinning a commit on Windows.** `dsh plugin` runs through the app's `dsh.cmd` shim, and cmd.exe eats the `&` in `#<sha>&path:/…`, so pnpm receives a bare `#<sha>` and refuses it. Pin from the app's page, where the spec reaches pnpm untouched, or install the unpinned branch spec instead.

**When pnpm cannot reach github.com.** It fetches with its own TLS stack and ignores the system proxy, so a TLS-intercepting network fails with `TypeError: fetch failed`. Point it at your proxy in `$DSH_HOME/profiles/<profile>/.npmrc`:

```ini
https-proxy=http://127.0.0.1:7890
proxy=http://127.0.0.1:7890
```

Or install offline: copy a package into `$DSH_HOME/profiles/plugins/<name>/` and add that directory path.

## Conventions

A few ground rules keep the set together without tangling it.

- **Independent by construction.** No package imports another; each duplicates the few small helpers it needs, so a missing, drifted or uninstalled sibling breaks nothing.
- **One DOM-level agreement.** Corner launchers dock into a shared `#dsh-launchers` container, and panels clear it via the published `--dsh-launcher-stack` height.
- **The hub contract.** A feature publishes `{ title, order, mount(host) }` on `window.__dshFeatures` and declares `dsh.ui.feature` in its package.json; the hub mounts it inline and hides `#dsh-launchers`. Nothing is imported in either direction.
- **Bilingual panels, theme-following colours.** Language comes from `navigator.language`; colours prefer dsh's own `--dsw-alias-*` tokens and fall back to hardcoded values under `prefers-color-scheme`.

Changing the code? Read [AGENTS.md](AGENTS.md) first; the traps worth knowing are written down there.

## Test

Everything is plain Node, no build step. Each package carries its own suite, and five repo-wide suites at the root check the packages against each other:

```bash
cd <name> && node tests/<name>.test.mjs   # one package on its own
node tests/hub-contract.test.mjs          # the hub contract
node tests/panel-embed.test.mjs           # every panel boots, with and without the hub
node tests/mobile-layer.test.mjs          # the phone layer's DOM behaviour
node tests/manifest.test.mjs              # directory name == package name; every import declared
node tests/host-half.test.mjs             # every host half mounts; routes, assets, command
```

Each suite prints its own totals, and all of them pass.

To see the whole set running together, use the sandbox: one command brings up a real dsh home at `.sandbox/` (gitignored, and it refuses to touch your real `~/.dsh`) with all eight packages installed from this working tree:

```bash
node tools/sandbox/sandbox.mjs up            # first run: create, install, boot, print the URL
node tools/sandbox/sandbox.mjs up --restart  # after an edit: reload the running instance
node tools/sandbox/sandbox.mjs url           # print the URL, token included
node tools/sandbox/sandbox.mjs down          # stop it
```

See [tools/sandbox/README.md](tools/sandbox/README.md). For the look of the UI, which no suite can judge, `tools/visual/` has a screenshot harness; see its README.

## License

MIT. The notification sounds under `dsh-notify/lib/sounds/` come from the opencode project and are bundled as-is.
