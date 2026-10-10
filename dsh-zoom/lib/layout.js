/**
 * Filesystem layout this plugin operates on.
 *
 * Derived from the profile patch document rather than from the environment:
 * `configEditor.documentPath` is `<DSH_HOME>/profiles/<name>/cordis.patch.yml`,
 * so two `dirname` calls give the active DSH home. That keeps the plugin correct
 * whether it runs under the desktop shell (DSH_HOME injected) or a bare CLI.
 *
 * @module dsh-zoom/lib/layout
 */
import { dirname, join } from "node:path";

/** This plugin's settings file, kept next to the DSH home so it survives a reinstall. */
const CONFIG_FILENAME = "dsh-zoom.json";

/**
 * Resolve every path this plugin touches from the active profile patch document.
 * @param configEditor - the dsh config-editor service (provides `documentPath`).
 * @returns path constants plus the active profile name.
 */
export function resolveLayout(configEditor) {
	const patchPath = configEditor.documentPath;
	const profileDir = dirname(patchPath);
	const profilesDir = dirname(profileDir);
	const dshHome = dirname(profilesDir);
	return {
		patchPath,
		profileDir,
		profilesDir,
		dshHome,
		profileName: profileDir.slice(profilesDir.length + 1),
		configPath: join(dshHome, CONFIG_FILENAME)
	};
}
