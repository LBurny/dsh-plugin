# A reusable dsh sandbox

One command brings up a real dsh with every plugin in this repository installed, for testing the
whole set together:

```bash
node tools/sandbox/sandbox.mjs up            # first run: create the profile, install all 8, boot
node tools/sandbox/sandbox.mjs up --restart  # later: reload the running instance (the usual loop)
node tools/sandbox/sandbox.mjs url           # the URL of the running instance, token included
node tools/sandbox/sandbox.mjs down          # stop it
```

It prints the ready line's URL when the instance is up, and says so if any row failed to activate.

## Why it is built this way

The slow part of a sandbox was never the boot, it was rebuilding the home: generating a profile and
installing eight packages takes minutes, and doing it per test means every run pays it again. So:

- **the home is kept**: `.sandbox/` in this repository, reused forever after the first run.
- **the packages are `link:` installs** from this working tree, so a code change needs nothing but a
  restart of the process. No reinstall, no copy step.
- **the profile is generated once** from the official app's own `web` template
  (`--from-default-profile`, which creates it and then boots it — the tool waits for the files and
  stops that first instance, whose only job was to write them).

Flags: `--port <n>` (default 25499, moves up if busy), `--profile <name>`, `--home <dir>`,
`--dsh <path to dsh.cmd>`, `--no-install`, `--restart`.

## It never touches your real dsh

The sandbox home is forced through `DSH_HOME` on every command, because without it `dsh plugin add`
writes into the user's own `~/.dsh` and says nothing about it. Two guards back that up: the tool
refuses a home outside this repository unless you pass `--allow-foreign-home`, and after installing
it re-reads the profile manifest and fails loudly if the packages are not in both `dependencies` and
`dsh.profile.bundles`.

`.sandbox/` is in `.gitignore`. It holds a whole dsh home (profiles, sessions, storages, pnpm links)
and must never be committed.

## What is inside

| Path | What it is |
| ---- | ---------- |
| `.sandbox/profiles/sandbox/` | the profile: its `package.json`, `cordis.patch.yml`, `node_modules` links |
| `.sandbox/sandbox.log` | the running instance's stdout and stderr, appended per boot |
| `.sandbox/sandbox.state.json` | port, pid, url and token of the running instance |

The pid recorded is the **port owner**, not the process this tool spawned: `dsh.cmd` is a batch
file, so what gets spawned is a `cmd.exe` wrapper that exits while dsh keeps running. `down` kills
both it and whatever holds the port.

## Driving it

The URL is a bootstrap token: dsh answers `303` to `./` and sets a cookie, so a fetch needs to carry
the cookie on the second request, while API routes accept `?token=` directly. A screenshot harness
for the UI lives in [../visual/](../visual/); `--panel <pkg>` renders one panel against fixtures
without any install.
