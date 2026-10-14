/**
 * The one dsh child the `electron-run-as-node` patch is wrong for.
 *
 * `dsh-host-directory-picker-native` opens the OS folder chooser in a worker process it
 * spawns as `process.execPath` with `env: { ...process.env }` and no mention of Node mode
 * (`spawnDialogWorker`). In the desktop app `process.execPath` is the Electron binary
 * itself, so that worker starts as Node only because `ELECTRON_RUN_AS_NODE` is inherited.
 * With the variable dropped the child boots a second copy of the desktop app instead,
 * loses the single-instance lock, quits, and the pick answers
 * `win32 folder dialog worker exited before reporting a result`.
 *
 * Only a browser that is not the app's own window ever gets there: the app's window
 * carries `__DSH_DIRECTORY_PICKER__` from the preload (`lib/preload-app.cjs`) and picks
 * through Electron, so this is a phone or a LAN browser asking the host for a chooser.
 *
 * Two consumers want opposite things from one process-wide variable and dsh reads its
 * environment when it spawns, so no environment-only patch can serve both. The correction
 * therefore sits on the one seam a plugin can reach: the mounted picker's capability
 * object, which `dsh-api-workspace-controller` resolves again through
 * `ctx.directoryPicker.capability()` on every call. The variable is lent for the call's
 * synchronous prefix, which is where `pickWin32Directory` spawns its worker, and taken
 * back in the same tick, so no other child can be spawned inside that window.
 *
 * @module dsh-doctor/lib/picker-worker
 */
import { RUN_AS_NODE } from "./patches.js";

/** Marks a wrapped `pick` (and a wrapped `capability`) so a second attach cannot wrap it twice. */
const MARK = "__dshPickerWorkerMode";

/** One phrase for what a candidate service looked like, for the log line about not wrapping it. */
function describe(service) {
	if (service === undefined || service === null) return "no service mounted";
	if (typeof service.capability !== "function") return `capability is ${typeof service.capability}`;
	return "its capability is already wrapped";
}

/**
 * Wrap a directory-picker service so its next pick can still start the dialog worker.
 * @param patches - the patch runtime, which knows whether the variable is ours to lend.
 * @param options - `env` to lend to (this process's own by default) and an optional `log`,
 *   because a wrap that stopped matching the seam has to say so instead of failing quietly.
 * @returns `{ attach(service) }`, where attach returns the disposer that puts the service back.
 */
export function createPickerWorkerNode(patches, options = {}) {
	const env = options.env ?? process.env;
	const log = options.log ?? (() => {});
	/**
	 * Call the backend's pick with the variable in place, and restore the environment in
	 * the same tick. The worker is spawned synchronously inside `original`, before the
	 * promise it returns is awaited, so the window is a few instructions wide; anything
	 * spawned later (an editor, another pick) sees the environment the patch left.
	 * @param original - the backend's own pick.
	 * @param signal - caller lifetime.
	 */
	function lend(original, signal) {
		// With the patch off, or in a process that never carried the variable, the environment
		// is exactly as this process found it and there is nothing to correct.
		if (!patches.applied(RUN_AS_NODE.id)) {
			log(`picker worker: ${RUN_AS_NODE.variable} is not ours to lend, the pick runs on the environment as found`);
			return original.call(this, signal);
		}
		const had = Object.prototype.hasOwnProperty.call(env, RUN_AS_NODE.variable);
		const before = env[RUN_AS_NODE.variable];
		env[RUN_AS_NODE.variable] = patches.carried(RUN_AS_NODE.id) ?? "1";
		log(`picker worker: lent ${RUN_AS_NODE.variable} for one pick`);
		try {
			return original.call(this, signal);
		} finally {
			if (had) env[RUN_AS_NODE.variable] = before;
			else Reflect.deleteProperty(env, RUN_AS_NODE.variable);
		}
	}

	/**
	 * Put the wrap on one mounted picker. The service's own `capability()` is what the
	 * controller calls, so wrapping it covers whatever object the backend hands out, and
	 * the object itself is edited in place because the seam promises it is stable for the
	 * service's lifetime.
	 * @param service - the mounted `ctx.directoryPicker` service, if this profile mounts one.
	 * @returns the disposer that restores the service, or undefined when there was nothing to wrap.
	 */
	function attach(service) {
		const capability = service?.capability;
		if (typeof capability !== "function" || capability[MARK] === true) {
			log(`picker worker: nothing to wrap on ctx.directoryPicker (${describe(service)})`);
			return undefined;
		}
		const wrapped = function (...args) {
			const current = capability.apply(this, args);
			if (current !== null && typeof current === "object" && current[MARK] !== true) {
				const pick = current.pick;
				if (typeof pick === "function" && pick[MARK] !== true) {
					const lent = function (signal) {
						return lend.call(this, pick, signal);
					};
					lent[MARK] = true;
					// A frozen capability object would leave the pick unwrapped rather than break it.
					try {
						current.pick = lent;
						log(`picker worker: wrapped the "${String(current.kind)}" capability's pick`);
					} catch {
						/* sealed capability: the pick keeps working, without the correction */
					}
				}
				try {
					current[MARK] = true;
				} catch {
					/* sealed capability: harmless, it only stops a second attach from re-walking it */
				}
			}
			return current;
		};
		wrapped[MARK] = true;
		service.capability = wrapped;
		log(`picker worker: watching the mounted picker for a remote client's pick`);
		return () => {
			if (service.capability === wrapped) service.capability = capability;
		};
	}

	return { attach };
}
