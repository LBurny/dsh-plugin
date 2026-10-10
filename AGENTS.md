# dsh-plugin — notes for agents

A collection of independent dsh plugins, one feature per package. Read this before changing
anything here; it is short and most of it is a trap someone already walked into.

## Shape

- `packages/<name>/` is a **complete, standalone dsh plugin**. Nothing may import from a sibling
  package — that is the whole point of the split. Shared helpers are duplicated on purpose.
- Each package ships the three-file core (`package.json` with `dsh.bundle.patch`, `cordis.patch.yml`,
  `index.js`) plus `lib/` (host logic), `assets/` (browser half, plain DOM, no build step),
  `locale/` (bilingual name/description for dsh's plugin management page) and `test/`.
- The package name is the npm name; the module's exported `name` and the patch row `id` are the short
  name (`dsh-skills` → `skills`). Row ids are first-come, first-served across the whole plugin tree.

## Rules that are easy to get wrong

- **`package.json` must declare `dsh.bundle.patch`.** Without it `dsh plugin add` installs the package
  as a plain dependency and mounts no layer — the symptom is silence, not an error. This happened
  during the split; `--dump-config` is how you catch it.
- **A module-level failure takes the whole plugin tree down** — dsh will not start at all. Verify in a
  sandbox (`$TEMP\dshprobe`, see `DSHPlugin/.agents/skills/dsh-plugin-authoring/references/repo-delivery.md` §4)
  before touching a real `DSH_HOME`.
- **The browser halves share exactly two things, both DOM-level:** the `#dsh-launchers` corner
  container and the `--dsh-launcher-stack` custom property, plus the `.dsh-launch` button class whose
  styles are duplicated identically in every `panel.css`. Panel styles are scoped under
  `#<package>-root` so six stylesheets cannot fight. Keep both properties when adding a package.
- **A package's own routes must not collide with the remote proxy's project routes.** The proxy
  forwards a request to dsh unless it claims it, so anything under the proxy's project prefixes is
  invisible to the page. That is why the project browser lives under
  `/dsh-remote/project/api/*` while this plugin's own API is `/dsh-remote/api/*`.
- **Command registration is guarded** (a name clash degrades to a warning). Do not "fix" that by
  registering unguarded: an exception during `apply` kills dsh.
- Never log a remote link or token; `/dsh-remote/api/status` exists precisely so there is a
  credential-free status.

## Test

Offline suites need `@deepseek-ai/*` (and `yaml` for dsh-mcp) to resolve. Either run them from an
installed copy, or create junctions in the package's `node_modules` pointing at the runtime's
packages. Then:

```bash
cd packages/<name> && node test/<name>.test.mjs
```

Verification is per package and the totals are in the root README. Two things are worth re-checking
after any change: all six installed **together** still boot (`--dump-config` then `web --port N
--no-open`, and look for the ready line), and dsh-remote's live suite
(`node test/remote-live.mjs <baseUrl> <proxyPort> <token>` against a sandbox with remote access on).

## Not here

`dsh-desktop-kit` in the DSHPlugin repository is the original single-package version; this repository
is the per-feature split. Language/theme following, page-error reporting and the `/init` fallback
were dropped in the split — see the root README for why.
