# Visual harness

Screenshots of the real dsh web UI, so a stylesheet change can be **looked at**
instead of inferred from computed styles. Node 22+ only — it drives the Edge/Chrome
already on the machine over the DevTools protocol; nothing to install.

```bash
RT=/f/DSHDesktop/runtime/windows-x64          # any dsh runtime with node.exe
"$RT/node.exe" "$RT/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" web --port 7411 --no-open &
# prints:  dsh web: http://127.0.0.1:7411/?token=<token>

node tools/visual/shot.mjs --url "http://127.0.0.1:7411/?token=<token>" \
     --sizes 1400x900,1000x600 --zooms 1,1.5,2 --click 继续 --name sidebar
```

Every combination of size and zoom writes `shots/<name>-z<zoom>-<w>x<h>.png` plus a
geometry report, and the console line names the one number that matters:

```
--- sidebar-z2-1400x900
    inner=900 zoom=2 titlebar=false required=214 (alt 220) ceiling=4.12 col=450 footerBottom=788
```

`required` is the height the sidebar needs in layout px (see `--tree` and the note
below), `ceiling` is `0.98 * inner / required` — the largest zoom at which the
sidebar's bottom block still fits. `FOOTER CLIPPED` means it does not.

## Options

| flag | meaning |
| --- | --- |
| `--url <url>` | dsh web URL **with its token** (required); the token is the only credential and it is per-process |
| `--out <dir>` | where PNGs and `<name>.report.json` land (default `tools/visual/shots`) |
| `--sizes <WxH,…>` | viewport sizes to shoot (default `1280x900`) |
| `--zooms <z,…>` | css zoom levels to set on `<html>` (default `1`) |
| `--titlebar on\|off\|keep` | toggles `html[data-windows-titlebar]`, which changes the sidebar's own heights |
| `--click <text>` | click the element whose trimmed text matches, before shooting (e.g. the onboarding dialog's 继续) |
| `--eval <js>` | run raw JS after the size/zoom step — the hook for reproducing a specific state |
| `--css <file>` | inject a stylesheet, to preview a fix live (repeatable) |
| `--tree` | print the sidebar column's subtree with layout heights and `flex-grow` |
| `--settle <ms>` | wait after each change (default 500) |
| `--keep` | leave the browser running for a follow-up run |

## Facts worth knowing before reading a shot

- **dsh's own chrome is what caps zoom**, not the content. `zoom` on `<html>` divides
  the layout viewport by the factor; past `window height / sidebar requirement` the
  sidebar's stack no longer fits, the shell clips it (`overflow: hidden` on the
  sidebar column) and the document never scrolls. The bottom block — 设置, 意见反馈,
  退出登录 — and the avatar menu off it then become unreachable. This is the bug
  `dsh-zoom` caps, and `required` above is the number it divides by.
- **`required` is measured, not guessed**: the sidebar column is the shell's only
  non-shrinkable stack (every child is `flex: none` except the session region, which
  collapses to zero), so forcing a deliberately oversized zoom makes `scrollHeight`
  report exactly what the column needs — in layout px, which the factor does not
  scale. `alt` is the same number summed from the column's uncompressed children;
  they should agree within the container's padding.
- **Below 1024 px of viewport width dsh auto-collapses the sidebar to a rail**
  (`SIDEBAR_AUTO_COLLAPSE` in `dsh-client-ui-layout`), and a rail needs a very
  different height. Shoot at ≥ 1400 px wide for the expanded sidebar — the one a
  desktop window has — or you will measure the rail by accident.
- **`getBoundingClientRect` reports viewport px, `scrollHeight`/`clientHeight` report
  layout px.** At zoom 2 a 50 px row reports 100. Mixing the two is the easiest way to
  get a zoom answer wrong.
- **A bare sandbox instance is a faithful host for UI work**: dsh's own sidebar and
  layout are core, so a temp `DSH_HOME` shows the real chrome — you only lose the
  plugins that are not installed in it. The harness never touches a running app.
- Zoom changes never fire `resize`, so a shot taken right after `--zooms` needs the
  settle delay; the harness sleeps for you.

Artifacts (`shots/`, `browser-profile/`) are gitignored.
