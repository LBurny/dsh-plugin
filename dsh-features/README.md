# dsh-features

English | [中文](README.zh.md)

One home for this repository's feature plugins: a single sidebar entry, **Features**, between Plugins
and Scheduled tasks, whose page mounts every installed feature plugin inline under one skin — instead
of a stack of floating corner buttons over dsh's own UI.

This package is not a feature itself. It is the hub the other `dsh-*` packages plug into, and it is
built as a **client plugin**: the page, the sidebar glyph and the stylesheet are a browser bundle
(`lib/client.js`) that dsh's own client module system serves, which is the only way to add a real
navigation entry. It needs no other plugin, and the other packages need no change to work without it.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-features
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-features
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs
no flag. Restart dsh afterwards — plugins have no HMR.

## What it does

- **A real nav entry.** `sidebar.panellist` at `order: 5`; the official entries are Plugins (`0`) and
  Scheduled tasks (`10`), and the sidebar sorts that slot by `order`.
- **A page that hosts the features.** A list of rows, one per installed feature plugin, laid out like
  dsh's own Plugins page: glyph, name, summary, chevron. **Clicking a row opens that feature's settings**
  on the same page, with a back control in the head. Rows are **draggable into your own order**, and
  that order belongs to the **host**, not to one browser: it is written through
  `POST /dsh-features/api/order` into `<DSH_HOME>/dsh-features.json`, because the phone reaches the
  same dsh through the proxy at a different origin and would never see an order kept in `localStorage`
  (that stays only as the first frame's cache). **One refresh control exists at a time**, in the page head: it rescans the inventory,
  remounts the open feature, and asks every install source whether it has moved on (see **Updates**
  below), so embedded panels hide their own refresh (and the hub sweeps away a
  leftover one from an older panel build). Below 620px the gutters tighten for the phone remote view.
  Features stay standalone: the hub calls into them.
- **Updates it can see and apply.** A row whose package came from a source that has moved past the
  commit the profile pinned carries a 可更新 pill, and the head offers one update button for all of
  them. Nothing is installed until that button is clicked.
- **One skin.** The stylesheet hides `#dsh-launchers` (no more stacked buttons) and publishes the
  same `--dsh-*` token palette the feature panels already use, so a feature looks the same inline as
  it does in its own floating panel. Every colour prefers the shell's own theme token
  (`--dsw-alias-*`, which follows dsh's light/dark setting) and falls back to a hardcoded value, so
  the hub matches dsh's theme instead of guessing from the OS.
- **Named failures.** A feature the profile declares but whose browser half never loaded is listed as
  *installed, but its panel did not load* rather than silently missing. Declared is the operative word:
  a package merely staged in `<DSH_HOME>/profiles/plugins/<name>/` is not installed, and does not
  appear, because that directory is where a manual install is prepared, not evidence of one.
- **A name that follows the language.** The Plugins page lists this package as **Features** or
  **功能管理** rather than by its package name, from `locale/en.json` and `locale/zh.json` (see
  **Display name** below).

## Updates

The refresh control in the page head does both halves at once: it rescans the inventory, and it asks
every installed feature's install source whether that source has moved on.

- **The check** (`GET /dsh-features/api/updates`). Where a package came from is the profile's record,
  not the package's: the spec is in `<profile>/package.json`, and the commit pnpm resolved it to is in
  `<profile>/pnpm-lock.yaml`. A `git ls-remote` against that source is what says whether it moved, one
  call per distinct repository rather than per package, so a monorepo costs one round trip. A `link:`
  dependency is live source and can never be behind, a `file:` copy is compared by the version it
  declares, and a registry range is reported as unknown instead of guessed at. A source that cannot be
  reached is named on the page, and does not fail the rest of the check.
- **The apply** (`POST /dsh-features/api/update`). `pnpm update <names>`, run through the plugin
  manager's own pnpm runner inside its profile transaction, so an update here cannot interleave with an
  install from the Plugins page. Only packages this profile installs are accepted. The check itself
  installs nothing: it adds a pill to the row and a button to the head, and the second click is what
  writes.
- **Restart required.** Plugins have no HMR. The new files are on disk when the route answers, and the
  running dsh keeps the old code until it is restarted.
- **The hub is checked too.** This package is installed from a source like any other, but it is not a
  feature: it has no row and therefore no pill. It is still in the check and in the update (the Plugins
  page has no way to update it), and the page says so instead of letting the count exceed the pills.

Why not reinstall the same spec instead: `pnpm add <the same spec>` does not re-resolve. It prints
"Lockfile is up to date, resolution step is skipped" and the installed commit stays where it was, so
re-installing cannot update anything. `pnpm update <name>` does re-resolve a git spec, `#path:/<sub>`
included. Both were measured against pnpm 11 in the app's runtime and pnpm 12 standalone, on 2026-10-11.

The check runs when the reader asks for it, never on page load. Its result is kept in the host process
and rides along with the inventory, so a page opened after a check shows the same badges with no second
round trip.

## Display name

The Plugins page names a plugin from the package itself, without loading it. `locale/en.json` anchors
the set, every sibling file is a language id, and each carries `meta.title` and `meta.description`
(this is dsh-app-boot's `readPluginMeta`, and it is the same path the bundle details and component rows
use). This package ships `locale/en.json` and `locale/zh.json`, so it is listed as **Features** or
**功能管理**, with a description that follows the language too.

Two details matter, and both fail quietly: the files are resolved through the package's `exports`, so a
locale directory without `"./locale/*.json"` in `exports` reads as "no metadata", and `en.json` is the
anchor, so a language without it is not read at all. With no metadata dsh falls back to the package
name, which is what a plugin looks like when it is listed as `dsh-features` beside 诊断 and 任务提醒.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-features/api/status` | `{ ok, hub, route, version }` — the probe feature panels use |
| GET | `/dsh-features/api/features` | the inventory: packages *this profile declares* (its `dependencies` / `dsh.profile.bundles`) that declare `dsh.ui.feature`, plus `navOrder` and the last update check |
| GET | `/dsh-features/api/updates` | check every installed feature's install source: `{ ok, checkedAt, packages, updatable, errors }` |
| POST | `/dsh-features/api/order` | save the reader's feature order: `{ keys: [...] }`, answered with the stored order |
| POST | `/dsh-features/api/update` | apply updates for the named packages: `{ packages: [...] }`, answered with `pnpm`'s output tail and `restartRequired` |

Read-only except the order and the update, credential-free, and same-origin with the page. The update
check is the only route that reaches the network, and the update is the only one that writes.

## The two contracts

Everything else is independent — no shared module, no sibling import. Two conventions are the whole
interface, both DOM-level:

**1. A feature publishes itself to the hub** (this is what makes a feature appear, and how the hub
mounts it):

```js
window.__dshFeatures = Object.assign(window.__dshFeatures ?? {}, {
  doctor: {
    title: "Doctor",                    // nav label (already localized by the feature)
    icon: "M2 8.5h3l1.5-4 2.5 7 ...",   // optional 16×16 stroke SVG path for the nav row
    order: 30,                          // default nav order (the reader's drag order wins)
    mount(host) { /* render into host */ }   // called on every visit; must be re-mountable
  }
});
```

**2. A feature declares the same thing for the inventory** (metadata only — it lets the hub name a
feature whose script failed):

```json
"dsh": { "ui": { "feature": {
  "key": "doctor", "order": 30,
  "title": { "zh": "<Chinese label>", "en": "Doctor" },
  "summary": { "zh": "<Chinese summary>", "en": "Status and log tail" }
} } }
```

A feature also probes `GET /dsh-features/api/status` at boot: when the hub answers, the feature does
**not** dock its own corner button, because its UI is reachable from the hub page. When the route is
absent (no hub installed — a bare dsh, or a profile without this package), the floating panel is
built exactly as before. Uninstalling this package therefore restores the buttons.

## Data

`<DSH_HOME>/dsh-features.json` — the reader's feature order, written atomically through
`@deepseek-ai/dsh-atomic-write`. It is on the host rather than in the browser because browser storage is
per-origin and the phone reaches the same dsh from the proxy's origin: kept in `localStorage` (where it
used to live) a desktop reorder never reached the phone. The page still caches it locally, which is what
gives the first frame the right order; the host's answer is what it reconciles against.

## Caveats

- The page mounts a feature into its own DOM on open and drops it on the way back, so a feature's UI
  is rebuilt on every visit. A feature whose background work updates its panel only repaints while
  it is open.
- Feature panels are third-party code running in the page. The hub hands them a node and calls
  `mount`; it does not sandbox them (dsh's own client plugins share the page the same way).
- The hub removes any bare refresh button a mounted feature renders (the `Refresh` literal, or its
  localized form), and anything marked `data-dsh-refresh`: the page head owns the only refresh control. A feature with a control of its
  own that must survive should label it something else.
- The sidebar position is a number (`order: 5`). If a future dsh release adds an entry between 0 and
  10, that entry and this one swap places.
- The update check shells out to `git ls-remote`, so it needs `git` on the PATH dsh was started with.
  Without it every git source is reported as unreachable, with git's own message; the page still works.
  A private source is read with no credential prompt (`GIT_TERMINAL_PROMPT=0`), so it reports as
  unreachable rather than hanging.
- Updating a package replaces files that the running dsh has already loaded. That is why the answer is
  a restart, and why the check and the apply are two separate clicks.
- `#dsh-launchers` is hidden globally while this package is installed. That is the point of the
  package; uninstall it to get the floating buttons back.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-features"
node tests/hub.test.mjs
```

The browser half is evaluated for real in that suite (a vm with a minimal React), so the sidebar
slot, the order, the skin, the list, the drill-down, the drag order, the mount hand-off and the update
half (the pill, the button, the POST it makes, and the three endings of a check) are all asserted
without a browser. The repository root has one more suite that runs every feature panel's
browser script against the hub's behaviour: `node tests/panel-embed.test.mjs`.

## License

MIT.
