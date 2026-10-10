# dsh-plugin

One feature, one plugin. Small, independent [dsh](https://github.com/deepseek-ai/deepseek-harness)
plugins — install only the ones you want, each works alone. All ported from
[DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)'s convenience layer; no desktop
shell, no Tauri, no extra process.

| Package | What it does | Command |
| ------- | ------------ | ------- |
| `dsh-skills` | Skills: enable / disable / delete / import, incl. local ZIP | `/skills` |
| `dsh-mcp` | MCP servers: add / edit / delete / enable / import | `/mcp` |
| `dsh-doctor` | Diagnostics: status, environment, log tail | `/doctor` |
| `dsh-zoom` | Page zoom with rebindable shortcuts | `/zoom` |
| `dsh-notify` | Task reminders: popup + sound + browser notification | `/notify` |
| `dsh-remote` | Phone remote access: authenticated proxy, QR, tunnel, mobile UI, project browser | `/remote` |

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-skills
# pin a commit: github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` is DSHDesktop's shell profile; the official desktop app uses `--profile desktop`.
Restart dsh afterwards — plugins have no HMR. The plugin panel accepts the same specs, one at a time.

**pnpm cannot reach github.com?** It uses its own TLS stack and ignores the system proxy, so a
network that intercepts TLS fails with `TypeError: fetch failed`. Give it a
`$DSH_HOME/profiles/<profile>/.npmrc`:

```
https-proxy=http://127.0.0.1:7890
proxy=http://127.0.0.1:7890
```

Or install with no network at all: copy a package into `$DSH_HOME/profiles/plugins/<name>/` and
paste its absolute path into the panel.

## Conventions

- The six packages **never import each other**; each duplicates the layout/HTTP helpers it needs.
- The only cross-package agreement is DOM-level: the `#dsh-launchers` corner container and the
  `--dsh-launcher-stack` property.
- Panels are bilingual from `navigator.language` and follow `prefers-color-scheme`; they do **not**
  read dsh's `locale`/`ui-theme` (that would mean parsing the profile patch in every package).

See [AGENTS.md](AGENTS.md) for the traps.

## Test

```bash
cd packages/<name> && node test/<name>.test.mjs
```

Offline checks: 47 / 20 / 23 / 23 / 38 / 73. `dsh-remote` also has a live suite
(`test/remote-live.mjs`, needs a sandbox instance).

## License

MIT. Sounds under `packages/dsh-notify/sounds/` come from opencode via DSHDesktop; the mobile assets
under `packages/dsh-remote/assets/` are vendored from DSHDesktop.
