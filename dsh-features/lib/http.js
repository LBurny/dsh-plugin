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

/** Refuse a body larger than this: the only writer is the hub page itself. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read and parse a JSON request body.
 * @param req - the request stream.
 * @returns the parsed body, or undefined when it is absent, oversized or malformed.
 */
export async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	if (size === 0) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
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
