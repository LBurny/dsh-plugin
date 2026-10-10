/**
 * QR rendering for the remote link.
 *
 * Deliberately built on a real library rather than a hand-rolled encoder: a QR
 * symbol that is subtly wrong fails silently at the one moment that matters (the
 * user pointing a phone at it), and an encoder cannot be verified offline
 * without a scanner. `qrcode` is a mature, pure-JS package, used when it is
 * installed; when it is not, the panel shows the link alone.
 *
 * Four resolution anchors, because a plugin's dependencies can land in several
 * places and no single one covers the others:
 *  - alongside the plugin (`profiles/plugins/<pkg>/node_modules`) — what a plain
 *    `npm install` in the plugin directory produces, and where a git install
 *    materializes the dependency tree;
 *  - the profile itself (`profiles/<name>/node_modules`) — where a profile-level
 *    install puts it; Node's own lookup from the plugin directory cannot reach it;
 *  - the plugins directory and the DSH home — where a manual install ends up when
 *    someone puts it at the "wrong" level.
 * @module dsh-remote/lib/qr
 */
import { createRequire } from "node:module";
import { join } from "node:path";

/** Resolution results do not change while dsh runs, so cache the outcome. */
let cached;

/** Try one resolution anchor. */
function tryRequire(anchor) {
	try {
		return createRequire(anchor)("qrcode");
	} catch {
		return undefined;
	}
}

/**
 * Resolve the QR library.
 * @param layout - resolved path layout (needs `profileDir`, `profilesDir`, `dshHome`).
 * @returns the module, or undefined when it is not installed.
 */
function loadLibrary(layout) {
	if (cached !== undefined) return cached;
	const anchors = [
		import.meta.url,
		join(layout.profileDir, "package.json"),
		join(layout.profilesDir ?? ".", "package.json"),
		join(layout.dshHome ?? ".", "package.json")
	];
	for (const anchor of anchors) {
		cached = tryRequire(anchor);
		if (cached !== undefined) return cached;
	}
	cached = undefined;
	return cached;
}

/**
 * Create a renderer bound to the active profile.
 * @param layout - resolved path layout.
 * @returns `available` plus an SVG renderer.
 */
export function createQrRenderer(layout) {
	return {
		/** Whether QR rendering is usable (the `qrcode` package is installed). */
		available: () => loadLibrary(layout()) !== undefined,
		/**
		 * Render text as an SVG QR symbol.
		 * @param text - the payload, normally the remote link.
		 * @returns the SVG markup, or undefined when the library is missing.
		 */
		async svg(text) {
			const library = loadLibrary(layout());
			if (library === undefined) return undefined;
			return library.toString(text, {
				type: "svg",
				margin: 1,
				width: 320,
				errorCorrectionLevel: "M",
				color: { dark: "#000000ff", light: "#ffffffff" }
			});
		}
	};
}
