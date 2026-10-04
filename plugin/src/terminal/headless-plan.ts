// What the headless command route (`main.ts`'s `sendHeadless`) does around one command: which
// bytes clear the input line first, what it waits for after the command, and whether `/exit`
// may follow. Pure, so the sequence can be tested without a PTY.

import type { AgentId } from "../settings";

/** Ctrl+U: Claude Code's input line deletes back to the start of the line on it. */
export const CLEAR_LINE = "\x15";

/** How long a `/rename` gets to show up as the session's new name before the route gives up. */
export const RENAME_WAIT_MS = 10_000;

export type HeadlessWait =
	| { kind: "name"; name: string; timeoutMs: number }
	/** The existing wait: `busy` (bounded; some commands never go busy), then back to `idle`. */
	| { kind: "busy-idle" };

export interface HeadlessPlan {
	/** Written (alone) before the command; "" when the agent has no verified clear-line key. */
	clearBeforeCommand: string;
	/** Written (alone) before `/exit`, so a command left unsubmitted can't prefix it. */
	clearBeforeExit: string;
	wait: HeadlessWait;
}

/** Claude Code only: Codex and OpenCode have no clear-line key verified here, so their sequence is unchanged. */
function clearLineFor(agent: AgentId): string {
	return agent === "claude" ? CLEAR_LINE : "";
}

export function planHeadlessCommand(agent: AgentId, text: string): HeadlessPlan {
	const clear = clearLineFor(agent);
	const rename = /^\/rename\s+(\S.*)$/.exec(text.trim());
	return {
		clearBeforeCommand: clear,
		clearBeforeExit: clear,
		wait: rename ? { kind: "name", name: rename[1].trim(), timeoutMs: RENAME_WAIT_MS } : { kind: "busy-idle" },
	};
}

/**
 * After the wait: `exit` sends `/exit`; `teardown` kills the process without it. Only a rename
 * whose name never appeared tears down — `/exit` then would land on a line that still holds
 * the unsubmitted command.
 */
export function afterWait(wait: HeadlessWait, satisfied: boolean): "exit" | "teardown" {
	return wait.kind === "name" && !satisfied ? "teardown" : "exit";
}
