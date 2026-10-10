// "Organize names and categories": which agent answers, the argv of its headless run, and the
// parsing of its output — one pure place per agent. The process spawning lives in
// `backend/headless.ts`. Kept free of any `obsidian` import so tests can import it directly.

import type { AgentId, OrganizeModel } from "../settings";

/** The Claude Code models a headless run may name: Organize offers Sonnet and Haiku, token
 * efficiency Sonnet and Opus. */
export type HeadlessModel = OrganizeModel | "opus";

/** What the dialog needs of an agent's settings to choose. */
export type AgentEnabled = Record<AgentId, { enabled: boolean }>;

/** The order in which an enabled agent is preferred: Claude Code first. */
const PREFERENCE: readonly AgentId[] = ["claude", "codex", "opencode"];

/** The agent that answers: Claude Code when enabled, else Codex, else OpenCode. `null` when none
 * of them is enabled. */
export function pickOrganizeAgent(agents: AgentEnabled): AgentId | null {
	return PREFERENCE.find((id) => agents[id].enabled) ?? null;
}

/** The model asked for, where the CLI lets one be named (Claude Code: the "Model for suggestions"
 * setting, Sonnet by default); the others use their own default. */
export function organizeModel(agent: AgentId, setting: HeadlessModel = "sonnet"): string | null {
	return agent === "claude" ? setting : null;
}

/** Display name of the agent and (when named) its model: "Claude Code (sonnet)". */
export function agentLabel(agent: AgentId, setting: HeadlessModel = "sonnet"): string {
	const name = agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "OpenCode";
	const model = organizeModel(agent, setting);
	return model ? `${name} (${model})` : name;
}

/** Codex features that give the model a tool (a shell, apps, a browser, sub-agents, images,
 * plugins and skills); a headless run turns each of them off. */
const CODEX_TOOL_FEATURES = [
	"shell_tool",
	"unified_exec",
	"apps",
	"browser_use",
	"computer_use",
	"in_app_browser",
	"image_generation",
	"view_image",
	"multi_agent",
	"plugins",
	"skill_search",
	"tool_suggest",
	"sleep_tool",
];

/** The OpenCode agent a headless run uses, defined by `headlessEnv` with every permission denied. */
export const OPENCODE_HEADLESS_AGENT = "agent-sessions-headless";

/**
 * The MCP servers a Codex `config.toml` declares (`[mcp_servers.<name>]`, also as a sub-table),
 * so a headless run can turn each one off: Codex's `-c` sets keys one at a time and cannot empty
 * the table. Names Codex's `-c` path cannot spell (anything but letters, digits, `_` and `-`) are
 * left out.
 */
export function codexMcpServers(configToml: string | null): string[] {
	const names = new Set<string>();
	for (const m of (configToml ?? "").matchAll(/^\s*\[\s*mcp_servers\s*\.\s*("?)([A-Za-z0-9_-]+)\1\s*[.\]]/gm)) {
		names.add(m[2]);
	}
	return [...names];
}

/**
 * The arguments of the headless run; the prompt is written to stdin for all three. None of them
 * has a tool: what the prompt quotes from conversations is data, and a model that follows an
 * instruction inside it has nothing to act with.
 * - Claude Code: no tools, MCP servers, hooks or skills, and no transcript.
 * - Codex: `exec` with a read-only sandbox, outside a Git repository, no rollout file, and the
 *   user's execpolicy rules off; the shell and every other tool feature, web search and each
 *   MCP server in `mcpServers` (`codexMcpServers`) turned off; events as JSONL.
 * - OpenCode: `run` without external plugins, as `OPENCODE_HEADLESS_AGENT` (every tool denied,
 *   see `headlessEnv`), events as JSON.
 * `extraArgs` (a model for Codex `-m` or OpenCode `--model`) go before Codex's `-` (the prompt
 * from stdin) and at the end for the others.
 */
export function headlessArgs(
	agent: AgentId,
	setting: HeadlessModel = "sonnet",
	extraArgs: string[] = [],
	mcpServers: string[] = []
): string[] {
	switch (agent) {
		case "claude":
			return [
				"-p",
				"--model",
				organizeModel("claude", setting) ?? "sonnet",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--tools",
				"",
				"--strict-mcp-config",
				"--disable-slash-commands",
				"--no-session-persistence",
				"--settings",
				JSON.stringify({ disableAllHooks: true }),
				...extraArgs,
			];
		case "codex":
			return [
				"exec",
				"--skip-git-repo-check",
				"--sandbox",
				"read-only",
				"--ephemeral",
				"--ignore-rules",
				...CODEX_TOOL_FEATURES.flatMap((f) => ["-c", `features.${f}=false`]),
				"-c",
				'web_search="disabled"',
				...mcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
				"--json",
				...extraArgs,
				"-",
			];
		case "opencode":
			return ["run", "--pure", "--agent", OPENCODE_HEADLESS_AGENT, "--format", "json", ...extraArgs];
	}
}

/**
 * The environment of the headless run: for OpenCode, `OPENCODE_CONFIG_CONTENT` defines
 * `OPENCODE_HEADLESS_AGENT` with every permission (and so every tool, MCP ones included) denied,
 * added to a config the user already passes that way. The others run with `env` as it is.
 */
export function headlessEnv(agent: AgentId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (agent !== "opencode") {
		return env;
	}
	let config: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
		config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		config = {};
	}
	const agents = asRecord(config.agent);
	const headless = {
		mode: "primary",
		description: "Agent Sessions: one answer from text, without tools.",
		permission: { "*": "deny", external_directory: "deny" },
	};
	return {
		...env,
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, agent: { ...agents, [OPENCODE_HEADLESS_AGENT]: headless } }),
	};
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The JSON events of a stdout: one document (an object or an array of events) or JSON lines. */
export function parseEvents(stdout: string): Record<string, unknown>[] {
	const whole = tryParse(stdout.trim());
	const raw: unknown[] = Array.isArray(whole)
		? whole
		: whole && typeof whole === "object"
			? [whole]
			: stdout.split("\n").map((line) => tryParse(line.trim()));
	return raw.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e));
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The model's reply text from a Claude Code `result` event (throws on a reported error). */
function claudeReply(events: Record<string, unknown>[]): string {
	for (const rec of [...events].reverse()) {
		if (rec.type !== "result" && !("result" in rec)) {
			continue;
		}
		if (rec.is_error === true) {
			throw new Error(asString(rec.result) || "claude reported an error");
		}
		if (typeof rec.result === "string") {
			return rec.result;
		}
	}
	throw new Error("unexpected output from claude");
}

/** Codex `exec --json`: the last `agent_message` item; `error` / `turn.failed` events throw. */
function codexReply(events: Record<string, unknown>[]): string {
	let reply: string | null = null;
	let failure = "";
	for (const rec of events) {
		const item = asRecord(rec.item);
		if (rec.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
			reply = item.text;
		} else if (rec.type === "turn.failed") {
			failure = asString(asRecord(rec.error).message) || failure || "codex reported an error";
		} else if (rec.type === "error") {
			failure = asString(rec.message) || failure || "codex reported an error";
		}
	}
	if (reply !== null) {
		return reply;
	}
	throw new Error(failure || "unexpected output from codex");
}

/** OpenCode `run --format json`: the `text` parts joined; an `error` event throws. */
function opencodeReply(events: Record<string, unknown>[]): string {
	const parts: string[] = [];
	let failure = "";
	for (const rec of events) {
		if (rec.type === "text") {
			const text = asString(asRecord(rec.part).text);
			if (text) {
				parts.push(text);
			}
		} else if (rec.type === "error") {
			const err = asRecord(rec.error);
			failure = asString(asRecord(err.data).message) || asString(err.message) || asString(err.name) || "opencode reported an error";
		}
	}
	if (parts.length > 0) {
		return parts.join("");
	}
	throw new Error(failure || "unexpected output from opencode");
}

/** The reply text out of a finished run's stdout. Throws with the CLI's own message on an error. */
export function parseAgentOutput(agent: AgentId, stdout: string): string {
	const events = parseEvents(stdout);
	return agent === "claude" ? claudeReply(events) : agent === "codex" ? codexReply(events) : opencodeReply(events);
}

/**
 * How many characters of answer one streamed line adds (0 for anything else), so the dialog can
 * show that text is arriving. Claude Code streams `text_delta`s; Codex and OpenCode send a
 * whole message at a time.
 */
export function streamedChars(agent: AgentId, line: string): number {
	const rec = tryParse(line.trim());
	if (!rec || typeof rec !== "object") {
		return 0;
	}
	const ev = rec as Record<string, unknown>;
	if (agent === "claude") {
		const delta = asRecord(asRecord(ev.event).delta);
		return ev.type === "stream_event" && delta.type === "text_delta" ? asString(delta.text).length : 0;
	}
	if (agent === "codex") {
		const item = asRecord(ev.item);
		return ev.type === "item.completed" && item.type === "agent_message" ? asString(item.text).length : 0;
	}
	return ev.type === "text" ? asString(asRecord(ev.part).text).length : 0;
}

/** OpenCode keeps the session of a `run` in its database (hidden from the list); its id, from
 * any event line, lets the dialog delete exactly that session afterwards. */
export function opencodeSessionId(stdout: string): string | null {
	for (const rec of parseEvents(stdout)) {
		const id = rec.sessionID;
		if (typeof id === "string" && /^ses_[A-Za-z0-9]+$/.test(id)) {
			return id;
		}
	}
	return null;
}

/** What one headless run cost, as its CLI reported it: tokens in (cache reads and writes
 * included) and out, and dollars when the CLI says (`null` otherwise). */
export interface HeadlessUsage {
	input: number;
	output: number;
	usd: number | null;
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The usage of a finished run, from its stdout, or `null` when the output has none:
 * - Claude Code: the last `result` event's `usage` (input + cache creation + cache read, and
 *   output) and `total_cost_usd`.
 * - Codex: the `turn.completed` events' `usage` (input and output; no dollars).
 * - OpenCode: the `step_finish` events' `part.tokens` (input + cache, output + reasoning) and
 *   `part.cost`.
 */
export function headlessUsage(agent: AgentId, stdout: string): HeadlessUsage | null {
	const events = parseEvents(stdout);
	if (agent === "claude") {
		const result = [...events].reverse().find((e) => e.type === "result" && e.usage && typeof e.usage === "object");
		if (!result) {
			return null;
		}
		const u = asRecord(result.usage);
		return {
			input: asNumber(u.input_tokens) + asNumber(u.cache_creation_input_tokens) + asNumber(u.cache_read_input_tokens),
			output: asNumber(u.output_tokens),
			usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
		};
	}
	let found = false;
	const total: HeadlessUsage = { input: 0, output: 0, usd: null };
	for (const e of events) {
		if (agent === "codex" && e.type === "turn.completed" && e.usage) {
			const u = asRecord(e.usage);
			total.input += asNumber(u.input_tokens);
			total.output += asNumber(u.output_tokens);
			found = true;
		} else if (agent === "opencode" && e.type === "step_finish") {
			const part = asRecord(e.part);
			const tokens = asRecord(part.tokens);
			const cache = asRecord(tokens.cache);
			total.input += asNumber(tokens.input) + asNumber(cache.read) + asNumber(cache.write);
			total.output += asNumber(tokens.output) + asNumber(tokens.reasoning);
			if (typeof part.cost === "number") {
				total.usd = (total.usd ?? 0) + part.cost;
			}
			found = true;
		}
	}
	return found ? total : null;
}

/** Adds two usages (a run and its retry); `null` when neither is known. */
export function addUsage(a: HeadlessUsage | null, b: HeadlessUsage | null): HeadlessUsage | null {
	if (!a || !b) {
		return a ?? b;
	}
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
	};
}

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/** Whether a finished run used tools (a run is asked to answer from the data it is given): Codex
 * `item.*` events of a command, file change, MCP call or web search; OpenCode `tool_use` events.
 * Claude Code's run has no tools to use. */
export function usedTools(agent: AgentId, stdout: string): boolean {
	return parseEvents(stdout).some((e) => {
		if (agent === "codex") {
			return typeof e.type === "string" && e.type.startsWith("item.") && CODEX_TOOL_ITEMS.has(asString(asRecord(e.item).type));
		}
		return agent === "opencode" && e.type === "tool_use";
	});
}
