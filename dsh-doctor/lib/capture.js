/**
 * In-process log capture: the harness's own log records, held in a ring.
 *
 * `ctx.logger` is cordis's logger service, and its `exporter()` method is the public
 * way to observe records: the service fans every record out to each registered
 * exporter, for every plugin in the process (`dsh-app-boot` registers one itself for
 * its startup audit). That is what makes this panel able to read the whole harness's
 * logging from the inside, which is the point on the official desktop app: there is no
 * log file to tail, the child dsh's stdout goes to the Electron process and its stderr
 * lives only in a 64 KiB in-memory buffer.
 *
 * Two sources, in this order:
 *  1. `logger.buffer` — the last `bufferSize` records the service itself kept, so a
 *     snapshot at attach time is the boot history, including rows that loaded before
 *     this plugin did.
 *  2. the exporter, for everything from then on.
 *
 * Text is redacted on the way in. This plugin must never surface a remote link or a
 * token, and log text is the one place either could turn up.
 *
 * @module dsh-doctor/lib/capture
 */
import { format } from "node:util";

/**
 * How much the ring may hold. Memory is the bound worth having: a count or an age alone
 * throws away exactly the history a bug hunt wants, and a line's cost varies by three
 * orders of magnitude, so neither one tracks what the panel actually costs the process.
 * Oldest-first trimming on the way in keeps this a hard ceiling with no timer to own.
 */
export const RECORD_BYTES_LIMIT = 4 * 1024 * 1024;
/**
 * What a record costs besides its text: the object, its five fields and the two string
 * headers around them. Charging this per record is what makes the budget a bound on
 * memory rather than on the number of characters, so a flood of tiny lines cannot slip
 * under it.
 */
const RECORD_OVERHEAD_BYTES = 128;
/** Bytes a record is charged: its text and source name, plus per-record overhead. */
const costOf = (record) => RECORD_OVERHEAD_BYTES + Buffer.byteLength(record.text) + Buffer.byteLength(record.name);
/** Records sent in one response; a client keeps its own window anyway. */
export const SEND_LIMIT = 2000;

/** Query parameters that carry a credential. */
const TOKEN_PARAM = /([?&](?:token|access_token|api_key|apikey|key|secret|password)=)[^&\s"']+/giu;
/** A tunnel's hostname is the credential: the link itself is what grants access. */
const TUNNEL_URL = /https?:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com[^\s"']*/giu;
/** An authorization header value. */
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu;

/**
 * Mask anything that would let a reader use a credential of ours.
 * @param text - raw log text.
 * @returns the same text with credentials replaced by a placeholder.
 */
export function redact(text) {
	return String(text)
		.replace(TOKEN_PARAM, "$1<redacted>")
		.replace(TUNNEL_URL, "<tunnel-url>")
		.replace(BEARER, "$1 <redacted>");
}

/**
 * Compose one log record's text. Cordis formats with `%s`-style directives plus its
 * own `%C` colour marker, which consumes an argument (a plugin or service name) and
 * has no counterpart in `util.format` — so it is mapped onto `%s` rather than dropped,
 * which would push its argument to the end of the line.
 * @param message - a cordis logger `Message`.
 * @returns the formatted, redacted single-line text.
 */
function textOf(message) {
	const args = Array.isArray(message?.args) ? message.args : [message?.args];
	const [head, ...rest] = args;
	const cleaned = typeof head === "string" ? [head.replaceAll(/%C/giu, "%s"), ...rest] : args;
	try {
		return redact(format(...cleaned).trim());
	} catch {
		return redact(String(head ?? ""));
	}
}

/**
 * A bounded ring of log records, newest last.
 * @param budget - bytes the ring may hold, oldest dropped first.
 * @returns `{ add, snapshot, select, count, bytes, lastSn }`.
 */
export function createRecordStore(budget = RECORD_BYTES_LIMIT) {
	const records = [];
	let sn = 0;
	let bytes = 0;
	/** Drop the oldest until the ring is back inside its budget. */
	const trim = () => {
		while (bytes > budget && records.length > 0) bytes -= costOf(records.shift());
	};
	return {
		/** Record one cordis `Message`; returns the stored record. */
		add(message) {
			const record = {
				sn: ++sn,
				ts: Number.isFinite(message?.ts) ? message.ts : Date.now(),
				name: String(message?.name ?? "?"),
				type: String(message?.type ?? "info"),
				level: Number.isFinite(message?.level) ? message.level : 1,
				text: textOf(message)
			};
			records.push(record);
			bytes += costOf(record);
			trim();
			return record;
		},
		/** A copy of what is held, oldest first. */
		snapshot() {
			return [...records];
		},
		/**
		 * Records a client that already has everything up to `since` must receive.
		 * A `since` the ring has already dropped cannot be resumed from, so the whole
		 * window comes back with `reset` set and the client replaces its own.
		 * @param since - the newest `sn` the client holds, or undefined for all of it.
		 * @returns `{ records, reset }`.
		 */
		select(since) {
			// A full read returns the whole window, so it must say `reset`: anything else
			// makes the client append the window to itself on every refresh.
			if (!Number.isFinite(since)) return { records: records.slice(-SEND_LIMIT), reset: true };
			const oldest = records.length === 0 ? sn + 1 : records[0].sn;
			if (since + 1 < oldest) return { records: records.slice(-SEND_LIMIT), reset: true };
			return { records: records.filter((record) => record.sn > since), reset: false };
		},
		/** Records currently held. */
		get count() {
			return records.length;
		},
		/** Bytes those records are charged, never more than the budget. */
		get bytes() {
			return bytes;
		},
		/** `sn` of the newest record ever recorded. */
		get lastSn() {
			return sn;
		}
	};
}

/**
 * Start capturing: take the service's own boot buffer, then register our exporter.
 *
 * Both steps are best-effort. A logger without `exporter` (a different cordis major)
 * must leave the panel usable rather than fail the row.
 *
 * @param logger - the `ctx.logger` service.
 * @param store - the record store to fill.
 * @returns `{ attached, boot, reason, dispose }`; `dispose` removes the exporter.
 */
export function attachLogger(logger, store) {
	if (logger === undefined || logger === null) {
		return { attached: false, boot: 0, reason: "the logger service is not available in this profile" };
	}
	let boot = 0;
	try {
		if (Array.isArray(logger.buffer)) {
			for (const message of logger.buffer) {
				store.add(message);
				boot += 1;
			}
		}
	} catch (error) {
		return { attached: false, boot, reason: `reading the logger buffer failed: ${String(error?.message ?? error)}` };
	}
	try {
		const dispose = logger.exporter({ levels: { default: 3 }, export: (message) => void store.add(message) });
		return { attached: true, boot, dispose: typeof dispose === "function" ? dispose : undefined };
	} catch (error) {
		return { attached: false, boot, reason: String(error?.message ?? error) };
	}
}
