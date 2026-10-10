/**
 * Tiny helpers for this plugin's own HTTP surface. The dsh web server hands
 * route handlers full response ownership, so these keep the ownership rules in
 * one place: every helper ends the response exactly once.
 *
 * @module dsh-features/lib/http
 */

/** Send a JSON response. */
export function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}

/**
 * Wrap a handler so a thrown error becomes a JSON 500 instead of an unhandled
 * rejection inside the web server's request path.
 * @param handler - the real handler.
 * @returns a handler that reports failures as JSON.
 */
export function guard(handler) {
	return async (req, res) => {
		try {
			await handler(req, res);
		} catch (error) {
			const message = String(error?.message ?? error);
			if (!res.headersSent) sendJson(res, 500, { ok: false, error: message });
			else res.end();
		}
	};
}
