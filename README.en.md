# dsh-plugin

One feature, one plugin. Small, independent [dsh](https://github.com/deepseek-ai/deepseek-harness)
plugins — install only the ones you want, each works alone.

Everything here was carved out of [DSHDesktop](https://github.com/LBurny/deepseek-harness-desktop)'s
convenience layer (a Tauri window shell) so the same features exist inside dsh itself.

| Package | What it does | Command |
| ------- | ------------ | ------- |
| `dsh-skills` | Manage skills: enable / disable / delete / import, plus local ZIP import | `/skills` |
| `dsh-mcp` | Manage MCP servers in the active profile's patch layer | `/mcp` |
| `dsh-doctor` | Harness diagnostics: version, port, pid, profile, log tail | `/doctor` |
| `dsh-zoom` | Page zoom with rebindable shortcuts | `/zoom` |
| `dsh-notify` | Task reminders: popup + sound + browser notification | `/notify` |
| `dsh-remote` | Phone remote access: authenticated reverse proxy, QR link, optional tunnel, mobile UI and project browser | `/remote` |

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/packages/dsh-skills
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/packages/dsh-skills
dsh plugin --profile web remove dsh-skills
```

`--profile web` is DSHDesktop's shell profile; the official dsh desktop app uses `--profile desktop`
(check `$DSH_HOME/profiles/`). The plugin panel needs no profile flag.

Restart dsh afterwards — plugins have no HMR.

### When GitHub is not reachable

A `github:` spec makes pnpm fetch from `github.com` with **its own TLS stack** — not the system
certificate store, and not the `git` binary. On a network that intercepts TLS for `github.com` the
install fails with `TypeError: fetch failed` from pnpm, even though `git ls-remote` on the same URL
works. Either give pnpm a proxy (`.npmrc` next to the profile: `https-proxy=` / `proxy=`), or install
from a local path: copy the package into `$DSH_HOME/profiles/plugins/<name>/` and paste the absolute
path into the plugin panel. See the Chinese README for the full explanation.

## License

MIT.
