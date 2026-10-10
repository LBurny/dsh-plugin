# dsh-zoom

Page zoom for the dsh web UI, with rebindable shortcuts.

Ported from DSHDesktop, where zoom was a native WebView2 `set_zoom` call plus a global keyboard hook.
Inside dsh there is no native window, so the zoom is CSS `zoom` on the page's document element and the
shortcuts are a capture-phase `keydown` listener. For dsh's own UI the result is the same; it just
cannot affect native window chrome (which does not exist here).

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub (a bare dsh, or a profile where it is
not installed) the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

Installed straight from this repository, as a normal public package. `#path:` picks this package out
of the monorepo, since all seven live in one:

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-zoom
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-zoom
dsh plugin --profile web remove dsh-zoom
```

`--profile web` is DSHDesktop's shell, `--profile desktop` is the official desktop app; the panel
needs no flag. The pinned form is the reproducible one, and it is also how a fix reaches you: re-add
the spec with the newer commit.

In the desktop app, whose profile the command line cannot change, the same spec goes through its
**Plugins** page, **Add plugin**, which accepts a package name, a Git address or a local directory
path:

```text
github:LBurny/dsh-plugin#path:/dsh-zoom
```

Upgrading there is uninstall, then install the new version; the page has no auto-update, which is
what makes the pinned spec worth keeping. When GitHub is unreachable, retry with the page's
**Install source** choice: default, npm official, China mirror, or custom.

Restart dsh afterwards; plugins have no HMR. This package's browser half is served from disk on
every request, so a plain window reload is enough once dsh is up, and only a host-side change needs
the restart.

Two traps, both spelled out with their workarounds in the repository README. On Windows `dsh.cmd`
eats the `&` of the pinned form, so pin from the app's own page instead. And pnpm fetches with its
own TLS stack and ignores the system proxy, so a TLS-intercepting network needs `proxy=` and
`https-proxy=` lines in `$DSH_HOME/profiles/<profile>/.npmrc`, or a fully offline install: copy the
package into `$DSH_HOME/profiles/plugins/dsh-zoom/` and add that path.

## What it does

- **Adjust** the zoom level with a slider, and the step size used by the shortcuts.
- **Rebind** either shortcut by pressing a key: click the keycap (or *Record*) and press the
  combination you want. Escape cancels a recording. A recording stays armed until a key arrives.
- **`/zoom`** prints the current level, the range and both shortcuts.
- **The level is capped by the window height.** `zoom` on `<html>` divides the layout viewport by the
  factor, so past `window height / ~360px` the harness's own sidebar is taller than its box and its
  bottom block (设置, 意见反馈, 退出登录) is clipped with nothing to scroll: the shell sets
  `overflow: hidden` and the document never scrolls. The panel shows the cap and the level is re-clamped
  when the window shrinks. `max` stays your preference; this bound is derived per window.
- **dsh's own popups stay put.** They are portaled to `<body>` and positioned from
  `getBoundingClientRect()`, which the zoom has already multiplied, so the factor used to land on their
  inline `top`/`left` a second time: at 110% the account menu fell below the avatar with its last row off
  the window. The stylesheet cancels the factor on those surfaces and re-applies it to their contents,
  which puts their coordinates back in the viewport space dsh's arithmetic actually assumes, so both the
  placement and the viewport clamp come out right. The card's own frame, its padding and the min/max
  width bounds, stays in viewport px, so a wide menu at a high zoom wraps a little tighter than a native
  page zoom would render it.

Shortcut matching prefers `event.code` and falls back to `event.key`, so synthesized and
remote-desktop key events still work.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-zoom/client.js` `/dsh-zoom/client.css` | browser half |
| GET | `/dsh-zoom/api/settings` | current settings + the settings file path |
| POST | `/dsh-zoom/api/settings` | deep-merged settings patch |

## Data

| What | Where |
| ---- | ----- |
| Zoom level, step, bounds, both shortcuts, launcher on/off | `$DSH_HOME/dsh-zoom.json` |

This package touches nothing else: no patch layer edits, no skill directories.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-zoom"
node tests/zoom.test.mjs
```

## License

MIT.
