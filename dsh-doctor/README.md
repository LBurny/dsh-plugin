# dsh-doctor

Harness diagnostics from inside dsh, built to debug a set of plugins: **what the harness
logged**, **which rows of the plugin tree actually loaded**, and the environment facts in
between.

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
- **`/doctor`** prints the compact version: the facts, the row summary, the rows worth looking at,
  the log files, and the last ten records.

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

This plugin writes no files and edits no configuration; it only reads. Nothing leaves the machine:
the records live in a ring of 2000 entries inside the dsh process and are served on the same
origin as dsh's own UI.

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

## Caveats

- It cannot **restart** dsh: the plugin runs inside the process being restarted. Use the desktop
  shell's tray menu, or your own process manager.
- A record's `name` is the logger's name, not always the package: the loader logs every row's
  lifecycle under `loader`, and a row logs under its own module name. The filter matches on both
  the name and the text, which is why it also catches loader lines that mention a plugin.
- The live tail runs only while a floating panel is open. Inside the hub page the hub's own
  refresh is the one control, and it re-reads everything on each visit.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-doctor"
node tests/doctor.test.mjs
```

63 checks: the ring, redaction, the record store and its `since` window, the exporter attachment
(including a logger without one), the log-file tails, the loader-tree walk, and the status
document with and without its services.
