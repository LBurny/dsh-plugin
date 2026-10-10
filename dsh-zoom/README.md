# dsh-zoom

Page zoom for the dsh web UI, with rebindable shortcuts.

Ported from DSHDesktop, where zoom was a native WebView2 `set_zoom` call plus a global keyboard hook.
Inside dsh there is no native window, so the zoom is CSS `zoom` on the page's document element and the
shortcuts are a capture-phase `keydown` listener. For dsh's own UI the result is the same; it just
cannot affect native window chrome (which does not exist here).

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub — a bare dsh, or a profile where it is
not installed — the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-zoom
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-zoom
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs no flag.

Restart dsh afterwards — plugins have no HMR.

## What it does

- **Adjust** the zoom level with a slider, and the step size used by the shortcuts.
- **Rebind** either shortcut by pressing a key: click the keycap (or *Record*) and press the
  combination you want. Escape cancels a recording. A recording stays armed until a key arrives.
- **`/zoom`** prints the current level, the range and both shortcuts.
- **The level is capped by the window height.** `zoom` on `<html>` divides the layout viewport by the
  factor, so past `window height / ~360px` the harness's own sidebar is taller than its box and its
  bottom block — 设置, 意见反馈, 退出登录 — is clipped with nothing to scroll: the shell sets
  `overflow: hidden` and the document never scrolls. The panel shows the cap and the level is re-clamped
  when the window shrinks. `max` stays your preference; this bound is derived per window.

Shortcut matching prefers `event.code` and falls back to `event.key`, so synthesized and
remote-desktop key events still work.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-zoom/panel.js` `/dsh-zoom/panel.css` | browser half |
| GET | `/dsh-zoom/api/settings` | current settings + the settings file path |
| POST | `/dsh-zoom/api/settings` | deep-merged settings patch |

## Data

| What | Where |
| ---- | ----- |
| Zoom level, step, bounds, both shortcuts, launcher on/off | `$DSH_HOME/dsh-zoom.json` |

This package touches nothing else — no patch layer edits, no skill directories.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-zoom"
node tests/zoom.test.mjs
```

## License

MIT.
