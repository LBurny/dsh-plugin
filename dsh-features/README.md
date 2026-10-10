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
  (that stays only as the first frame's cache). **One refresh control exists at a time**, in the page head: it rescans the inventory
  and remounts the open feature, so embedded panels hide their own (and the hub sweeps away a
  leftover one from an older panel build). Below 620px the gutters tighten for the phone remote view.
  Features stay standalone — the hub calls into them.
- **One skin.** The stylesheet hides `#dsh-launchers` (no more stacked buttons) and publishes the
  same `--dsh-*` token palette the feature panels already use, so a feature looks the same inline as
  it does in its own floating panel. Every colour prefers the shell's own theme token
  (`--dsw-alias-*`, which follows dsh's light/dark setting) and falls back to a hardcoded value, so
  the hub matches dsh's theme instead of guessing from the OS.
- **Named failures.** A feature the profile declares but whose browser half never loaded is listed as
  *installed, but its panel did not load* rather than silently missing. Declared is the operative word:
  a package merely staged in `<DSH_HOME>/profiles/plugins/<name>/` is not installed, and does not
  appear — that directory is where a manual install is prepared, not evidence of one.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-features/api/status` | `{ ok, hub, route, version }` — the probe feature panels use |
| GET | `/dsh-features/api/features` | the inventory: packages *this profile declares* (its `dependencies` / `dsh.profile.bundles`) that declare `dsh.ui.feature`, plus `navOrder` |
| POST | `/dsh-features/api/order` | save the reader's feature order: `{ keys: [...] }`, answered with the stored order |

Read-only except the order, credential-free, and same-origin with the page.

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
- `#dsh-launchers` is hidden globally while this package is installed. That is the point of the
  package; uninstall it to get the floating buttons back.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-features"
node tests/hub.test.mjs
```

The browser half is evaluated for real in that suite (a vm with a minimal React), so the sidebar
slot, the order, the skin, the list, the drill-down, the drag order and the mount hand-off are all
asserted without a browser. The repository root has one more suite that runs every feature panel's
browser script against the hub's behaviour: `node tests/panel-embed.test.mjs`.

## License

MIT.
