# Hot reload into the installed app

Edit this working tree and see it in the **installed** DeepSeek Harness app, without a manual copy
and without restarting by hand:

```bash
node tools/hotreload/hotreload.mjs up               # mirror, enable the module watch, watch here
node tools/hotreload/hotreload.mjs up --background  # same, detached, into .hotreload/<target>.log
node tools/hotreload/hotreload.mjs status           # is it watching, and are the copies in sync
node tools/hotreload/hotreload.mjs sync             # mirror once and exit
node tools/hotreload/hotreload.mjs down             # stop watching, remove the block it wrote
node tools/hotreload/hotreload.mjs restart          # quit and relaunch the app
```

Flags: `--home <dir>` (default `$DSH_HOME` or `~/.dsh`), `--profile <name>` (default `desktop`),
`--packages a,b`, `--app <exe>`, `--interval <ms>` (default 600), `--no-restart`, `--dry-run`.

## What is hot, and what is not

Measured 2026-10-11 against the app's own runtime (dsh 0.2.0-rc.2; the app runs its dsh in a
`dsh-desktop-host` child process that owns the web port, 19387 by default).

**A `client.js` (or `client.css`) edit is live by itself.** `@deepseek-ai/dsh-web-app` mounts
`@deepseek-ai/dsh-client-hmr`, which every 500ms stats each graph row's bundle, recomputes its rev and
pushes a `rebuilt` frame over `/plugins/events`; the browser applies the new bundle in place. The
panel that was open is dropped when the module is re-registered, so reopen it. Nothing else is needed:
no restart, no page reload. Verified on the running app by watching that SSE channel while the tool
mirrored an edited file into the install (two `rebuilt` frames, one per edit and one for the revert).

**A host-half (`lib/index.js`, `lib/updates.js`, `cordis.patch.yml`) edit restarts the app.**
`@deepseek-ai/dsh-base` mounts `@deepseek-ai/dsh-hmr` with `root: []` ("Profile configuration reloads
by default; module roots are opt-in"), and the service will not construct without Node internals:
`cordis-plugin-loader` sets `loader.internal` only when `process.execArgv` contains
`--expose-internals`. The app's launcher passes no such flag, so as launched for you that row can only
reload profile config. To give it a chance, the tool writes the opt-in block into the target profile's
patch and `restart` relaunches the app with that flag: after that the row does log
`watching [ 'node_modules/dsh-doctor', ... ]`, which it never does otherwise.

It still reloads nothing there. The block was proven correct three ways in the app. Roots as absolute
paths did not watch at all; roots relative to the loader's own base did not either; an explicit
`base` had to be a **file URL** (`fileURLToPath(new URL(base, ctx.baseUrl))` is what dsh runs, so a
Windows path becomes an `h:` URL and the row dies with `ERR_INVALID_URL_SCHEME`, visible only as a
`did not activate` line in the app's log). With the file URL in place the watch installed and the
reload never came: a module write, then ten seconds of polling `/dsh-features/api/status`, still
answered with the old version string. The same block on the same runtime under a CLI launcher (the
sandbox) does reload in place, so the difference is the launcher, not the config.

The tool therefore restarts the app on a host change, debounced, and says so in its log. The restart
takes about four seconds. `--no-restart` turns it off, which is what a target other than the app's own
profile wants (`tools/sandbox/README.md` shows that invocation).

Two consequences of the restart are worth knowing: the app's window goes away and comes back, and
`dsh-remote` re-mints its tunnel link.

## How it mirrors

The app installs a plugin as a pnpm git tarball at one commit, so
`<home>/profiles/<profile>/node_modules/dsh-*` is a plain copy of a published commit and editing this
working tree changes nothing it can see. The tool walks each package, copies every file whose content
differs (size first, then bytes, never timestamps), and deletes files the source no longer has, so a
removed module cannot keep loading. A package the profile installed from a local path is a junction
onto the source already: it is left alone.

A pnpm operation in that profile (`plugin add/remove`, or the hub's own 更新 button) replaces those
copies with the published package again. The tool notices on its next tick and mirrors them back, but
the setup itself (`--link` installs aside) is worth re-checking with `status` after any of those.

## What it changes outside this repository

- `<home>/profiles/<profile>/node_modules/dsh-*`: the mirrored files.
- `<home>/profiles/<profile>/cordis.patch.yml`: one marked block (`# >>> dsh-hotreload >>>` .. `# <<<`)
  carrying the `hmr` module roots. Every other entry in that file is left exactly as it was, `down`
  removes the block again, and the tool refuses to touch a hand-written `hmr` entry.
- `.hotreload/` in this repository (gitignored): one state file and one log per target, named after
  the target (`C-Users-intel-dsh-desktop.log` for the default home and profile), so a sandbox run and
  the app run do not overwrite each other.

## Verifying the loop yourself

```bash
# 1. the mirror is live: the hub answers with this working tree's code
curl -s http://127.0.0.1:19387/dsh-features/api/status

# 2. the client half is hot: watch the rebuild frames while you edit a client.js
curl -N http://127.0.0.1:19387/plugins/events

# 3. the host half is restarted: edit a lib/*.js and watch the tool's log
tail -f .hotreload/C-Users-intel-dsh-desktop.log
```
