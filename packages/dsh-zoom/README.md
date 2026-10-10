# dsh-zoom

Page zoom for the dsh web UI, with rebindable shortcuts.

Ported from DSHDesktop, where zoom was a native WebView2 `set_zoom` call plus a global keyboard hook.
Inside dsh there is no native window, so the zoom is CSS `zoom` on the page's document element and the
shortcuts are a capture-phase `keydown` listener. For dsh's own UI the result is the same; it just
cannot affect native window chrome (which does not exist here).

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-zoom
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-zoom
```

`--profile web` is DSHDesktop's shell profile; the official dsh desktop app uses `--profile desktop`
(check `$DSH_HOME/profiles/`). The plugin panel needs no profile flag.

Restart dsh afterwards — plugins have no HMR.

## What it does

- **Adjust** the zoom level with a slider, and the step size used by the shortcuts.
- **Rebind** either shortcut by pressing a key: click the keycap (or *Record*) and press the
  combination you want. Escape cancels a recording. A recording stays armed until a key arrives.
- **`/zoom`** prints the current level, the range and both shortcuts.

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
node test/zoom.test.mjs
```

## License

MIT.
