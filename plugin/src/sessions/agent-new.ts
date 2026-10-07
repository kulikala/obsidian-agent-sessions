// Codex's `/new` and `/clear`, and OpenCode's `/new`, start a new session in the tab's running
// process, the way Claude Code's `/clear` does. Neither agent reports the switch, so the plugin
// asks `json moved <agent>` (`backend.ts`'s `moved`): which session the tab's process started
// after the tab took its current id, that nothing is linked to yet. Python ties the session to the
// process exactly (Codex: the rollout the process has open; OpenCode: the pid in the plugin's status
// file) and leaves out a session that `/resume` or the session list reopened and one `/fork` made.
// These pure functions decide which tabs to ask about and from when; `main.ts`'s `followAgentNew`
// asks, links and relabels. No `obsidian` here, so it is tested in plain Node
// (test/sessions/agent-new.test.ts).

/** Slack for start times known only to the second, and for a link written a moment after the
 * session it links began. */
export const AGENT_NEW_SLACK_MS = 2_000;
/** How often a tab is asked about without a sign that it switched (a Codex tab whose turn ended,
 * an OpenCode status file nobody knows). */
export const AGENT_NEW_RECHECK_MS = 60_000;

/** A running Codex or OpenCode tab linked to its real session id. */
export interface AgentNewTab {
	/** The tab's current session id. */
	id: string;
	agent: "codex" | "opencode";
	/** The pid the daemon started (`DaemonSession.pid`). */
	pid: number;
	/** When the daemon started the process (ms since the epoch). */
	startedAt: number;
	/** When the tab took its current id (ms since the epoch), when the plugin saw it happen. */
	linkedAt?: number;
}

/** Seconds since the epoch from which a session the tab's process starts is the tab's `/new`:
 * when the tab took its current id, or else when its process started. A session created earlier
 * (the one the tab is on, one reopened with `/resume`) is not. */
export function newSince(tab: AgentNewTab): number {
	return (Math.max(tab.startedAt, tab.linkedAt ?? 0) - AGENT_NEW_SLACK_MS) / 1000;
}

/**
 * The tabs worth a `json moved` call now: those in `due` (a Codex tab whose turn just ended — the
 * new session's first message makes its rollout), every OpenCode tab when the ledger shows an
 * OpenCode session no tab or link knows that it didn't show before (`newOpencode`: the status file
 * of the new session), and any tab not asked for `AGENT_NEW_RECHECK_MS` (`askedAt`, by tab id).
 */
export function tabsToAsk(
	tabs: readonly AgentNewTab[],
	opts: { due: ReadonlySet<string>; newOpencode: boolean; askedAt: ReadonlyMap<string, number>; now: number }
): AgentNewTab[] {
	return tabs.filter(
		(tab) =>
			opts.due.has(tab.id) ||
			(tab.agent === "opencode" && opts.newOpencode) ||
			opts.now - (opts.askedAt.get(tab.id) ?? 0) >= AGENT_NEW_RECHECK_MS
	);
}

/** The OpenCode sessions (`ses_…`) among the ledger's ids that no open tab and no `sessions.json`
 * entry knows (`known`). One that wasn't there before may be a tab's `/new`. */
export function unknownOpencode(ids: Iterable<string>, known: (id: string) => boolean): string[] {
	return [...ids].filter((id) => id.startsWith("ses_") && !known(id));
}
