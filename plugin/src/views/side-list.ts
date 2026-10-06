// Builds the side panel's list (pure functions). No dependency on `obsidian`.
// `side.ts` calls `buildSideList` through here (kept separate for testing).

import type { Row } from "../sessions/index";
import { buildSideList, type SideList } from "../sessions/tree";

export interface TerminalLeafLike {
	getViewState(): { state?: { id?: unknown; agent?: unknown; cwd?: unknown } };
}

/** Builds the list of ids, in tab order, from an array of terminal-tab leaves. */
export function leafIdsOf(leaves: TerminalLeafLike[]): string[] {
	return leaves.map((leaf) => leaf.getViewState().state?.id).filter((id): id is string => typeof id === "string");
}

/** What the side panel knows about a tab whose session has no row yet. */
export interface TabOnlySource {
	/** A name given to the session before it has a row (`plugin.pendingName`). */
	pendingName(id: string): string | undefined;
	/** Whether the agent is enabled (a tab of a switched-off agent isn't listed). */
	agentEnabled(agent: string): boolean;
}

/**
 * The stand-in row for an open tab whose session has no row yet — a new session before its first
 * message, or a Codex/OpenCode tab still under its placeholder id: the tab's id, agent and folder,
 * and the name it was given. `last_activity` is 0 (no time is shown) and it counts as running
 * (`daemon`), so the row offers what its tab does. `null` without an id.
 */
export function tabOnlyRow(state: { id?: unknown; agent?: unknown; cwd?: unknown } | undefined, name: string | undefined): Row | null {
	if (typeof state?.id !== "string" || !state.id) {
		return null;
	}
	const cwd = typeof state.cwd === "string" ? state.cwd : "";
	return {
		id: state.id,
		agent: typeof state.agent === "string" && state.agent ? state.agent : "claude",
		name: name || null,
		group: null,
		label: null,
		cwd,
		folder: cwd,
		last_activity: 0,
		child: false,
		transcript: null,
		status: null,
		waitingFor: null,
		compacted: false,
		pid: null,
		rc: false,
		daemon: true,
		exited: null,
		hasTab: true,
		archived: false,
		tabOnly: true,
	};
}

/**
 * Builds the side panel's three sections from `SessionIndex.sessions` and the tab order. With
 * `tabOnly`, an open tab whose id has no row is listed under "Open tabs" with its `tabOnlyRow`.
 */
export function computeSideList(
	sessions: Map<string, Row>,
	leaves: TerminalLeafLike[],
	recentCount: number,
	tabOnly?: TabOnlySource
): SideList {
	const standIns = new Map<string, Row>();
	if (tabOnly) {
		for (const leaf of leaves) {
			const state = leaf.getViewState().state;
			if (typeof state?.id !== "string" || sessions.has(state.id)) {
				continue;
			}
			const row = tabOnlyRow(state, tabOnly.pendingName(state.id));
			if (row && tabOnly.agentEnabled(row.agent)) {
				standIns.set(row.id, row);
			}
		}
	}
	return buildSideList([...sessions.values()], leafIdsOf(leaves), recentCount, standIns);
}
