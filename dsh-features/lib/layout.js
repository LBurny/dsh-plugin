/**
 * Filesystem layout this plugin operates on.
 *
 * Derived from the profile patch document rather than from the environment:
 * `configEditor.documentPath` is `<DSH_HOME>/profiles/<name>/cordis.patch.yml`,
 * so two `dirname` calls give the active DSH home. That keeps the plugin correct
 * whether it runs under a desktop shell (DSH_HOME injected) or a bare CLI.
 *
 * @module dsh-features/lib/layout
 */
import { dirname, join } from "node:path";

/**
 * Resolve every path this plugin touches from the active profile patch document.
 * @param configEditor - the dsh config-editor service (provides `documentPath`).
 * @returns path constants plus the active profile name.
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
		profileName: profileDir.slice(profilesDir.length + 1),
		/**
		 * Hand-placed plugins (what a preseeded desktop install ships). A plugin
		 * installed with `dsh plugin add` lands in the profile's own `node_modules`
		 * instead, which is why the inventory reads both.
		 */
		pluginsDir: join(profilesDir, "plugins"),
		/**
		 * The hub's own data file. In DSH_HOME, not in the profile, because the
		 * reader's feature order is theirs, not the profile's — and because the phone
		 * reaches the same dsh through the proxy and must see the same order.
		 */
		orderPath: join(dirname(profilesDir), "dsh-features.json")
	};
}
