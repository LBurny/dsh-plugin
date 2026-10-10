# dsh-doctor

Harness diagnostics from inside dsh: version, port, pid, uptime, memory, profile, and a log tail.

Ported from DSHDesktop's diagnostics page. Two log sources, best effort in this order:

1. The desktop shell's unified `events.log` (`<DSH_HOME>/../events.log`), present when this dsh runs
   under DSHDesktop — that file already holds both the shell's lines and the child dsh's stdout.
2. This plugin's own ring buffer, which always exists.

A bare `~/.dsh` setup therefore still gets a useful panel.

## Placement

With **[dsh-features](../dsh-features)** (功能管理) installed, this panel appears on that hub's single
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

## What it does

- **Status**: dsh and node versions, state, port, pid, uptime, resident memory, profile name, DSH
  home, patch document path, session count, platform.
- **Log tail**: the last 500 lines of the shell log (read through a 512 KB byte window, with the
  partial first line dropped) or of the plugin's own ring.
- **`/doctor`** prints a compact version of the same thing, ten log lines included.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-doctor/panel.js` `/dsh-doctor/panel.css` | browser half |
| GET | `/dsh-doctor/api/diagnostics` | the status document |
| GET | `/dsh-doctor/api/logs` | `{ source, path, lines }` |

## Data

Nothing. This plugin writes no files and edits no configuration; it only reads.

## Caveats

- It cannot **restart** dsh: the plugin runs inside the process being restarted. Use the desktop
  shell's tray menu, or your own process manager.
- It reports only its own plugin's actions in the ring. Other `dsh-plugin` packages keep their own
  logs; the shared `events.log` is the place to see everything at once.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-doctor"
node tests/doctor.test.mjs
```

## License

MIT.
