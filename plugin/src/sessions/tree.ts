// Builds a group tree from JSON (pure functions).
// A group is whatever comes before `': '` in a name (matches `agentsessions/model.py`'s `split_name`).

import type { Row } from "./index";
import type { Store } from "./store";

/**
 * The identifier for the "Other" group (a key in `store.folded`): the one group that combines
 * named sessions with no category and sessions with no name.
 *
 * Kept in Japanese ("その他のセッション") rather than translated, because it's persisted —
 * it's written into existing users' `sessions.json` as a folded-group key, and changing the
 * value would silently un-fold that group for everyone who had it folded.
 */
export const OTHER_GROUP = "その他のセッション";
/** Older versions of `sessions.json` may have this group folded under this identifier instead.
 * Kept only so `buildManagerTree`'s folded check still recognizes it — nothing writes it anymore. */
const LEGACY_NO_CATEGORY_GROUP = "__no_category__";

const GROUP_SEP = ": ";

/** `"Team: Weekly notes"` → `["Team", "Weekly notes"]`. Returns `[null, name]` if there's no separator. */
export function splitName(name: string): [string | null, string] {
	const idx = name.indexOf(GROUP_SEP);
	if (idx > 0) {
		const group = name.slice(0, idx);
		const rest = name.slice(idx + GROUP_SEP.length);
		if (group && rest) {
			return [group, rest];
		}
	}
	return [null, name];
}

export interface GroupNode {
	name: string;
	folded: boolean;
	rows: Row[];
}

export interface ArchivedEntry {
	id: string;
	name: string;
	agent: string;
	row: Row | null;
}

export interface ManagerTree {
	groups: GroupNode[];
	/** The "Other" group: named sessions with no category plus unnamed sessions, combined into
	 * one list sorted by last activity. */
	others: { folded: boolean; rows: Row[] };
	archived: ArchivedEntry[];
}

interface Labeled {
	row: Row;
	label: string;
}

function byMtimeDesc(list: Labeled[]): Labeled[] {
	return [...list].sort((a, b) => b.row.last_activity - a.row.last_activity || a.label.localeCompare(b.label));
}

/**
 * Order: groups (heading, foldable) → "Other" (heading, folded by default) → archive. Each
 * section is sorted by last activity. "Other" holds named sessions with no category, plus
 * unnamed sessions where `child` is false (unnamed child sessions don't appear anywhere).
 */
export function buildManagerTree(rows: Row[], store: Store): ManagerTree {
	const active = rows.filter((r) => !r.archived);
	const archivedRows = rows.filter((r) => r.archived);

	const named = active.filter((r) => !!r.name);
	const unnamed = active.filter((r) => !r.name);
	const unnamedOthers = unnamed.filter((r) => !r.child);

	const groupMap = new Map<string, Labeled[]>();
	const singleRows: Row[] = [];
	for (const row of named) {
		const [group, label] = splitName(row.name as string);
		if (group) {
			const list = groupMap.get(group);
			if (list) {
				list.push({ row, label });
			} else {
				groupMap.set(group, [{ row, label }]);
			}
		} else {
			singleRows.push(row);
		}
	}

	const groupNames = [...groupMap.keys()].sort((a, b) => {
		const newestA = Math.max(...groupMap.get(a)!.map((c) => c.row.last_activity));
		const newestB = Math.max(...groupMap.get(b)!.map((c) => c.row.last_activity));
		if (newestA !== newestB) {
			return newestB - newestA;
		}
		return a.localeCompare(b);
	});

	const groups: GroupNode[] = groupNames.map((name) => ({
		name,
		folded: store.folded.includes(name),
		rows: byMtimeDesc(groupMap.get(name)!).map((c) => c.row),
	}));

	// "Other": combines named sessions with no category and unnamed sessions into one list,
	// sorted by last activity.
	const otherRows = [...singleRows, ...unnamedOthers].sort((a, b) => b.last_activity - a.last_activity);

	const archived: ArchivedEntry[] = [];
	const seen = new Set<string>();
	for (const row of archivedRows) {
		const record = store.archived.find((a) => a.id === row.id);
		archived.push({ id: row.id, name: row.name || record?.name || "", agent: row.agent, row });
		seen.add(row.id);
	}
	for (const record of store.archived) {
		if (!seen.has(record.id)) {
			archived.push({ id: record.id, name: record.name, agent: record.agent, row: null });
		}
	}
	archived.sort((a, b) => (b.row?.last_activity ?? -Infinity) - (a.row?.last_activity ?? -Infinity));

	return {
		groups,
		// Treat "Other" as folded if it was folded under `LEGACY_NO_CATEGORY_GROUP` too (backward compatibility).
		others: {
			folded: store.folded.includes(OTHER_GROUP) || store.folded.includes(LEGACY_NO_CATEGORY_GROUP),
			rows: otherRows,
		},
		archived,
	};
}

export interface SideList {
	openTabs: Row[];
	running: Row[];
	recent: Row[];
}

/**
 * Order: open tabs (in tab order) → running (no tab) → the most recent N. Archived sessions and
 * unnamed child sessions never appear in "recent".
 */
export function buildSideList(rows: Row[], leavesOrder: string[], recentCount: number): SideList {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const openTabs = leavesOrder.map((id) => byId.get(id)).filter((r): r is Row => !!r);
	const openIds = new Set(openTabs.map((r) => r.id));

	const running = rows
		.filter((r) => r.daemon && !openIds.has(r.id))
		.sort((a, b) => b.last_activity - a.last_activity);
	const runningIds = new Set(running.map((r) => r.id));

	const recent = rows
		.filter(
			(r) =>
				!openIds.has(r.id) &&
				!runningIds.has(r.id) &&
				!r.archived &&
				!(!r.name && r.child)
		)
		.sort((a, b) => b.last_activity - a.last_activity)
		.slice(0, recentCount);

	return { openTabs, running, recent };
}
