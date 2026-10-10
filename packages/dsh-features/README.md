# dsh-features

One home for this repository's feature plugins: a single sidebar entry (功能管理, between 插件 and
自动化任务) whose page mounts every installed feature plugin inline, under one skin — instead of a
stack of floating corner buttons over dsh's own UI.

This package is not a feature itself. It is the hub the other `dsh-*` packages plug into, and it is
built as a **client plugin**: the page, the sidebar glyph and the stylesheet are a browser bundle
(`assets/client.js`) that dsh's own client module system serves, which is the only way to add a real
navigation entry. It needs no other plugin, and the other packages need no change to work without it.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-features
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-features
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs
no flag. Restart dsh afterwards — plugins have no HMR.

## What it does

- **A real nav entry.** `sidebar.panellist` at `order: 5`; the official entries are 插件 (`0`) and
  自动化任务 (`10`), and the sidebar sorts that slot by `order`.
- **A page that hosts the features.** A tab per installed feature plugin; the selected feature's own
  UI is mounted into a node this page owns. Features stay standalone — the hub calls into them.
- **One skin.** The stylesheet hides `#dsh-launchers` (no more stacked buttons) and publishes the
  same `--dsh-*` token palette the feature panels already use, so a feature looks the same inline as
  it does in its own floating panel. Every colour prefers the shell's own theme token
  (`--dsw-alias-*`, which follows dsh's light/dark setting) and falls back to a hardcoded value, so
  the hub matches dsh's theme instead of guessing from the OS.
- **Named failures.** A feature that is installed but whose browser half never loaded is listed as
  *installed, but its panel did not load* rather than silently missing.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-features/api/status` | `{ ok, hub, route, version }` — the probe feature panels use |
| GET | `/dsh-features/api/features` | the inventory: installed packages declaring `dsh.ui.feature` |

Both are read-only, credential-free, and same-origin with the page.

## The two contracts

Everything else is independent — no shared module, no sibling import. Two conventions are the whole
interface, both DOM-level:

**1. A feature publishes itself to the hub** (this is what makes a feature appear, and how the hub
mounts it):

```js
window.__dshFeatures = Object.assign(window.__dshFeatures ?? {}, {
  doctor: {
    title: "诊断",                      // tab label (already localized by the feature)
    order: 30,                          // tab order
    mount(host) { /* render into host */ }   // called on every visit; must be re-mountable
  }
});
```

**2. A feature declares the same thing for the inventory** (metadata only — it lets the hub name a
feature whose script failed):

```json
"dsh": { "ui": { "feature": {
  "key": "doctor", "order": 30,
  "title": { "zh": "诊断", "en": "Doctor" },
  "summary": { "zh": "运行状态与日志尾部", "en": "Status and log tail" }
} } }
```

A feature also probes `GET /dsh-features/api/status` at boot: when the hub answers, the feature does
**not** dock its own corner button, because its UI is reachable from the hub page. When the route is
absent (no hub installed — a bare dsh, or a profile without this package), the floating panel is
built exactly as before. Uninstalling this package therefore restores the buttons.

## Data

Nothing. This plugin reads `package.json` manifests to build the inventory and writes no files.

## Caveats

- The page mounts features into its own DOM, so a feature's UI disappears when you leave the page and
  is rebuilt on return. A feature whose background work updates its panel only repaints while it is
  on screen.
- Feature panels are third-party code running in the page. The hub hands them a node and calls
  `mount`; it does not sandbox them (dsh's own client plugins share the page the same way).
- The sidebar position is a number (`order: 5`). If a future dsh release adds an entry between 0 and
  10, that entry and this one swap places.
- `#dsh-launchers` is hidden globally while this package is installed. That is the point of the
  package; uninstall it to get the floating buttons back.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-features"
node test/hub.test.mjs
```

The browser half is evaluated for real in that suite (a vm with a minimal React), so the sidebar
slot, the order, the skin and the mount hand-off are all asserted without a browser.

## 中文速览

`dsh-features`〔功能管理〕是本仓功能插件的统一入口：侧栏一项（在「插件」与「自动化任务」之间），
页面把每个已安装的功能插件就地挂载进同一个外壳，风格统一，不再有一堆浮动按钮压住 dsh 界面。
它自己不是功能，而是其余 `dsh-*` 包挂靠的基座；装了它，功能插件的浮动按钮自动消失，卸载即恢复。
新增功能插件只需两条约定：把自己的 `mount(host)` 注册到 `window.__dshFeatures`，并在
`package.json` 的 `dsh.ui.feature` 里声明名称与顺序。

## License

MIT.
