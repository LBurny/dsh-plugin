# dsh-doctor

Harness diagnostics from inside dsh, built to debug a set of plugins: **what the harness
logged**, **which rows of the plugin tree actually loaded**, the environment facts in
between, and **the patches this suite applies to the running harness**.

Why it works this way: a green boot does not prove a plugin loaded. dsh prints one
`warning: N entries did not activate` line and then starts and serves as usual, so the ready
line cannot answer "did my plugin load?". And on the official desktop app there is no log file
to tail at all: the child dsh's stdout goes to the Electron process and its stderr lives in a
64 KiB in-memory buffer.

## What it shows

- **Status**: dsh and node versions, state, port, pid, uptime, resident memory, profile name, DSH
  home, patch document path, session count, platform, and whether the log capture is attached.
- **Plugin rows**: every row of the loader tree, with its id, package, and activation state
  (`active`, `failed`, `not-loaded`, ...), flagging the disabled ones and the seven ids
  `dsh-app-boot` refuses to lose (the `requiredRowIds` in the status document). Failed rows and this
  suite's own packages sort first, because a shipped profile has around two hundred rows.
- **Log**: the harness's own records, every module's, with a level filter, an "our plugins only"
  filter, a text filter and a copy button. While the panel is open it appends new records every
  three seconds through `GET /dsh-doctor/api/logs?since=<sn>`.
- **Log files**: whichever of these exist, folded away, since they are a fallback rather than the
  view: the desktop shell's unified `events.log`, dsh's own `logs/startup-*.log` (written only when
  a required row failed to activate), `dsh-remote`'s tunnel log, and the app's crash report.
- **Environment patches**: the corrections this suite makes to the dsh it runs inside, each one with
  a switch and a delete control, so a fix can be taken back at any time. See **Patches** below.
- **`/doctor`** prints the compact version: the facts, the row summary, the rows worth looking at,
  the log files, and the last ten records.

## Patches

A patch is a correction to the process this plugin runs in, for a defect a plugin cannot fix by
writing a file. There is one.

**`electron-run-as-node`** drops `ELECTRON_RUN_AS_NODE` from the harness's own environment. The
official desktop app starts its harness host as the Electron executable in Node mode (`lib/main.js`'s
`desktopNodeEnvironment`, used by `DesktopHostProcess.start`), so that variable sits in the host's
environment. The harness scrubs a child environment of credential-shaped names and of `DSH_*`, which
leaves it in place, so every application the open-in-app feature launches inherits it. An Electron
editor (VS Code, Cursor, Windsurf) then starts as plain Node, is handed the workspace folder as a
script, and exits non-zero, which dsh reports as `failed to launch <app>` and the button shows as
打开失败，请重试. The file managers are unaffected, because `explorer.exe` is not Electron.

Dropping the name is what dsh itself does where it matters: `dsh-ptc-runtime-node` filters it out of
the environment it builds for its child, and the two places that genuinely want Electron in Node mode
(the desktop host's package manager, the GitHub Desktop adapter) set it explicitly for that child
instead of inheriting it. The variable is only read at process start and nothing in the harness reads
it back, so removing it cannot change how dsh itself runs.

Decisions live in `<DSH_HOME>/dsh-doctor.json`:

```json
{ "patches": { "electron-run-as-node": { "enabled": false } } }
```

An entry is written only when a patch is switched off (`{ "enabled": false }`) or deleted
(`{ "removed": true }`), so the default is the absence of an entry and the file stays readable by
hand. Deleting the file brings the whole catalog back, which is also how a deleted patch returns:
the list has no add control, like the skills page's. A patch is applied as soon as the plugin loads,
and the file corrects that a moment later, so the fix is in force before anything is spawned.

The switch is honest about where it cannot help: on a bare CLI harness (and in the sandbox) the
variable is never set, and the row says so instead of offering a fix that changes nothing.

## How the log is read

`ctx.logger` is cordis's logger service, and `logger.exporter({ levels, export })` is its public
extension point: every record is fanned out to each registered exporter, for every plugin in the
process. `dsh-app-boot` registers one itself for its startup audit. This plugin registers a second
and keeps the records in a ring, redacted on the way in (a URL `token=`, an `Authorization`
value, a `*.trycloudflare.com` link), because this panel must never surface a credential.

It also snapshots `logger.buffer` at attach time, the service's own last-1000-record buffer, which
is the boot history. In practice that is thin: dsh writes little through the logger before the
plugins load.

What this cannot see: `did not activate`, `startup failed` and `skipping profile bundle` are
`process.stderr.write` calls and a thrown error in `dsh-app-boot`, not logger records. The row
state covers the same ground (`failed` / `not-loaded`), and `<DSH_HOME>/logs/startup-*.log` holds
the full report of the fatal case.

## Data

Apart from `<DSH_HOME>/dsh-doctor.json` (the patch decisions above) this plugin writes no files and
edits no configuration; the rest of what it does is reading. Nothing leaves the machine: the records
live in a ring of 2000 entries inside the dsh process and are served on the same origin as dsh's own
UI.

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub — a bare dsh, or a profile where it is
not installed — the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-doctor
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-doctor
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs no flag.

Restart dsh afterwards — plugins have no HMR.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-doctor/client.js` `/dsh-doctor/client.css` | browser half |
| GET | `/dsh-doctor/api/diagnostics` | the status document, the plugin rows and the log-file list |
| GET | `/dsh-doctor/api/logs` | `{ source, records, files, reset }`; add `?since=<sn>` for only what is newer |
| GET | `/dsh-doctor/api/patches` | `{ configPath, patches }`, each patch with its id, variable, state and whether this process carries it |
| POST | `/dsh-doctor/api/patches` | `{ action: "toggle", id, enabled }` or `{ action: "delete", id }`, then the new list |

## Caveats

- It cannot **restart** dsh: the plugin runs inside the process being restarted. Use the desktop
  shell's tray menu, or your own process manager.
- A record's `name` is the logger's name, not always the package: the loader logs every row's
  lifecycle under `loader`, and a row logs under its own module name. The filter matches on both
  the name and the text, which is why it also catches loader lines that mention a plugin.
- The live tail runs only while a floating panel is open. Inside the hub page the hub's own
  refresh is the one control, and it re-reads everything on each visit.
- A patch applies to the process it loads in: a program that was already running stays as it is,
  and the next dsh start applies the same decisions from the same file. A patch that is switched
  off puts the environment back the way that process found it, so nothing is left in a third state.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-doctor"
node tests/doctor.test.mjs
```

98 checks: the ring, redaction, the record store and its `since` window, the exporter attachment
(including a logger without one), the log-file tails, the loader-tree walk, the status document with
and without its services, and the patch catalog end to end (the decisions file, normalization, and an
environment that has the variable, one that never did, and one where a patch is withdrawn again).
