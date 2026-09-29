// Tallies sessions that need the user's attention (pure functions). Priority order, highest
// first: needs-input (asking — Claude is waiting on an answer: AskUserQuestion, a permission
// prompt, etc.) then needs-review (waiting — went busy→idle but that tab hasn't been brought to
// front yet — or compacted — just /compact'd, no next instruction sent yet). Grouped via
// `terminal-status.ts`'s `statusGroup`, the same classification the manager's status filter
// uses. No dependency on `obsidian` (tested in test/attention.test.ts).

import type { Row } from "./index";
import { resolveRowStatus, statusGroup, type TerminalStatusSource } from "./terminal-status";

export interface AttentionCounts {
	/** Sessions in the `needs-input` group (asking). */
	asking: number;
	/** Sessions in the `needs-review` group (waiting or just-compacted). Named `waiting` for
	 * historical reasons — it's the badge's second count, "needs review". */
	waiting: number;
	/** The needs-input sessions' ids, in list order — what clicking the first count highlights. */
	askingIds: string[];
	/** The needs-review sessions' ids, in list order — what clicking the second count highlights. */
	waitingIds: string[];
}

/** Counts needs-input/needs-review sessions among `rows`, and collects their ids. Backs the side
 * panel's badge. Archived rows never count (`statusGroup` always
 * classifies them as `archived`, not `needs-input`/`needs-review`). */
export function attentionCounts(source: TerminalStatusSource, rows: Row[]): AttentionCounts {
	const askingIds: string[] = [];
	const waitingIds: string[] = [];
	for (const row of rows) {
		const group = statusGroup(resolveRowStatus(source, row), row.archived);
		if (group === "needs-input") {
			askingIds.push(row.id);
		} else if (group === "needs-review") {
			waitingIds.push(row.id);
		}
	}
	return { asking: askingIds.length, waiting: waitingIds.length, askingIds, waitingIds };
}

/** `asking` = needs-input, `waiting` = needs-review (kept as the original two names — see `AttentionCounts`). */
export type GroupUrgency = "asking" | "waiting";

/**
 * The highest-priority group (needs-input > needs-review) for each group key (`keyOf`). Counted
 * across all of `rows` regardless of whether the group is folded — the manager's group heading
 * needs to reflect what's inside even when collapsed. Archived rows aren't counted. Groups with
 * no matching row are left out of the result.
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
		const group = statusGroup(resolveRowStatus(source, row), false);
		if (group !== "needs-input" && group !== "needs-review") {
			continue;
		}
		const urgency: GroupUrgency = group === "needs-input" ? "asking" : "waiting";
		const key = keyOf(row);
		if (result.get(key) === "asking") {
			continue;
		}
		result.set(key, urgency);
	}
	return result;
}
