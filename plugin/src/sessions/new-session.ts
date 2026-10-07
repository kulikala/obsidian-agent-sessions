// Pure parts of starting a new session (`main.ts`'s `newSession`), kept free of any `obsidian`
// import so tests can import them directly.

import type { LaunchStart } from "../backend/backend";
import type { AgentId } from "../settings";

/** Options of `newSession`: the first message and permission mode (`LaunchStart`), and whether
 * the agent becomes the new-session dialog's default (`remember`, true unless said otherwise --
 * a session started to fix a token efficiency finding leaves the user's choice alone). */
export interface NewSessionOptions extends LaunchStart {
	remember?: boolean;
}

/** Records `agent` as the last one used, unless `remember` is false or it already is. Returns
 * whether the settings changed (and need saving). */
export function rememberAgent(
	settings: { lastNewSessionAgent: AgentId },
	agent: AgentId,
	opts: NewSessionOptions = {}
): boolean {
	if (opts.remember === false || agent === settings.lastNewSessionAgent) {
		return false;
	}
	settings.lastNewSessionAgent = agent;
	return true;
}

/** The part of `opts` the launch needs, or `undefined` when there is none. */
export function launchStart(opts: NewSessionOptions = {}): LaunchStart | undefined {
	const start: LaunchStart = {};
	if (opts.prompt) {
		start.prompt = opts.prompt;
	}
	if (opts.permissionMode) {
		start.permissionMode = opts.permissionMode;
	}
	return start.prompt || start.permissionMode ? start : undefined;
}

/** The longest first message OpenCode on Windows takes as `--prompt`: a longer one leaves its TUI
 * at "Loading plugins…" / "Finishing startup…" and it exits (OpenCode 1.18 under ConPTY). */
export const OPENCODE_WINDOWS_PROMPT_MAX = 200;

/** Whether a fresh session's first message is typed into the agent once it is ready, instead of
 * going on the command line: OpenCode on Windows, for a message over
 * `OPENCODE_WINDOWS_PROMPT_MAX` characters. */
export function typesFirstMessage(agent: AgentId, prompt: string | undefined, platform: string = process.platform): boolean {
	return agent === "opencode" && platform === "win32" && !!prompt && prompt.length > OPENCODE_WINDOWS_PROMPT_MAX;
}

/** Whether OpenCode's TUI is ready for input: its footer (`ctrl+p commands`) is on screen. */
export function opencodeReady(screen: string): boolean {
	return /ctrl\+p commands/.test(screen);
}
