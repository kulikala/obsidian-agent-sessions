// How a rename reaches a session, decided by the agent that runs it.

export interface SessionAgentSources {
	/** The open tab's own agent — known even before the session has an index row. */
	tab?: string;
	/** The index row's agent. */
	row?: string;
	/** The agent recorded in `sessions.json`. */
	stored?: string;
}

/** The agent a session id belongs to: the tab first (a fresh tab has no row and no store entry
 * under its placeholder id), then the row, then the store; Claude if nothing says otherwise. */
export function sessionAgentOf(sources: SessionAgentSources): string {
	return sources.tab || sources.row || sources.stored || "claude";
}

/**
 * - `command`: type `/rename <name>` into the session (Claude Code, Codex).
 * - `pending`: OpenCode with no real id yet — keep the name in memory, write it when the id is linked.
 * - `store`: OpenCode with a real id — write the name to `sessions.json`; the TUI is not touched
 *   (it has no `/rename`, and the text would go to the model as a prompt).
 */
export type RenameRoute = "command" | "pending" | "store";

export function renameRoute(agent: string, unresolvedTab: boolean): RenameRoute {
	if (agent !== "opencode") {
		return "command";
	}
	return unresolvedTab ? "pending" : "store";
}

/**
 * How a name given when a session is created reaches it:
 * - `launch`: Claude Code — `--name` on the command line, and `/rename` once it is idle.
 * - `composer`: Codex — `/rename` typed into its composer as soon as that is on screen and empty
 *   (Codex names its thread before the first message, and holds input typed before the thread has
 *   started until it has), checked again once the real id is linked.
 * - `afterTurn`: Codex started with its first message — `/rename` once the real id is linked and
 *   that first turn has ended, unless the session was renamed meanwhile. Typed at once, the line
 *   would wait in Codex's queue behind the turn and land after a rename made during it.
 * - `pending`: OpenCode — kept in memory until the real id is linked, then written to `sessions.json`.
 */
export type CreateNameRoute = "launch" | "composer" | "afterTurn" | "pending";

export function createNameRoute(agent: string, withFirstMessage = false): CreateNameRoute {
	if (agent === "codex") {
		return withFirstMessage ? "afterTurn" : "composer";
	}
	return agent === "opencode" ? "pending" : "launch";
}
