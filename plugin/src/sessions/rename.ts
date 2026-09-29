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
