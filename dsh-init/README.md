# dsh-init

The `/init` command: write or update this workspace's `AGENTS.md`, the instruction file dsh injects
into every future session in that workspace.

Ported from the `/init` plugin DSHDesktop preseeded into its own profile, with the prompt kept as it
was: it spells out how this harness actually loads instruction files, so the generated file follows
the real rules instead of generic advice.

## What it does

`/init [extra instructions]` submits one prompt to the agent and returns immediately. The agent then
reads the workspace, and creates or incrementally updates `AGENTS.md` at the workspace root, guided
by:

- the whole loading chain this harness uses: `AGENTS.md` and `CLAUDE.md` at the root, the
  `*.local.md` personal overlays, nested files that outrank the root one for work under their
  directory, and the user-global `~/.dsh/AGENTS.md` it must **not** touch;
- what to write: purpose and layout, the real build/test/lint commands, architecture boundaries,
  conventions, and the gotchas a newcomer trips over;
- what not to write: anything obvious from a quick look at the repo, and anything long, since the
  file enters the context of every session.

Text typed after the command rides along as extra instructions, which is how you steer it ("keep it
under 40 lines", "the build command needs `--frozen-lockfile`").

The prompt arrives as a **collapsed context row** in the transcript, not as a long user message. A
command may only return one line of text, so the prompt is queued on the agent's next turn with a
producer-owned message source; that is also what keeps `/init` readable rather than a wall of orange.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-init
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app.

Restart dsh afterwards, since plugins have no HMR.

## Name ownership

`init` is a first-come, first-served command name, and two other things claim it:

- **DSHDesktop's built-in `dsh-command-init`**, preseeded into the shell's own profile. If both are
  installed, dsh registers whichever loads first, warns, and deactivates the other. Pick one.
- **`dsh-desktop-kit`'s fallback**, which only registers when its row sets `provideInit: true`. Do not
  turn that on next to this package either.

This package logs a line instead of throwing when the name is already taken, because an exception
during `apply` would take the whole plugin tree down.

## Panel

None. It is a command, not a feature: there is nothing to display, so it declares no
`dsh.ui.feature` marker and the **[dsh-features](../dsh-features)** hub does not list it. That matches
the built-in it was ported from.

## Test

```bash
cd "$DSH_HOME/profiles/plugins/dsh-init"
node tests/init.test.mjs
```

The suite checks the registered command, the shape of what it injects, that no `undefined` leaks into
the prompt, and, where `@deepseek-ai/dsh-session-format-v3-to-v4` is resolvable, that the runtime's
own V4 admission **accepts** the submitted message, with a negative fixture proving the probe can
fail. That is the regression worth guarding: a retired message source registers fine, does nothing,
and fails the whole turn.

## License

MIT.
