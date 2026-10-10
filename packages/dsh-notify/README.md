# dsh-notify

Task reminders inside dsh: a popup, a sound and a browser notification, for four kinds of events.

Ported from DSHDesktop, which raised Windows toasts from WinRT and played WAV files on a
self-managed `waveOut` thread. Neither exists inside dsh, so the split is: the host half subscribes
to dsh's own events and republishes them on a small SSE stream, and the browser half plays the sound
and shows the notification.

Why subscribe host-side instead of having the page connect to `/api/remote.mux`: the page would have
to replay the frame protocol (stream ids, `$events` waterflow acks, per-session `session/follow`)
that the desktop shell implements in Rust. `ctx.on(...)` host-side is far less code and far less
likely to break on a dsh upgrade — and SSE reconnects on its own.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-notify
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-notify
```

`--profile web` is DSHDesktop's shell profile; the official dsh desktop app uses `--profile desktop`
(check `$DSH_HOME/profiles/`). The plugin panel needs no profile flag.

Restart dsh afterwards — plugins have no HMR.

## The four kinds

| Kind | Raised when |
| ---- | ----------- |
| `approval` | an operation is waiting for your approval |
| `question` | a question is waiting for your answer |
| `turn_done` | a turn finished and it had used at least one tool |
| `answer_done` | a turn finished and it was a plain answer |

Subagent turns are suppressed, and a turn that did not end with `reason.kind == "completed"` is not
reported — the same rules the desktop shell applies.

Each kind has an **on/off** switch and a **timing**: *always*, or *only when this page is not focused*
(the default — no point popping a toast you are already looking at).

Channels: an in-page popup, a sound (a bundled 17-sound pack, the system default, or silent), and a
browser notification (needs permission once). Volume 0–1.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-notify/panel.js` `/dsh-notify/panel.css` | browser half |
| GET | `/dsh-notify/api/settings` | settings + the bundled sound list |
| POST | `/dsh-notify/api/settings` | deep-merged settings patch |
| GET | `/dsh-notify/api/events` | SSE reminder stream |
| GET | `/dsh-notify/api/notifications` | the last 50 reminders |
| GET | `/dsh-notify/sounds/<id>.wav` | the bundled sound pack |

## Data

| What | Where |
| ---- | ----- |
| The four rules, sound, volume, popup and browser toggles | `$DSH_HOME/dsh-notify.json` |

## Caveats

- The **sound is played by the browser** (`HTMLAudioElement`), not by a native audio thread, so the
  browser's autoplay policy can block it until you have interacted with the page. The popup and the
  system notification are unaffected.
- **Browser notifications need permission** (and a secure context — `127.0.0.1` counts as one).
- The panel must be open in some tab for reminders to be raised at all: the SSE stream lives in the
  page. Reminders are per-browser, not per-machine.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-notify"
node test/notify.test.mjs
```

## License

MIT. The WAV files under `sounds/` come from opencode via DSHDesktop and are copied as-is.
