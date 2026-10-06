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
