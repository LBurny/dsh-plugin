/**
 * dsh-init: the `/init` command that writes or updates this workspace's AGENTS.md.
 *
 * Ported from DSHDesktop's built-in `/init` plugin, which is the same command
 * the desktop shell preseeded into its own profile. Two things are kept from it
 * on purpose: the prompt teaches the model how this harness actually loads
 * instruction files (the workspace root chain, the personal overlays, the
 * user-global file it must not touch), and the result is delivered as a
 * collapsed context row rather than a user bubble.
 *
 * One thing differs, and it is the whole reason a port had to happen: the
 * injected message carries a producer-owned source kind (`plugin:dsh-init`).
 * Session format V4 refuses the retired generic `kind: "plugin"` wrapper
 * outright, and a refused write fails the entire turn, so a command that
 * registers fine would silently do nothing.
 *
 * A command handler may only return a line of text, so the work is not done
 * here: the prompt is queued on the agent's next turn with `followup`, which is
 * what makes `/init` read as a command in the transcript while the model still
 * receives the full text. `form: "notice"` is what renders the row collapsed.
 *
 * @module dsh-init/index
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "init";
const inject = ["commands"];

/** Human-facing one-liner in the command palette, kept identical to the built-in's. */
const DESCRIPTION = "Create or update this workspace's AGENTS.md instruction file";
/** Placeholder shown while composing `/init <extra>`. */
const INPUT_HINT = "additional instructions (optional)";

/** One-line label on the collapsed context row (convention: 120 characters at most). */
const NOTICE_SUMMARY = "Create/update AGENTS.md workspace instructions";

/** The plugin's own message source kind; V4 requires a producer-owned one. */
const SOURCE_KIND = "plugin:dsh-init";

/**
 * Render the authoring prompt with the workspace root and the user's extra
 * instructions filled in.
 *
 * The loading rules it spells out are the reason this prompt is long: without
 * them the model writes generic advice and misses that the harness also loads
 * CLAUDE.md, the per-directory overlays and the user-global file, and that a
 * nested AGENTS.md outranks the root one for work under its directory.
 *
 * @param cwd - the session's workspace root, when the invocation carries one.
 * @param extra - the raw text typed after `/init`, possibly empty.
 * @returns the prompt submitted to the agent.
 */
function renderPrompt(cwd, extra) {
	const workspace = cwd ?? "<workspace root: the directory the agent is currently running in>";
	const args = extra.length > 0 ? extra : "(none supplied)";
	return `Your task is to create or update a concise workspace instruction file for future AI coding agents.

How this harness consumes instruction files (use this to decide what to write and where):
- It loads AGENTS.md and CLAUDE.md from the workspace root (both, if both exist), plus same-directory personal overlays AGENTS.local.md / CLAUDE.local.md, plus nested AGENTS.md / CLAUDE.md files in directories between the project root and the working directory (more specific files take precedence for work under their directory), plus a user-global ~/.dsh/AGENTS.md.
- Loaded instructions are injected into the context of every session in this workspace, so brevity matters.

Target:
- Workspace directory: ${workspace}
- Instruction file: ${workspace}/AGENTS.md
- File name must be exactly AGENTS.md.
- This command targets the current workspace only. Never write or edit the user-global ~/.dsh/AGENTS.md or anything outside the workspace, and do not create or modify *.local.md personal overlays.

Additional user instructions supplied with /init:
\`\`\`text
${args}
\`\`\`

Process:
1. Before writing, check which instruction files already exist at the workspace root: AGENTS.md, CLAUDE.md, and any *.local.md overlays.
2. If AGENTS.md already exists at the workspace root, read it first and update it incrementally with targeted edits instead of replacing it wholesale. If only CLAUDE.md exists, update that file instead, and mention to the user that this harness loads both names.
3. If neither exists, create AGENTS.md at the workspace root.
4. Inspect the repository before writing. Use the available read-only file and search tools; if you use the shell, stick to read-only commands such as directory listing, git status, and package-manager script inspection.
5. Keep the file practical and short enough to read quickly. Its full content enters the context of every future session in this workspace.
6. Include only project-specific facts future agents would otherwise miss; omit anything obvious from a quick look at the repo.
7. If the repo is a monorepo whose packages have materially different conventions, note in the root file that nested AGENTS.md files may exist per package instead of duplicating their content.
8. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.

Recommended AGENTS.md content:
- Repository purpose and major directories.
- Build, typecheck, lint, and focused test commands discovered from the repo (use the actual package manager and script names present).
- Architecture boundaries and layer rules that matter for edits.
- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.
- Known gotchas a newcomer would trip over: build quirks, platform-specific behavior, tooling or runtime constraints.
- Any documentation files that agents should read before changing sensitive areas.

After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.`;
}

/**
 * Submit the rendered prompt on the invocation's agent and report back.
 *
 * `followup` queues the message for the next turn and wakes the driver, so an
 * idle agent starts a fresh turn with the prompt as its input, while the
 * transcript shows one collapsible context row carrying just the summary.
 *
 * @param invocation - the command invocation (workspace root plus raw input).
 * @returns the palette's result line.
 */
function executeInit(invocation) {
	const cwd = invocation.agent?.session?.header?.cwd;
	const extra = invocation.rawInput.trim();
	const text = renderPrompt(typeof cwd === "string" && cwd.length > 0 ? cwd : undefined, extra);
	invocation.agent.followup(createUserMessage({
		content: [{ type: "text", text }],
		source: {
			kind: SOURCE_KIND,
			form: "notice",
			summary: extra.length > 0 ? `${NOTICE_SUMMARY} (+ additional instructions)` : NOTICE_SUMMARY
		}
	}));
	return { kind: "success", text: "Prompt submitted to prepare for generating the AGENTS.md file" };
}

/**
 * Register `/init` on the shared human-command registry.
 *
 * The registration is guarded because this name is owned elsewhere in the
 * ecosystem: DSHDesktop ships its own `/init` plugin and the single-package
 * desktop kit keeps a fallback behind a config flag. A clash is already
 * survivable (dsh warns and deactivates the losing row), but an exception out
 * of `apply` is not, so a refused registration only leaves a log line.
 *
 * @param ctx - context carrying the command registry.
 */
function apply(ctx) {
	ctx.effect(function* () {
		try {
			yield ctx.commands.register({
				name,
				description: DESCRIPTION,
				input: { hint: INPUT_HINT },
				handler: executeInit
			});
		} catch (error) {
			ctx.logger?.warn?.(`[dsh-init] /init was not registered: ${String(error?.message ?? error)}`);
		}
	}, "dsh-init lifecycle");
}

export { apply, inject, name };
