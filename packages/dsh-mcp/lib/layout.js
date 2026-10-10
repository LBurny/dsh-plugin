/**
 * Filesystem layout this plugin operates on.
 *
 * Derived from the profile patch document rather than from the environment:
 * `configEditor.documentPath` is `<DSH_HOME>/profiles/<name>/cordis.patch.yml`,
 * so two `dirname` calls give the active DSH home. That keeps the plugin correct
 * whether it runs under the desktop shell (DSH_HOME injected) or a bare CLI.
 *
 * @module dsh-mcp/lib/layout
 */
import { dirname } from "node:path";

/**
 * Resolve every path this plugin touches from the active profile patch document.
 * @param configEditor - the dsh config-editor service (provides `documentPath`).
 * @returns the patch document's path, the profile name and the DSH home.
 */
export function resolveLayout(configEditor) {
	const patchPath = configEditor.documentPath;
	const profileDir = dirname(patchPath);
	const profilesDir = dirname(profileDir);
	return {
		patchPath,
		profileDir,
		profilesDir,
		dshHome: dirname(profilesDir),
		profileName: profileDir.slice(profilesDir.length + 1)
	};
}
