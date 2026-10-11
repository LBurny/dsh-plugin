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

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub — a bare dsh, or a profile where it is
not installed — the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-notify
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-notify
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs no flag.

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

The first two are Cordis **waterfalls**, and that is where this plugin is easy to get wrong. A
waterfall listener that does not call `next()` vetoes the rest of the chain, and the window answers
through the very same waterfall: `@deepseek-ai/dsh-api-remotes` forwards the request to the connected
clients and returns their answer. It is registered before any profile bundle is loaded, so a listener
that merely observes the request has to register with `prepend` or it is never called — an attached
window silently swallows every approval and question, while the turn reminders (a plain emit, where
every listener runs) keep arriving and look like proof that the plugin works. Announcing and passing
control on is all this plugin does; the window still owns the decision.

Each kind has an **on/off** switch and a **timing**: *always*, or *only when this page is not focused*.
The two kinds that block the agent (`approval`, `question`) default to *always*, because a focused
window is usually showing another session and a missed approval costs a stalled agent. The two
completion kinds (`turn_done`, `answer_done`) default to the background, where there is no point
popping a toast you are already looking at.

Channels: an in-page popup, a sound (a bundled 17-sound pack, the system default, or silent), and a
browser notification (needs permission once). Volume 0–1. Clicking the notification raises the
window that shows the harness: the page asks the host half, because `window.focus()` is a no-op for
a window the OS has not already focused and the desktop app exposes no IPC for it. The host runs as
a child of the process that owns the window, walks up that chain and asks Windows to activate it,
with the topmost round trip as a fallback when the foreground rule refuses.

Only one of them makes a noise. A system notification sounds off its own on Windows, so it is raised
silent whenever the sound above is one of the bundled files or silent; the "system default" choice is
the one that leaves the noise to the OS.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-notify/client.js` `/dsh-notify/client.css` | browser half |
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
node tests/notify.test.mjs
```

## License

MIT. The WAV files under `lib/sounds/` come from opencode via DSHDesktop and are copied as-is.
