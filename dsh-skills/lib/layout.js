/**
 * Filesystem layout this plugin operates on.
 *
 * Everything is derived from the profile patch document rather than from the
 * environment: `configEditor.documentPath` is `<DSH_HOME>/profiles/<name>/cordis.patch.yml`,
 * so two `dirname` calls give the active DSH home. That keeps the plugin correct
 * whether it runs under the desktop shell (DSH_HOME injected) or a bare CLI.
 *
 * @module dsh-skills/lib/layout
 */
import { dirname, join } from "node:path";

/** Skill root that dsh's filesystem provider scans as `user-dsh` (rank 400). */
const SKILLS_DIRNAME = "skills";
/** Bypass root disabled skills are moved into; dsh does not scan it. */
const SKILLS_DISABLED_DIRNAME = "skills-disabled";

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
		skillsDir: join(dshHome, SKILLS_DIRNAME),
		skillsDisabledDir: join(dshHome, SKILLS_DISABLED_DIRNAME)
	};
}
