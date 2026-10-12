# Upstream anchor probe

Does the dsh build in front of us still carry everything `dsh-remote` hangs off?

```bash
node tools/anchors/anchors.mjs                     # the app's app.asar, when it is there
node tools/anchors/anchors.mjs --asar "F:\Code\dsh\resources\app.asar"
node tools/anchors/anchors.mjs --dir "<an unpacked dsh node_modules>"
node tools/anchors/anchors.mjs --json              # machine-readable
node tools/anchors/anchors.mjs --list              # the table itself
```

Exit code **1** when a product anchor is missing, so a dsh upgrade can be gated on it. `--asar`
takes an Electron archive (read without Electron, the way [../visual/asar.mjs](../visual/) does);
`--dir` walks a dsh runtime tree, following symlinked package directories, since a linked
`node_modules` reports each link as a link rather than as its target.

## Why it exists

The phone layer degrades silently on purpose: every step that cannot find its anchor gives up and
leaves the page un-adapted but working. That is the right behaviour, and it is also why a dsh
upgrade can quietly cost the phone its UI, or cost the proxy its whole row, without a single test
going red. The suites pin this package's own strings against *fixtures* of dsh's HTML, so they keep
passing while the build moves out from under them.

This tool asks the installed build the only question that answers that, one anchor at a time, and
names what dies for each one that is gone. It reads the target and nothing else: it never writes to
it and never starts anything.

## What a line says

```
ok      [silent] _panel, _nav, _navList, _navCell, _navTitle
         in: dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js
MISSING [silent] width=device-width, initial-scale=1
         wants: dsh frontend (the SPA entry document's viewport meta)
         used by: lib/enhance.js (the iOS no-zoom viewport)
         if it is gone: iOS auto-zooms on the phone's composer and never restores
```

`partial` means some needles of one anchor went missing, which is usually a rename mid-flight.
Severities, worst first:

| severity | what a change costs |
| --- | --- |
| `row` | the plugin's mount, or the harness's boot: the failure dsh reports as one `N entries did not activate` line, with nothing pointing at this package |
| `feature` | a feature stops working outright, while the plugin still mounts and looks healthy |
| `silent` | the phone UI quietly falls back to its un-adapted shape. This is the class that is invisible without this tool |
| `note` | an internal contract between this repository's own packages, or a hint, where a miss changes little |

## What it deliberately does not cover

- **Styling-only selectors.** Twenty-odd `[class*="_x"]` names in `mobile.css` restyle dsh's chat
  rows, headers and toolbars. A rename there costs that element its phone styling, which the reader
  sees; the probe counts them in its closing line instead of carrying them in the table.
- **External tools.** `tailscale status --json`'s field names and cloudflared's manifest and log
  shapes are checked by `dsh-remote/tests/`, against their own fixtures, not here.
- **Behaviour.** A present anchor is not a working feature. The phone path itself is exercised
  through a real browser, in the procedure AGENTS.md describes.

## The closing section

`coverage:` re-reads `dsh-remote/lib` and lists every anchor-shaped literal it finds that the table
does not mention, split into behavioural ones (a warning: they belong in the table) and styling-only
class selectors (counted). The table is the one thing here that can go stale as the layer grows, and
this is what makes that visible. `--no-coverage` skips it.

## After a dsh upgrade

1. `node tools/anchors/anchors.mjs` (exit 1 means something moved).
2. Follow the phone-path procedure in AGENTS.md against the sandbox: 390x844, settings sheet, the
   injected tabs, the composer's attach button.
3. `node tools/visual/shot.mjs` for anything the stylesheet owns.
4. `node tools/hotreload/hotreload.mjs sync`, then `restart` if a host half changed.
