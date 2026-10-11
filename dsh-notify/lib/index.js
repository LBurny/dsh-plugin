/**
 * dsh-notify — task reminders: popup, sound, browser notification.
 *
 * Ported from DSHDesktop, which raised Windows toasts from WinRT and played WAV
 * files on a self-managed `waveOut` thread. Neither exists inside dsh, so the
 * split is: this half subscribes to the harness's own events and republishes
 * them on a small SSE stream; the browser half plays the sound and shows the
 * notification.
 *
 * Why subscribe here rather than have the page connect to `/api/remote.mux`:
 * the page would have to replay the frame protocol (stream ids, `$events`
 * waterflow acks, per-session `session/follow`) that the desktop shell
 * implements in Rust. Subscribing host-side with `ctx.on(...)` is far less code
 * and far less likely to break on a dsh upgrade — and SSE reconnects on its own.
 *
 * @module dsh-notify/index
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createNotifyBus } from "./bus.js";
import { createFocuser } from "./focus.js";
import { guard, readJson, sendBuffer, sendJson, sendText } from "./http.js";
import { resolveLayout } from "./layout.js";
import { SILENT, SYSTEM_DEFAULT, listSounds, readSound } from "./sounds.js";
import { loadConfig, mergeDeep, normalizeConfig, saveConfig } from "./settings.js";

const name = "notify";
const inject = ["commands"];
/** Shown in the panel and /api/settings; bump alongside package.json. */
const VERSION = "0.1.0";

/** Every route this plugin owns hangs off this prefix. */
const ROUTE_PREFIX = "/dsh-notify";
const SCRIPT_PATH = `${ROUTE_PREFIX}/client.js`;
const STYLE_PATH = `${ROUTE_PREFIX}/client.css`;
const SOUND_PATH = `${ROUTE_PREFIX}/sounds/`;

/** The browser half (client.js/client.css) is served from this directory. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Create the plugin state: layout resolution (lazy — the config-editor service
 * may not be mounted yet when `apply` runs), the settings cache and the
 * notification bus.
 * @param ctx - plugin context.
 */
function createState(ctx) {
	const bus = createNotifyBus();
	const focuser = createFocuser();
		/** Cached settings, invalidated by every write. */
		let cache;
		/** Saves serialize on this chain: two overlapping patches must merge onto each
		 * other, never onto the same stale base (the later write would drop the earlier). */
		let saving = Promise.resolve();
	const layout = () => {
		const configEditor = ctx.get("configEditor");
		if (configEditor === undefined) throw new Error("config-editor service is not available in this profile");
		return resolveLayout(configEditor);
	};
	return {
		bus,
		/** Raise the window that shows this harness, for a clicked reminder. */
		focus: () => focuser.activate(),
		layout,
		/** Load settings, memoized until the next save. */
		async config() {
			if (cache === undefined) cache = await loadConfig(layout().configPath);
			return cache;
		},
		/** Persist a settings patch and refresh the memo. Deep-merged: a patch
		 * carrying one rule must not drop the others. */
		save(patch) {
			const run = saving.then(async () => {
				const current = await this.config();
				cache = await saveConfig(layout().configPath, normalizeConfig(patch === undefined ? current : mergeDeep(current, patch)));
				return cache;
			});
			// The chain itself must survive a failure, or every later save would reject.
			saving = run.catch(() => {});
			return run;
		},
		log(message) {
			ctx.logger.info(`[dsh-notify] ${message}`);
		}
	};
}

/**
 * Wrap a command handler so a failure (most often a service this profile does
 * not mount) becomes an error result instead of an exception.
 */
function command(fn) {
	return async (invocation) => {
		try {
			return await fn(invocation);
		} catch (error) {
			return { kind: "error", text: `dsh-notify: ${String(error?.message ?? error)}` };
		}
	};
}

/** One line per reminder kind, for the command's text output. */
function renderRules(config) {
	return Object.entries(config)
		.filter(([, value]) => typeof value === "object" && value !== null && typeof value.enabled === "boolean")
		.map(([kind, rule]) => `${rule.enabled ? "[x]" : "[ ]"} ${kind}${rule.timing === "always" ? " (always)" : " (background only)"}`)
		.join("\n");
}

/**
 * Register `/notify`. Guarded: command names are first-come, first-served, so a
 * clash with another plugin must degrade to a warning — an exception here would
 * take the whole plugin tree (i.e. dsh itself) down during `apply`.
 */
function registerCommands(ctx, state) {
	try {
		ctx.commands.register({
			name: "notify",
			description: "Show the reminder rules and whether a stream is connected",
			handler: command(async () => {
				const config = await state.config();
				return {
					kind: "success",
					text: [
						`${state.bus.size()} stream(s) connected, ${state.bus.recent().length} recent reminder(s)`,
						renderRules(config),
						`sound=${config.sound} volume=${String(config.volume)} toast=${String(config.toast)} browser=${String(config.browser)}`,
						`settings: ${state.layout().configPath}`
					].join("\n")
				};
			})
		});
	} catch (error) {
		const reason = String(error?.message ?? error);
		ctx.logger.warn(`[dsh-notify] command /notify not registered: ${reason}`);
	}
}

/**
 * Subscribe to the host events that drive reminders and forward them to the
 * page. The four kinds mirror the desktop shell's classification: something
 * waiting on the user (approval, question) and a finished turn split into "did
 * work" versus "answered only".
 * @param ready - context whose lifetime owns these subscriptions.
 * @param state - plugin state.
 */
function mountEventBridge(ready, state) {
	/** Per-session turn state: whether the running turn used any tool. */
	const turns = new Map();
	/** Session titles, learned from the session's own title events. */
	const titles = new Map();
	const titleOf = (sessionId, session) => titles.get(sessionId) ?? session?.header?.title ?? undefined;

	/**
	 * Publish one reminder and leave a breadcrumb. A waterfall listener gives no other sign
	 * that it ran, and "the reminder never happened" and "something upstream claimed the
	 * event first" look identical from the outside, so the log is where the difference is
	 * visible: `dsh-doctor`'s log view reads these records out of the running harness.
	 */
	function announce(record) {
		const item = state.bus.publish(record);
		state.log(`announced ${item.kind}${item.sessionId === undefined ? "" : ` for ${item.sessionId}`}`);
		return item;
	}

	ready.on("session/event", (session, event) => {
		try {
			const sessionId = session?.id;
			if (typeof sessionId !== "string") return;
			switch (event?.type) {
				case "session/title":
					if (typeof event.data?.title === "string") titles.set(sessionId, event.data.title);
					break;
				case "turn/start":
					turns.set(sessionId, { worked: false });
					break;
				case "tool/call": {
					const state_ = turns.get(sessionId) ?? { worked: false };
					state_.worked = true;
					turns.set(sessionId, state_);
					break;
				}
				case "turn/end": {
					const reason = event.data?.reason?.kind;
					const worked = turns.get(sessionId)?.worked === true;
					turns.delete(sessionId);
					// Subagent turns are noise; the shell suppresses them too.
					if (session?.header?.origin === "subagent") break;
					if (reason !== "completed") break;
					const title = titleOf(sessionId, session);
					announce({
						kind: worked ? "turn_done" : "answer_done",
						sessionId,
						title,
						// Facts, not prose: the page in front of the reader composes the sentence
						// in their own language (see the client's `reminderText`). This is the
						// fallback for a consumer that has no language of its own, so it stays
						// neutral English and carries no separator to fight with.
						text: title === undefined
							? (worked ? "dsh task completed" : "dsh answer ready")
							: `${worked ? "Task" : "Answer"} completed: ${title}`
					});
					break;
				}
				default:
					break;
			}
		} catch (error) {
			state.log(`session event handling failed: ${String(error?.message ?? error)}`);
		}
	});

	// Waterfall events: publish, then hand control on. Not calling `next()` would
	// stall the approval/question the record is about.
	//
	// `prepend` is load-bearing, and its absence is invisible. The same waterfall is how the
	// window answers these requests: `@deepseek-ai/dsh-api-remotes` installs a listener that
	// forwards the request to the connected clients and returns whatever they answer, and a
	// waterfall listener that does not call `next()` vetoes the rest of the chain. A profile
	// bundle is loaded after dsh's own rows, so without `prepend` this observer is simply
	// never called whenever a window is attached — which looks exactly like a plugin that
	// does not work, while its turn reminders (a plain emit, where every listener runs)
	// keep arriving and seem to prove the opposite. Running first costs nothing: announcing
	// and passing control on is all this listener does.
	const observeFirst = { prepend: true };
	ready.on("approval/request", (request, next) => {
		try {
			if (request?.agent?.session?.header?.origin !== "subagent") {
				announce({
					kind: "approval",
					sessionId: request?.agent?.id,
					title: titleOf(request?.agent?.id, request?.agent?.session),
					text: "dsh has an operation waiting for your approval"
				});
			}
		} catch (error) {
			state.log(`approval observation failed: ${String(error?.message ?? error)}`);
		}
		return next();
	}, observeFirst);

	ready.on("user-questions/request", (request, next) => {
		try {
			if (request?.agent?.session?.header?.origin !== "subagent") {
				announce({
					kind: "question",
					sessionId: request?.agent?.id,
					title: titleOf(request?.agent?.id, request?.agent?.session),
					text: "dsh has a question waiting for your answer"
				});
			}
		} catch (error) {
			state.log(`question observation failed: ${String(error?.message ?? error)}`);
		}
		return next();
	}, observeFirst);

	ready.on("session/disposed", (session) => {
		if (typeof session?.id === "string") {
			turns.delete(session.id);
			titles.delete(session.id);
		}
	});
}

/**
 * Mount the HTTP surface and the panel injection.
 * @param ready - a context where `webServer` and `configEditor` are both available.
 * @param state - plugin state.
 */
function mount(ready, state) {
	const { webServer } = ready;

	const asset = async (res, file, type) => {
		try {
			sendText(res, 200, await readFile(join(LIB_DIR, file), "utf8"), type);
		} catch (error) {
			sendText(res, 500, `dsh-notify: asset ${file} unavailable: ${String(error?.message ?? error)}`);
		}
	};

	const handle = async (req, res, path) => {
		const method = req.method ?? "GET";
		if (path === "/api/settings" && method === "GET") {
			const [sounds] = await Promise.all([listSounds()]);
			return sendJson(res, 200, {
				ok: true,
				config: await state.config(),
				sounds: [SILENT, SYSTEM_DEFAULT, ...sounds],
				configPath: state.layout().configPath,
				plugin: { name, version: VERSION }
			});
		}
		if (path === "/api/settings" && method === "POST") {
			const body = await readJson(req);
			if (body === undefined) return sendJson(res, 400, { ok: false, error: "expected a JSON body" });
			const config = await state.save(body);
			state.log("settings updated");
			return sendJson(res, 200, { ok: true, config });
		}
		if (path === "/api/events" && method === "GET") {
			state.bus.attach(res);
			return;
		}
		if (path === "/api/notifications" && method === "GET") {
			return sendJson(res, 200, { ok: true, items: state.bus.recent() });
		}
		// A clicked reminder asks for its window back. A page cannot raise a window the OS has
		// not already focused, so it hands the job to this half, which runs as a child of the
		// process that owns the window.
		if (path === "/api/focus" && method === "POST") {
			const raised = await state.focus();
			return sendJson(res, raised ? 200 : 503, {
				ok: raised,
				error: raised ? undefined : `no window could be raised on ${process.platform}`
			});
		}
		return sendJson(res, 404, { ok: false, error: `no dsh-notify route for ${method} ${path}` });
	};

	ready.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: guard(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			if (path === SCRIPT_PATH) return asset(res, "client.js", "text/javascript; charset=utf-8");
			if (path === STYLE_PATH) return asset(res, "client.css", "text/css; charset=utf-8");
			if (path.startsWith(SOUND_PATH)) {
				const id = decodeURIComponent(path.slice(SOUND_PATH.length)).replace(/\.wav$/u, "");
				const buffer = await readSound(id);
				if (buffer === undefined) return sendJson(res, 404, { ok: false, error: `unknown sound "${id}"` });
				return sendBuffer(res, 200, buffer, "audio/wav");
			}
			if (path.startsWith(`${ROUTE_PREFIX}/api/`)) return handle(req, res, path.slice(ROUTE_PREFIX.length));
			return sendJson(res, 404, { ok: false, error: `no dsh-notify route for ${path}` });
		})
	}), "dsh-notify http routes");

	ready.effect(() => ready.on("webserver/index-inject", (table) => {
		table.push({ kind: "html", html: `<link rel="stylesheet" href="${STYLE_PATH}">`, placement: "head" });
		table.push({ kind: "script-src", src: SCRIPT_PATH, placement: "body" });
	}), "dsh-notify index injection");

	state.log(`panel served at ${SCRIPT_PATH}`);
}

/**
 * Plugin entry point.
 * @param ctx - plugin context (declares `commands`).
 */
function apply(ctx) {
	const state = createState(ctx);
	registerCommands(ctx, state);
	ctx.inject(["webServer", "configEditor"], (ready) => {
		mount(ready, state);
		mountEventBridge(ready, state);
		state.log("host half wired (http routes + event bridge)");
	});
}

export { apply, inject, name };
