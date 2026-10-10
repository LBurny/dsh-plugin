# dsh-skills

Manage [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) skills from inside dsh:
list, enable/disable, delete, and import — including from a local ZIP archive.

Ported from DSHDesktop's skills page. The desktop shell moved skill directories around from a Tauri
command; this does the same inside the dsh process, so dsh's own file watcher picks the change up
without a restart.

## Placement

With **[dsh-features](../dsh-features)** (the Features hub) installed, this panel appears on that hub's single
page and no longer docks its own corner button; without the hub — a bare dsh, or a profile where it is
not installed — the floating panel is built exactly as before. The coupling is two DOM-level
conventions (`window.__dshFeatures`, `#dsh-launchers`), described in the repository's AGENTS.md.

## Install

```bash
dsh plugin --profile web add github:LBurny/dsh-plugin#path:/dsh-skills
# pin a commit:
dsh plugin --profile web add github:LBurny/dsh-plugin#<sha>&path:/dsh-skills
```

`--profile web` = DSHDesktop's shell, `--profile desktop` = the official desktop app; the panel needs no flag.

Restart dsh afterwards — plugins have no HMR.

## What it does

- **List** the skills dsh can see, with their enabled state and description.
- **Enable / disable** by moving the skill directory between `$DSH_HOME/skills/` (scanned by dsh's
  filesystem provider) and `$DSH_HOME/skills-disabled/` (not scanned). A directory counts as a skill
  when it contains `SKILL.md`.
- **Delete** a skill from either root.
- **Import** from other agent tool roots (Claude / Codex style skill directories, greying out the
  ones that are absent), or from a **local ZIP archive**. Source directories are commonly symlink
  farms (one shared checkout linked into every tool), so a symlinked entry counts as a skill and is
  copied as real files rather than re-linked. The ZIP reader only reads the central directory,
  supports stored and deflate entries, and enforces entry/size caps plus traversal rejection; a pack
  may hold one skill (`SKILL.md` at the archive root) or many (`<dir>/SKILL.md`).
- **`/skills`** prints the same list as text, without the browser.

A skill's toggle takes effect through dsh's watcher, so no restart is needed. The panel appears in
the corner of the dsh web UI, next to any other dsh-plugin packages you have installed.

## Routes

Everything hangs off `/dsh-skills` and is protected by dsh's own origin gate.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/dsh-skills/panel.js` `/dsh-skills/panel.css` | browser half |
| GET | `/dsh-skills/api/skills` | skills + importable sources + counts |
| POST | `/dsh-skills/api/skills` | `toggle` · `delete` · `import` · `import-zip` |
| POST | `/dsh-skills/api/skills/zip` | ZIP import step 1: upload (≤64 MiB), get discovered skills + an upload id |

The upload is held in memory between the two steps (10 min TTL, at most 4 at a time) and consumed by
the import.

## Data

| What | Where |
| ---- | ----- |
| Skills (enabled) | `$DSH_HOME/skills/` |
| Skills (disabled) | `$DSH_HOME/skills-disabled/` |
| Import sources | other agent tool roots under `$HOME` (read-only) |

This package writes nothing else — no settings file, no patch layer edits. Its only dependency is
`node:` itself.

## Test

```bash
# from an installed copy (the host half resolves @deepseek-ai/* via the profile)
cd "$DSH_HOME/profiles/plugins/dsh-skills"
node tests/skills.test.mjs
```

## License

MIT.
