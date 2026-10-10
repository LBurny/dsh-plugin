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

Restart dsh afterwards — plugins have no HMR.

## License

MIT.
