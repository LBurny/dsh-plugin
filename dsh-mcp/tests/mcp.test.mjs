/**
 * Standalone checks for the MCP patch-document editor.
 *
 * Run from a plugin location where `yaml` and `@deepseek-ai/dsh-atomic-write`
 * resolve (i.e. an installed copy under `$DSH_HOME/profiles/plugins/dsh-mcp`),
 * with the bundled node:
 *
 *   "$RUNTIME/node.exe" test/mcp.test.mjs
 *
 * What it guards: edits must not damage the rest of the shared patch document —
 * other rows, user comments, and `!!js` expression tags all have to survive a
 * round trip, and editing an existing server must keep keys the form does not own.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteMcpServer, listMcpServers, setMcpEnabled, upsertMcpServer } from "../lib/mcp.js";

const results = [];
const check = (ok, label, detail = "") => results.push({ ok, label, detail });

/** A patch document that exercises every shape the editor has to preserve. */
const FIXTURE = `# User comment that must survive edits
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      custom: { api: openai-completions }
- insert:
    # comment inside the insert list
    - id: some-other-row
      name: some-other-plugin
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: playwright
        transport: stdio
        command: npx
        args: ['-y', '@playwright/mcp']
        toolCallTimeoutMs: 45000
        reconnect:
          enabled: true
- id: keepme
  name: kept
  disabled: !!js '!ctx.get("profileContext")'
`;

const dir = await mkdtemp(join(tmpdir(), "kit-mcp-"));
const layout = { patchPath: join(dir, "cordis.patch.yml"), profileDir: dir };
await writeFile(layout.patchPath, FIXTURE, "utf8");

// --- list -----------------------------------------------------------------
let servers = await listMcpServers(layout);
check(servers.length === 1, "list finds the one MCP row", JSON.stringify(servers));
check(servers[0]?.serverName === "playwright", "serverName parsed", servers[0]?.serverName);
check(servers[0]?.transport === "stdio", "transport parsed", servers[0]?.transport);
check(servers[0]?.summary === "npx -y @playwright/mcp", "command summary", servers[0]?.summary);
check(servers[0]?.enabled === true, "row reads as enabled");
check(servers[0]?.config?.toolCallTimeoutMs === 45000, "advanced key present in config", String(servers[0]?.config?.toolCallTimeoutMs));

// --- add ------------------------------------------------------------------
await upsertMcpServer(layout, { serverName: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] });
servers = await listMcpServers(layout);
check(servers.length === 2, "add creates a second row", String(servers.length));
check(servers.some((server) => server.serverName === "fetch"), "added row is listed");

// --- edit keeps keys the form does not own --------------------------------
await upsertMcpServer(layout, { serverName: "playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] }, "mcp-playwright");
servers = await listMcpServers(layout);
const edited = servers.find((server) => server.serverName === "playwright");
check(edited?.summary === "npx -y @playwright/mcp@latest", "edit replaces command/args", edited?.summary);
check(edited?.config?.toolCallTimeoutMs === 45000, "edit preserves toolCallTimeoutMs");
check(edited?.config?.reconnect?.enabled === true, "edit preserves nested reconnect policy");

// --- disable / enable -----------------------------------------------------
await setMcpEnabled(layout, "mcp-playwright", false);
servers = await listMcpServers(layout);
check(servers.find((server) => server.serverName === "playwright")?.enabled === false, "disable writes disabled:true");
await setMcpEnabled(layout, "mcp-playwright", true);
servers = await listMcpServers(layout);
check(servers.find((server) => server.serverName === "playwright")?.enabled === true, "enable removes disabled");

// --- delete ---------------------------------------------------------------
await deleteMcpServer(layout, "mcp-fetch");
servers = await listMcpServers(layout);
check(servers.length === 1, "delete removes the row", String(servers.length));

// --- document integrity ---------------------------------------------------
const after = await readFile(layout.patchPath, "utf8");
check(after.includes("# User comment that must survive edits"), "top-level comment survives");
check(after.includes("# comment inside the insert list"), "nested comment survives");
check(/disabled:\s*!!js/.test(after), "!!js tag survives", after.split("\n").filter((line) => line.includes("!!js")).join(" | "));
check(after.includes("some-other-row"), "unrelated row survives");
check(after.includes("llm-pi-ai"), "unrelated top-level row survives");
check(!/^\s*- id: mcp-fetch/mu.test(after), "deleted row is gone from the text");

// --- half-written and op-level rows ----------------------------------------
// A row with no command (a half-written or legacy entry) must not take the whole
// list down, and a row written at the op level must be deletable: it is listed and
// toggleable, so refusing to delete it strands it.
const dir2 = await mkdtemp(join(tmpdir(), "kit-mcp-bare-"));
const layout2 = { patchPath: join(dir2, "cordis.patch.yml"), profileDir: dir2 };
await writeFile(
	layout2.patchPath,
	["- id: mcp-half", "  name: '@deepseek-ai/dsh-mcp-client'", "  config:", "    serverName: half", ""].join("\n"),
	"utf8"
);
const half = await listMcpServers(layout2);
check(half.length === 1 && half[0]?.summary === "", "a row with no command is listed with an empty summary, not a 500", JSON.stringify(half[0]?.summary));
await deleteMcpServer(layout2, "mcp-half");
check((await listMcpServers(layout2)).length === 0, "an op-level row can be deleted", "");
check(!(await readFile(layout2.patchPath, "utf8")).includes("mcp-half"), "the op-level row is gone from the text", "");

// --- clearing a form field deletes it ----------------------------------------
// buildConfig omits an emptied field, so an update that only sets submitted keys
// would keep the old env/args/cwd forever.
await upsertMcpServer(layout2, { serverName: "envtest", transport: "stdio", command: "npx", args: ["x"], env: { OLD: "keepme" }, cwd: "/tmp" });
await upsertMcpServer(layout2, { serverName: "envtest", transport: "stdio", command: "npx" });
const cleared = (await listMcpServers(layout2)).find((server) => server.serverName === "envtest");
check(
	cleared?.config?.env === undefined && cleared?.config?.args === undefined && cleared?.config?.cwd === undefined,
	"clearing a form-owned field on update actually deletes it",
	JSON.stringify(cleared?.config)
);
check(cleared?.config?.command === "npx", "the submitted command survives the same update", String(cleared?.config?.command));

// --- renaming moves the row id with the name -------------------------------
// The id is what the import and delete paths address a row by, and the listed id is what
// the import path deletes with, so a rename that left `mcp-<oldName>` behind made the row
// unreachable under its own name: an overwrite-import of the new name threw "no MCP server
// row" and aborted the whole import.
await upsertMcpServer(layout2, { serverName: "renamed", transport: "stdio", command: "npx", args: ["y"] }, "mcp-envtest");
const renamed = (await listMcpServers(layout2)).find((server) => server.serverName === "renamed");
check(renamed?.id === "mcp-renamed", "renaming a server moves its row id with it", String(renamed?.id));
check((await listMcpServers(layout2)).every((server) => server.id !== "mcp-envtest"), "the old id is gone", "");
await setMcpEnabled(layout2, renamed.id, false);
check((await listMcpServers(layout2)).find((server) => server.serverName === "renamed")?.enabled === false, "the renamed row answers to the id the listing reports", "");

// --- an id that does not follow the convention is left alone ---------------
const dir3 = await mkdtemp(join(tmpdir(), "kit-mcp-custom-"));
const layout3 = { patchPath: join(dir3, "cordis.patch.yml"), profileDir: dir3 };
await writeFile(
	layout3.patchPath,
	["- id: custom-id", "  name: '@deepseek-ai/dsh-mcp-client'", "  config:", "    serverName: handwritten", "    transport: stdio", "    command: npx", ""].join("\n"),
	"utf8"
);
await upsertMcpServer(layout3, { serverName: "renamed-hand", transport: "stdio", command: "npx" }, "custom-id");
const hand = (await listMcpServers(layout3))[0];
check(hand?.id === "custom-id", "a hand-written row id is not rewritten by a rename", String(hand?.id));
check(hand?.serverName === "renamed-hand", "the hand-written row still takes the new name", String(hand?.serverName));
await deleteMcpServer(layout3, hand.id);
check((await listMcpServers(layout3)).length === 0, "a drifted row deletes by the id the listing reports", "");

// --- two rows may not end up sharing an id or a server name ----------------
// The listing is what the panel addresses a row by, and it takes the first match: a duplicate
// means a toggle or a delete lands on the wrong server, and two rows expose one tool
// namespace. A rename onto a name another row already uses is the same clash reached from the
// other end, and so is adding a server whose name a hand-written row already carries.
const dir4 = await mkdtemp(join(tmpdir(), "kit-mcp-clash-"));
const layout4 = { patchPath: join(dir4, "cordis.patch.yml"), profileDir: dir4 };
await writeFile(layout4.patchPath, "- insert: []\n", "utf8");
await upsertMcpServer(layout4, { serverName: "alpha", transport: "stdio", command: "npx" });
await upsertMcpServer(layout4, { serverName: "beta", transport: "stdio", command: "npx" });
let renameClash = "";
try {
	await upsertMcpServer(layout4, { serverName: "beta", transport: "stdio", command: "npx" }, "mcp-alpha");
} catch (error) {
	renameClash = String(error.message);
}
const afterClash = await listMcpServers(layout4);
check(renameClash.includes("beta"), "a rename onto a name another row uses is refused", renameClash || "(the rename was allowed)");
check(
	afterClash.length === 2 && new Set(afterClash.map((server) => server.id)).size === 2,
	"the refused rename leaves one id per row",
	JSON.stringify(afterClash.map((server) => `${server.id}=${server.serverName}`))
);

const dir5 = await mkdtemp(join(tmpdir(), "kit-mcp-drifted-"));
const layout5 = { patchPath: join(dir5, "cordis.patch.yml"), profileDir: dir5 };
await writeFile(
	layout5.patchPath,
	["- insert:", "    - id: custom-id", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:", "        serverName: web", "        transport: stdio", "        command: npx", ""].join("\n"),
	"utf8"
);
let addClash = "";
try {
	await upsertMcpServer(layout5, { serverName: "web", transport: "stdio", command: "uvx" });
} catch (error) {
	addClash = String(error.message);
}
check(
	addClash.includes("web") && (await listMcpServers(layout5)).length === 1,
	"adding a server whose name a hand-written row already uses is refused",
	addClash || "(the add was allowed)"
);

const failed = results.filter((result) => !result.ok);
for (const result of results) console.log(`${result.ok ? "ok  " : "FAIL"} ${result.label}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(failed.length === 0 ? "\nMCP TEST PASS" : `\nMCP TEST FAIL (${failed.length})`);
if (failed.length > 0) {
	console.log("\n--- resulting document ---\n" + after);
	process.exitCode = 1;
}
