# dsh-mcp

Manage MCP servers from inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
add, edit, delete, enable/disable, and import from other agent tool configs.

Ported from DSHDesktop's MCP page. It edits the active profile's `cordis.patch.yml` through the
`yaml` document API — the same approach as dsh's own `dsh-config-editor` — so **your comments and
`!!js` expression tags survive**, and editing an existing server keeps the advanced keys the form
does not own (`toolCallTimeoutMs`, `reconnect`, …). Writes go through `writeFileAtomic` with the
package's file lock, serialized against the loader's hot reload.

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub — a bare dsh, or a profile where it is
not installed — the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-mcp
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-mcp
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs no flag.

Restart dsh afterwards — plugins have no HMR. Server edits themselves do *not* need a restart: dsh
hot-reloads the patch layer.

## What it does

- **List** the MCP servers in the active profile's patch layer, with transport, a one-line summary
  and enabled state.
- **Add / edit** a server: `stdio` (command, arguments, env, cwd) or `streamable-http` (url, headers).
- **Enable / disable** by setting `disabled: true` on the row.
- **Delete** a server row.
- **Import** from other agent tool configs found under `$HOME` (Claude-style `.mcp.json`,
  Codex-style TOML, …); servers whose transport this plugin cannot express are shown greyed out.
- **`/mcp`** prints the same list as text, without the browser.

## Routes

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-mcp/client.js` `/dsh-mcp/client.css` | browser half |
| GET | `/dsh-mcp/api/mcp` | servers + importable sources + counts + patch path |
| POST | `/dsh-mcp/api/mcp` | `upsert` · `toggle` · `delete` · `import` |

## Data

| What | Where |
| ---- | ----- |
| MCP servers | `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, as `insert` rows |

This package keeps no settings file of its own.

## Test

```bash
# from an installed copy (needs `yaml` and @deepseek-ai/dsh-atomic-write via the profile)
cd "$DSH_HOME/profiles/plugins/dsh-mcp"
node tests/mcp.test.mjs
```

The test guards the thing that matters: a round trip through the editor must leave every other row,
every comment and every `!!js` tag intact.

## License

MIT.
