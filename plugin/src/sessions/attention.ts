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
	/** The session a click should open: the first asking one, or failing that the first waiting one. `null` if neither exists. */
	jumpToId: string | null;
}

/** Counts needs-input/needs-review sessions among `rows`, and picks a jump target (needs-input
 * takes priority). Backs the side panel's badge. Archived rows never count (`statusGroup` always
 * classifies them as `archived`, not `needs-input`/`needs-review`). */
export function attentionCounts(source: TerminalStatusSource, rows: Row[]): AttentionCounts {
	let asking = 0;
	let waiting = 0;
	let firstAskingId: string | null = null;
	let firstWaitingId: string | null = null;
	for (const row of rows) {
		const group = statusGroup(resolveRowStatus(source, row), row.archived);
		if (group === "needs-input") {
			asking++;
			if (firstAskingId === null) {
				firstAskingId = row.id;
			}
		} else if (group === "needs-review") {
			waiting++;
			if (firstWaitingId === null) {
				firstWaitingId = row.id;
			}
		}
	}
	return { asking, waiting, jumpToId: firstAskingId ?? firstWaitingId };
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
