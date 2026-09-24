// Tallies sessions that need the user's attention (pure functions). Priority order, highest
// first: asking (Claude is waiting on an answer — AskUserQuestion, a permission prompt, etc.)
// then waiting (went busy→idle but that tab hasn't been brought to front yet, i.e. unread) —
// the same priority order as `terminal-status.ts`'s `terminalStatus`. No dependency on
// `obsidian` (tested in test/attention.test.ts).

import type { Row } from "./index";
import { resolveRowStatus, type TerminalStatusSource } from "./terminal-status";

export interface AttentionCounts {
	asking: number;
	waiting: number;
	/** The session a click should open: the first asking one, or failing that the first waiting one. `null` if neither exists. */
	jumpToId: string | null;
}

/** Counts asking/waiting sessions among `rows`, and picks a jump target (asking takes
 * priority). Backs the side panel's badge. */
export function attentionCounts(source: TerminalStatusSource, rows: Row[]): AttentionCounts {
	let asking = 0;
	let waiting = 0;
	let firstAskingId: string | null = null;
	let firstWaitingId: string | null = null;
	for (const row of rows) {
		const status = resolveRowStatus(source, row);
		if (status === "asking") {
			asking++;
			if (firstAskingId === null) {
				firstAskingId = row.id;
			}
		} else if (status === "waiting") {
			waiting++;
			if (firstWaitingId === null) {
				firstWaitingId = row.id;
			}
		}
	}
	return { asking, waiting, jumpToId: firstAskingId ?? firstWaitingId };
}

export type GroupUrgency = "asking" | "waiting";

/**
 * The highest-priority status (asking > waiting) for each group key (`keyOf`). Counted across
 * all of `rows` regardless of whether the group is folded — the manager's group heading needs
 * to reflect what's inside even when collapsed. Archived rows aren't counted. Groups with no
 * matching row are left out of the result.
 */
export function urgencyByGroupKey(
	source: TerminalStatusSource,
	rows: Row[],
	keyOf: (row: Row) => string
): Map<string, GroupUrgency> {
	const result = new Map<string, GroupUrgency>();
	for (const row of rows) {
		if (row.archived) {
			continue;
		}
		const status = resolveRowStatus(source, row);
		if (status !== "asking" && status !== "waiting") {
			continue;
		}
		const key = keyOf(row);
		if (result.get(key) === "asking") {
			continue;
		}
		result.set(key, status);
	}
	return result;
}
