// "Restart session": which rows may be restarted and whether to ask first, as pure functions.
// Depends on neither `obsidian` nor `main.ts`.

import type { TerminalStatus } from "./terminal-status";

export interface RestartInput {
	/** The daemon holds the session and it hasn't exited (attached or detached). */
	running: boolean;
	/** The row's id is the agent's real conversation id (not a Codex/OpenCode placeholder still being resolved). */
	resumable: boolean;
	status: TerminalStatus;
}

export interface RestartDecision {
	enabled: boolean;
	/** Restarting would interrupt work in progress, so ask first. */
	needsConfirm: boolean;
}

/** Statuses in which a restart would cut off a running turn or command. */
const BUSY_STATUSES: ReadonlySet<TerminalStatus> = new Set(["working", "running-shell"]);

export function restartDecision(input: RestartInput): RestartDecision {
	const enabled = input.running && input.resumable;
	return { enabled, needsConfirm: enabled && BUSY_STATUSES.has(input.status) };
}
