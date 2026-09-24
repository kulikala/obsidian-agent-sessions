// Builds the side panel's list (pure functions). No dependency on `obsidian`.
// `side.ts` calls `buildSideList` through here (kept separate for testing).

import type { Row } from "../sessions/index";
import { buildSideList, type SideList } from "../sessions/tree";

export interface TerminalLeafLike {
	getViewState(): { state?: { id?: unknown } };
}

/** Builds the list of ids, in tab order, from an array of terminal-tab leaves. */
export function leafIdsOf(leaves: TerminalLeafLike[]): string[] {
	return leaves.map((leaf) => leaf.getViewState().state?.id).filter((id): id is string => typeof id === "string");
}

/** Builds the side panel's three sections from `SessionIndex.sessions` and the tab order. */
export function computeSideList(
	sessions: Map<string, Row>,
	leaves: TerminalLeafLike[],
	recentCount: number
): SideList {
	return buildSideList([...sessions.values()], leafIdsOf(leaves), recentCount);
}
