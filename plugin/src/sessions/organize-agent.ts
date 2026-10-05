// "Organize names and categories": which agent answers, the argv of its headless run, and the
// parsing of its output — one pure place per agent. The process spawning lives in
// `backend/headless.ts`. Kept free of any `obsidian` import so tests can import it directly.

import type { AgentId, OrganizeModel } from "../settings";

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
export function organizeModel(agent: AgentId, setting: OrganizeModel = "sonnet"): string | null {
	return agent === "claude" ? setting : null;
}

/** Display name of the agent and (when named) its model: "Claude Code (sonnet)". */
export function agentLabel(agent: AgentId, setting: OrganizeModel = "sonnet"): string {
	const name = agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "OpenCode";
	const model = organizeModel(agent, setting);
	return model ? `${name} (${model})` : name;
}

/**
 * The arguments of the headless run; the prompt is written to stdin for all three.
 * - Claude Code: no tools, MCP servers, hooks or skills, and no transcript.
 * - Codex: `exec` with a read-only sandbox, outside a Git repository, no rollout file, and the
 *   user's execpolicy rules off; events as JSONL.
 * - OpenCode: `run` without external plugins, events as JSON.
 */
export function headlessArgs(agent: AgentId, setting: OrganizeModel = "sonnet"): string[] {
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
			];
		case "codex":
			return [
				"exec",
				"--skip-git-repo-check",
				"--sandbox",
				"read-only",
				"--ephemeral",
				"--ignore-rules",
				"--json",
				"-",
			];
		case "opencode":
			return ["run", "--pure", "--format", "json"];
	}
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
