/**
 * Repository-wide checks for the host halves, run from the repository root.
 *
 * The packages' own suites cover their helper modules (parsers, settings, the phone layer's
 * rewriting) but none of them imports `lib/index.js`, so the wiring that actually decides whether a
 * plugin works — the command it registers, the web-server prefix it claims, the script and
 * stylesheet it injects into the page, the routes those point at — was only ever exercised by a live
 * dsh. That is the layer where a mistake stays silent: dsh prints one `warning: N entries did not
 * activate` and carries on. This suite mounts every host half against a fake context and then calls
 * the handlers the way dsh and the browser would.
 *
 * Run from the repository root:
 *   node tests/host-half.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

const read = (path) => readFileSync(join(root, path), "utf8");
/** The six packages whose browser half their own host half serves and injects. */
const PANELS = ["dsh-skills", "dsh-mcp", "dsh-doctor", "dsh-zoom", "dsh-notify", "dsh-remote"];
/** The hub's browser half goes through dsh's client modules, so it injects nothing itself. */
const HUB = "dsh-features";

/** Every `dsh-*` package at the root, in name order. */
const PACKAGES = readdirSync(root, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-") && existsSync(join(root, entry.name, "package.json")))
	.map((entry) => entry.name)
	.sort();

/** A permissive fake service: any member is a no-op that returns another fake. */
function anything() {
	const fn = () => anything();
	return new Proxy(fn, {
		get: (_target, key) => (typeof key === "symbol" ? undefined : anything()),
		apply: () => anything()
	});
}

/**
 * Mount one host half against a fake context that records what it registers.
 * @param pkg - package directory name.
 * @returns what was recorded, plus anything `apply` threw.
 */
async function mountHostHalf(pkg) {
	const registered = { commands: [], effects: [], listeners: [], prefixes: [] };
	const home = mkdtempSync(join(tmpdir(), "dsh-host-half-"));
	const services = {
		webServer: {
			register(route) {
				registered.prefixes.push(route);
				return () => {};
			}
		},
		configEditor: { documentPath: join(home, "profiles", "test", "cordis.patch.yml") },
		sessions: { list: () => [] },
		commands: {
			register(definition) {
				registered.commands.push(definition);
				return () => {};
			}
		},
		connection: anything(),
		loader: { *entries() {} },
		skills: anything(),
		llm: anything()
	};
	const logger = Object.assign(() => logger, {
		info() {}, warn() {}, error() {}, debug() {}, exporter: () => () => {}
	});
	const ctx = {
		logger,
		// Cordis exposes a service as a property of the context as well as through `ctx.get()`, and
		// every host half here uses the property form: `ctx.commands.register(...)`.
		...services,
		get: (name) => services[name],
		on(event, handler) {
			registered.listeners.push({ event, handler });
			return () => {};
		},
		effect(callback, label) {
			registered.effects.push(label);
			const produced = callback();
			// A generator body only runs when it is driven; `yield ctx.commands.register(...)` is the
			// shape dsh-init uses, and the registration happens on that first step.
			if (produced !== undefined && typeof produced.next === "function") {
				let step = produced.next();
				for (let guard = 0; !step.done && guard < 20; guard += 1) step = produced.next(step.value);
			}
			return () => {};
		},
		inject(names, callback) {
			callback(Object.assign({}, ctx, {
				webServer: services.webServer,
				configEditor: services.configEditor,
				connection: services.connection
			}));
			return () => {};
		}
	};
	let failure;
	try {
		const module = await import(pathToFileURL(join(root, pkg, "lib", "index.js")).href);
		await module.apply(ctx);
	} catch (error) {
		failure = error;
	}
	return { registered, failure, rm: () => rmSync(home, { recursive: true, force: true }) };
}

/** A response recorder: what a route handler wrote. */
function recorder() {
	return {
		status: undefined,
		body: "",
		writeHead(status) {
			this.status = status;
		},
		end(body) {
			this.body = body ?? "";
		},
		headersSent: false
	};
}

/** Call a prefix handler the way dsh does: only paths under the prefix, with the full URL. */
async function call(route, url, method = "GET") {
	const res = recorder();
	await route.handler({ url, method, headers: {} }, res);
	return res;
}

const seenCommands = new Map();
const seenPrefixes = new Map();

for (const pkg of PACKAGES) {
	const mounted = await mountHostHalf(pkg);
	const { registered } = mounted;
	check(mounted.failure === undefined, `${pkg}: apply runs against a plain context`, String(mounted.failure?.message ?? ""));
	if (mounted.failure !== undefined) {
		mounted.rm();
		continue;
	}

	// One prefix, named after the package: that is the whole routing contract between the packages.
	check(registered.prefixes.length <= 1, `${pkg}: claims at most one web-server prefix`, String(registered.prefixes.length));
	const route = registered.prefixes[0];
	const claimsRoute = PANELS.includes(pkg) || pkg === HUB;
	if (claimsRoute) {
		check(
			route?.kind === "prefix" && route.path === `/${pkg}`,
			`${pkg}: claims the prefix /${pkg} as a prefix route`,
			JSON.stringify({ kind: route?.kind, path: route?.path })
		);
		const clash = seenPrefixes.get(route?.path);
		check(clash === undefined, `${pkg}: the prefix ${String(route?.path)} is not taken by ${String(clash)}`, "");
		if (clash === undefined) seenPrefixes.set(route?.path, pkg);
	} else {
		check(route === undefined, `${pkg}: is a command, so it claims no route`, JSON.stringify(route?.path));
	}

	// The command, against the runtime's own rules for a definition.
	const command = registered.commands[0];
	if (pkg === HUB) {
		check(registered.commands.length === 0, `${pkg}: registers no command (it is the hub page)`, String(registered.commands.length));
	} else {
		check(registered.commands.length === 1, `${pkg}: registers exactly one command`, String(registered.commands.length));
		check(typeof command?.name === "string" && /^[a-z][a-z0-9_-]*$/u.test(command.name), `${pkg}: the command name is legal`, String(command?.name));
		check(typeof command?.description === "string" && command.description.length > 0, `${pkg}: the command has a description`, String(command?.description));
		check(typeof command?.handler === "function", `${pkg}: the command has a handler`, typeof command?.handler);
		const clash = seenCommands.get(command?.name);
		check(clash === undefined, `${pkg}: the command name ${String(command?.name)} is not taken by ${String(clash)}`, "");
		if (clash === undefined) seenCommands.set(command?.name, pkg);
	}

	if (route !== undefined) {
		// What the page is told to load, and whether this plugin is the one serving it.
		const table = [];
		for (const { event, handler } of registered.listeners) {
			if (event === "webserver/index-inject") handler(table);
		}
		if (PANELS.includes(pkg)) {
			check(table.length === 2, `${pkg}: injects its script and its stylesheet into the page`, `${String(table.length)} entries`);
		} else {
			check(table.length === 0, `${pkg}: injects nothing (its browser half ships through dsh's client modules)`, `${String(table.length)} entries`);
		}
		const script = table.find((entry) => entry.kind === "script-src");
		const style = table.find((entry) => entry.kind === "html");
		if (script !== undefined) check(script.src?.startsWith(`/${pkg}/`) === true, `${pkg}: the injected script is served by its own prefix`, String(script.src));
		if (style !== undefined) check(style.html?.includes(`/${pkg}/`) === true, `${pkg}: the injected stylesheet is served by its own prefix`, String(style.html).slice(0, 60));
		if (script !== undefined && style !== undefined) {
			check(script.placement === "body" && style.placement === "head", `${pkg}: the script lands in the body and the stylesheet in the head`, `${String(script.placement)}/${String(style.placement)}`);
		}

		// Every asset the page was told to load, fetched the way the browser will.
		const wanted = new Set();
		if (script?.src !== undefined) wanted.add(script.src);
		for (const match of String(style?.html ?? "").matchAll(/href="([^"]+)"/gu)) wanted.add(match[1]);
		check(wanted.size > 0 || pkg === HUB, `${pkg}: the injected assets are named`, [...wanted].join(", "));
		for (const asset of wanted) {
			const file = join(pkg, "lib", asset.slice(asset.lastIndexOf("/") + 1));
			const res = await call(route, `${asset}?token=x`);
			const onDisk = existsSync(join(root, file)) ? read(file) : "(missing from the package)";
			check(res.status === 200 && res.body === onDisk, `${pkg}: serves ${asset} byte-identically to the tree`, `status ${String(res.status)}, ${String(res.body.length)}b vs ${String(onDisk.length)}b`);
		}

		// A path under its own prefix it does not know, and a path outside it: the first must be its
		// own JSON 404 (proof the handler owns the prefix), the second must not be answered at all.
		const unknown = await call(route, `/${pkg}/definitely-not-a-route`);
		let parsed;
		try {
			parsed = JSON.parse(unknown.body);
		} catch {
			parsed = undefined;
		}
		check(
			unknown.status === 404 && parsed?.ok === false && typeof parsed.error === "string",
			`${pkg}: a path it does not know answers its own JSON 404`,
			`status ${String(unknown.status)} body ${unknown.body.slice(0, 70)}`
		);
		const outside = await call(route, "/somebody-elses-route");
		check(outside.status !== 200, `${pkg}: does not answer outside its prefix`, `status ${String(outside.status)}`);
	}

	mounted.rm();
}

/* ------------------------------ dsh-notify: the events it turns into reminders */

// The host half is the only half that can see an approval or a question, and it learns about
// them from two dsh waterfalls: `user-approval` dispatches `approval/request` with a fallback
// that answers `unavailable`. So a listener has two obligations that pull against each other,
// announce the thing and *not* swallow it: one that answers nothing and forgets `next()`
// stalls the very approval it just announced. Both are checked here, against the same bus the
// panel reads.
const notifier = await mountHostHalf("dsh-notify");
const notifyRoute = notifier.registered.prefixes[0];
/** What this plugin has published, as the panel sees it. */
const published = async () => {
	const body = JSON.parse((await call(notifyRoute, "/dsh-notify/api/notifications")).body);
	return Array.isArray(body.items) ? body.items : [];
};
/** Fire one waterfall the way dsh does, and count how many listeners handed control on. */
const dispatch = async (event, request) => {
	let continued = 0;
	for (const { handler } of notifier.registered.listeners.filter((entry) => entry.event === event)) {
		await handler(request, () => {
			continued += 1;
			return Promise.resolve();
		});
	}
	return continued;
};

const asked = { agent: { id: "s-question", session: { header: { title: "绘图" } } } };
const questionCarriedOn = await dispatch("user-questions/request", asked);
const afterQuestion = await published();
check(
	questionCarriedOn === 1 && afterQuestion.some((item) => item.kind === "question" && item.sessionId === "s-question"),
	"dsh-notify: a question reaches the reminder bus and the waterfall carries on",
	`next()x${String(questionCarriedOn)} published ${JSON.stringify(afterQuestion.map((item) => item.kind))}`
);

const approvalCarriedOn = await dispatch("approval/request", { agent: { id: "s-approval", session: { header: { title: "部署" } } } });
const afterApproval = await published();
check(
	approvalCarriedOn === 1 && afterApproval.some((item) => item.kind === "approval" && item.sessionId === "s-approval"),
	"dsh-notify: an approval reaches the reminder bus and the waterfall carries on",
	`next()x${String(approvalCarriedOn)} published ${JSON.stringify(afterApproval.map((item) => item.kind))}`
);
check(
	afterApproval.find((item) => item.kind === "approval")?.title === "部署",
	"dsh-notify: an approval reminder names the session it belongs to",
	JSON.stringify(afterApproval.find((item) => item.kind === "approval") ?? null)
);

// A subagent's own approval is noise, but it is still an approval: declining to announce it
// must not decline to pass it on.
const beforeSubagent = (await published()).length;
const subagentCarriedOn = await dispatch("approval/request", { agent: { id: "s-sub", session: { header: { origin: "subagent" } } } });
check(
	subagentCarriedOn === 1 && (await published()).length === beforeSubagent,
	"dsh-notify: a subagent's approval is not announced, and is not stalled either",
	`next()x${String(subagentCarriedOn)} count ${String(beforeSubagent)} -> ${String((await published()).length)}`
);

// A finished turn is the other half of the classification, and it arrives as a session
// event rather than a waterfall: a turn that used a tool is "done", a plain answer is
// "ready", and a subagent's turn is neither.
const session = { id: "s-turn", header: { title: "曲线图" } };
const fireSession = (event) => {
	for (const { handler } of notifier.registered.listeners.filter((entry) => entry.event === "session/event")) handler(session, event);
};
fireSession({ type: "turn/start" });
fireSession({ type: "tool/call" });
fireSession({ type: "turn/end", data: { reason: { kind: "completed" } } });
const afterWorked = await published();
check(
	afterWorked.some((item) => item.kind === "turn_done" && item.sessionId === "s-turn"),
	"dsh-notify: a turn that used a tool is announced as a completed task",
	JSON.stringify(afterWorked.map((item) => item.kind))
);
fireSession({ type: "turn/start" });
fireSession({ type: "turn/end", data: { reason: { kind: "completed" } } });
const afterAnswer = await published();
check(
	afterAnswer.filter((item) => item.sessionId === "s-turn").at(-1)?.kind === "answer_done",
	"dsh-notify: a turn that only answered is announced as an answer instead",
	JSON.stringify(afterAnswer.filter((item) => item.sessionId === "s-turn").map((item) => item.kind))
);
const beforeSubagentTurn = (await published()).length;
for (const { handler } of notifier.registered.listeners.filter((entry) => entry.event === "session/event")) {
	handler({ id: "s-sub-turn", header: { origin: "subagent" } }, { type: "turn/end", data: { reason: { kind: "completed" } } });
}
check(
	(await published()).length === beforeSubagentTurn,
	"dsh-notify: a subagent's own turn is not a reminder",
	String(beforeSubagentTurn)
);
notifier.rm();

/* ----------------------------------------------------------------- report */

const failed = results.filter((item) => !item.ok);
for (const item of results) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.label}${item.detail === "" ? "" : ` — ${item.detail}`}`);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
if (failed.length > 0) process.exitCode = 1;
