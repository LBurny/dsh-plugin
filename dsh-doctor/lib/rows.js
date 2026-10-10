/**
 * The loaded plugin tree, as the loader service sees it.
 *
 * A green boot does not mean a row activated: dsh prints one
 * `warning: N entries did not activate` line and then starts and serves as usual, so
 * "did my plugin load?" cannot be answered from the ready line. `ctx.loader.entries()`
 * can: every entry carries its id, the module name the row points at, whether it is
 * disabled, and its fiber's lifecycle state. That is the half of the picture a debug
 * panel has to supply.
 *
 * `FiberState` is a numeric enum in the compiled runtime (`cordis/src/fiber.ts`):
 * `0 PENDING, 1 LOADING, 2 ACTIVE, 3 FAILED, 4 DISPOSED, 5 UNLOADING`. A row that is
 * switched off has no fiber at all, and a real profile has a lot of those: the number
 * only means something for a row that was meant to load.
 *
 * @module dsh-doctor/lib/rows
 */

/** `FiberState` as the compiled cordis names it, by number. */
export const FIBER_STATES = ["pending", "loading", "active", "failed", "disposed", "unloading"];

/**
 * The row ids `dsh-app-boot` requires: if one of these does not activate, the boot
 * fails outright (`dsh: startup failed: N required plugins did not activate`) instead
 * of printing a warning. The list is copied from `requiredStartupEntryIds`, which the
 * package does not export, so a row carrying one of these ids is worth flagging in the
 * panel even when nothing is wrong yet.
 */
export const REQUIRED_ROW_IDS = ["agent-loop", "webserver", "modules", "connection", "headless-runner", "acp", "sdk-jsonrpc-server"];

/** @param state - `entry.fiber.state`, a number in the compiled runtime. */
function stateName(state, disabled) {
	if (typeof state === "string") return state.toLowerCase();
	if (Number.isInteger(state)) return FIBER_STATES[state] ?? `#${String(state)}`;
	// A row that is switched off never gets a fiber, which is not the same as one whose
	// state is unrecognized: 188 rows of a real profile are `disabled` and have none.
	return disabled ? "not-loaded" : "unknown";
}

/**
 * The package a row mounts: `@scope/name` keeps two segments, a bare name one, and a
 * local path stays whole because that is the only thing identifying it.
 * @param module - the row's `name`.
 */
export function packageOf(module) {
	const text = String(module ?? "");
	if (text === "") return "";
	if (text.startsWith(".") ) return text;
	if (text.length > 1 && (text.includes(":") || text.startsWith("/") || text.startsWith("\\"))) return text;
	const parts = text.split("/");
	return text.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Walk the loader tree.
 *
 * Best-effort by design: a profile without the loader service, or a cordis whose entry
 * shape differs, must leave the panel reporting "unavailable" rather than throwing
 * inside a request handler.
 *
 * @param loader - the `loader` service (`ctx.get("loader")`).
 * @returns `{ available, reason, rows }` with one entry per row, in tree order.
 */
export function collectRows(loader) {
	if (typeof loader?.entries !== "function") {
		return { available: false, reason: "the loader service is not available in this profile", rows: [] };
	}
	const rows = [];
	try {
		for (const entry of loader.entries()) {
			const id = String(entry?.id ?? entry?.options?.id ?? "?");
			const module = String(entry?.options?.name ?? "");
			rows.push({
				id,
				module,
				package: packageOf(module),
				group: entry?.options?.group !== undefined,
				disabled: entry?.disabled === true,
				state: stateName(entry?.fiber?.state, entry?.disabled === true),
				required: REQUIRED_ROW_IDS.includes(id)
			});
		}
	} catch (error) {
		return { available: false, reason: String(error?.message ?? error), rows };
	}
	return { available: true, rows };
}

/**
 * A one-line summary of the tree: how many rows there are, and which failed.
 * @param collected - the result of {@link collectRows}.
 */
export function summarizeRows(collected) {
	const rows = collected?.rows ?? [];
	const failed = rows.filter((row) => row.state === "failed");
	const active = rows.filter((row) => row.state === "active");
	const parts = [`${String(active.length)}/${String(rows.length)} rows active`];
	if (failed.length > 0) parts.push(`failed: ${failed.map((row) => row.id).join(", ")}`);
	const missing = rows.filter((row) => row.required && row.state !== "active" && !row.disabled);
	if (missing.length > 0) parts.push(`required rows not active: ${missing.map((row) => row.id).join(", ")}`);
	return parts.join("; ");
}
