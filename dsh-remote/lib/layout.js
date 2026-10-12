/**
 * Filesystem layout this plugin operates on.
 *
 * Derived from the profile patch document rather than from the environment:
 * `configEditor.documentPath` is `<DSH_HOME>/profiles/<name>/cordis.patch.yml`, so three
 * `dirname` calls give the active DSH home. That keeps the plugin correct whether it runs
 * under the desktop shell (DSH_HOME injected) or a bare CLI, without depending on an
 * environment variable having been passed through.
 *
 * The shape of that document is dsh's to change, and if it changes every path below moves
 * with it: the settings, the session record and the tunnel log would be written next to
 * some unrelated directory, and the phone's project browser would look for a workspace
 * store that is not there. So the shape is checked first, and when it does not hold the
 * DSH_HOME dsh itself was launched with is used instead: that is the same home by
 * definition, and it is what the desktop shell injects.
 *
 * @module dsh-remote/lib/layout
 */
import { basename, dirname, join } from "node:path";

/** This plugin's settings file, kept next to the DSH home so it survives a reinstall. */
const CONFIG_FILENAME = "dsh-remote.json";
/** The profile patch document the derivation keys on (dsh's own file name). */
const PATCH_FILENAME = "cordis.patch.yml";

/**
 * Resolve every path this plugin touches from the active profile patch document.
 * @param configEditor - the dsh config-editor service (provides `documentPath`).
 * @param env - environment to fall back on; injectable for tests.
 * @returns path constants plus the active profile name.
 */
export function resolveLayout(configEditor, env = process.env) {
	const patchPath = configEditor?.documentPath;
	if (typeof patchPath !== "string" || patchPath === "") {
		// Refuse loudly rather than deriving "." from nothing and writing this plugin's
		// files into whatever the process happens to have as its working directory.
		throw new Error("configEditor.documentPath is not a path");
	}
	const profileDir = dirname(patchPath);
	const profilesDir = dirname(profileDir);
	const derivedHome = dirname(profilesDir);
	const shaped = basename(patchPath) === PATCH_FILENAME && basename(profilesDir) === "profiles";
	const fromEnv = typeof env?.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? env.DSH_HOME.trim() : undefined;
	const rebased = shaped || fromEnv === undefined;
	const dshHome = rebased ? derivedHome : fromEnv;
	return {
		patchPath,
		profileDir,
		profilesDir: rebased ? profilesDir : join(dshHome, "profiles"),
		dshHome,
		profileName: profileDir.slice(profilesDir.length + 1),
		configPath: join(dshHome, CONFIG_FILENAME),
		/**
		 * The live-session record (which tunnel is ours, where it points, which binary
		 * runs it). It is what lets a restart adopt the running tunnel, so the link a
		 * phone already holds stays byte-identical — see `lib/session.js`.
		 */
		sessionPath: join(dshHome, "dsh-remote-session.json"),
		/**
		 * cloudflared's own output. A detached tunnel writes here instead of into this
		 * process's pipes, so it survives our exit instead of dying on a broken pipe.
		 */
		tunnelLogPath: join(dshHome, "dsh-remote-tunnel.log"),
		/**
		 * dsh's workspace store (`tables.workspaces[*] = {path, title, sessionIds[]}`),
		 * read by the phone-side project browser to map a session to its workspace.
		 */
		workspaceStorePath: join(dshHome, "storages", "workspace.json")
	};
}
