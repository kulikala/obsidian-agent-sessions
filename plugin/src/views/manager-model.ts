// The session manager's table (pure functions). Flattens a `ManagerTree` (`tree.ts`) into a
// single list of rows that ↑/↓ can walk through. No dependency on `obsidian`
// (tests: test/manager-model.test.ts).

import type { Row } from "../sessions/index";
import { t, type Lang } from "../i18n";
import { statusGroup, type ManagerStatusFilter, type TerminalStatus } from "../sessions/terminal-status";
import { OTHER_GROUP, splitName, type ManagerTree } from "../sessions/tree";
import type { StatsResult, StatsWindow, StatsWindows } from "../types";

/** A special group key that's never foldable (the archive heading). */
export const ARCHIVED_GROUP = "__archived__";

export type ManagerRow =
	| { kind: "group"; key: string; label: string; count: number; folded: boolean }
	| { kind: "session"; row: Row; indent: boolean }
	/** A session with an archive entry that no longer shows up in `json scan` (it no longer exists). */
	| { kind: "archived-orphan"; id: string; name: string; agent: string };

/**
 * Whether `row` (whose resolved status is `status`) should show under the manager's `filter` —
 * the toolbar's status-filter menu, next to the name filter. `archived` matches only archived
 * rows, regardless of status. Every other specific filter matches a non-archived row whose
 * `statusGroup` is that filter (so an archived row never shows under any of them, even if its
 * last-known status would otherwise match). `all` matches every non-archived row, plus archived
 * ones too when `showArchived` (the toolbar's separate "Show archive" checkbox) is on — the same
 * rule `flattenTree`'s `showArchived` parameter already applies to the tree's trailing archive
 * section.
 */
export function matchesStatusFilter(
	row: Row,
	status: TerminalStatus,
	filter: ManagerStatusFilter,
	showArchived: boolean
): boolean {
	if (filter === "archived") {
		return row.archived;
	}
	if (filter === "all") {
		return showArchived || !row.archived;
	}
	return !row.archived && statusGroup(status, false) === filter;
}

/**
 * Flattens into one list, in order: groups (heading → children if not folded), then other
 * (heading → children), then — if `showArchived` — archived (heading → children, always
 * expanded). "Other" (named sessions with no category, plus unnamed sessions, merged into one
 * section) gets the same kind of heading as any other group, so it doesn't read as a
 * continuation of the group before it.
 */
export function flattenTree(tree: ManagerTree, showArchived: boolean): ManagerRow[] {
	const out: ManagerRow[] = [];

	for (const group of tree.groups) {
		out.push({ kind: "group", key: group.name, label: group.name, count: group.rows.length, folded: group.folded });
		if (!group.folded) {
			for (const row of group.rows) {
				out.push({ kind: "session", row, indent: true });
			}
		}
	}

	if (tree.others.rows.length > 0) {
		out.push({
			kind: "group",
			// `key` is the identifier used in `store.folded` (the same value as `tree.ts`'s
			// `OTHER_GROUP`) — kept separate from the label so folded state survives a language
			// change (only the label goes through `t()`).
			key: OTHER_GROUP,
			label: t("group.other"),
			count: tree.others.rows.length,
			folded: tree.others.folded,
		});
		if (!tree.others.folded) {
			for (const row of tree.others.rows) {
				out.push({ kind: "session", row, indent: true });
			}
		}
	}

	if (showArchived && tree.archived.length > 0) {
		out.push({
			kind: "group",
			key: ARCHIVED_GROUP,
			label: t("group.archived", { count: tree.archived.length }),
			count: tree.archived.length,
			folded: false,
		});
		for (const entry of tree.archived) {
			if (entry.row) {
				out.push({ kind: "session", row: entry.row, indent: true });
			} else {
				out.push({ kind: "archived-orphan", id: entry.id, name: entry.name, agent: entry.agent });
			}
		}
	}

	return out;
}

/** Clamps `cur + delta` into `[0, rows.length - 1]`. `-1` if `rows` is empty. `delta: 0` can be used to re-clamp the current value. */
export function moveSelection(rows: ManagerRow[], cur: number, delta: number): number {
	if (rows.length === 0) {
		return -1;
	}
	return Math.max(0, Math.min(cur + delta, rows.length - 1));
}

/** The table's sort key. `updated` leaves `flattenTree`'s order (the group tree) as-is. */
export type SortKey = "updated" | "5h" | "7d";

/** `id`'s cost within `window`. `null` if there's no usage in the window. */
export function sessionCost(window: StatsWindow | null | undefined, id: string): number | null {
	const entry = window?.sessions[id];
	return entry ? entry.cost : null;
}

const WINDOW_KEY: Record<"5h" | "7d", string> = { "5h": "five_hour", "7d": "seven_day" };

/** The `StatsWindow` for `key` ("5h" → `five_hour`, "7d" → `seven_day`) within `windows`, or
 * `null` if `windows` itself is (or that fixed key is somehow missing). Only for the table's own
 * fixed 5h/7d cost columns and sort — `windows` can hold other, arbitrary-length windows too
 * (T-104 addendum), iterated instead via `orderedWindows`. */
export function windowOf(windows: StatsWindows | null, key: "5h" | "7d"): StatsWindow | null {
	if (!windows) {
		return null;
	}
	return windows[WINDOW_KEY[key]] ?? null;
}

/**
 * Every window in `windows`, sorted by length (`minutes`) ascending — so a 5-hour window always
 * comes before a 7-day one, which comes before a 30-day one, regardless of the arbitrary key
 * names (T-104 addendum: an agent's windows aren't just the fixed `five_hour`/`seven_day` pair
 * anymore). Empty array if `windows` itself is `null`. Ties keep object insertion order.
 */
export function orderedWindows(windows: StatsWindows | null): StatsWindow[] {
	if (!windows) {
		return [];
	}
	return Object.values(windows).sort((a, b) => a.minutes - b.minutes);
}

/**
 * A window's display label, derived purely from its length (`minutes`) — not Python's
 * `label_key` hint, so this doesn't depend on that string matching a pre-registered i18n key for
 * a length neither side anticipated. `300`/`10080` (5 hours/7 days) keep their existing exact
 * wording; any other day-aligned or hour-aligned length gets a generic "N-day"/"N-hour" window
 * label, and anything else falls back to minutes directly.
 */
export function windowLabel(minutes: number): string {
	if (minutes === 300) {
		return t("stats.fiveHour");
	}
	if (minutes === 10080) {
		return t("stats.sevenDay");
	}
	if (minutes % 1440 === 0) {
		return t("stats.window.nDay", { n: minutes / 1440 });
	}
	if (minutes % 60 === 0) {
		return t("stats.window.nHour", { n: minutes / 60 });
	}
	return t("stats.window.nMinute", { n: minutes });
}

/**
 * `stats`'s windows for `agent` (T-103/T-104) — its own `agents.<agent>.windows` if present,
 * falling back to the legacy top-level `windows` only for Claude (backward compat with a
 * pre-T-103 Python build, which never has `agents` at all). `null` if there's nothing for that
 * agent yet (`stats` itself not fetched yet, or an agent with no `agents` entry — e.g. it isn't
 * currently enabled, though in practice every row's own agent is always an enabled one, since
 * `json scan`/`live` only ever return sessions for agents in `AGENT_SESSIONS_AGENTS`).
 */
export function windowsForAgent(stats: StatsResult | null, agent: string): StatsWindows | null {
	if (!stats) {
		return null;
	}
	return stats.agents?.[agent]?.windows ?? (agent === "claude" ? stats.windows : null);
}

/** `row`'s cost within `window`, from its own agent's windows in `stats` (`windowsForAgent`) —
 * so a mixed-agent row list still attributes each row's cost to the right agent's data. */
export function sessionCostForRow(stats: StatsResult | null, row: Row, window: "5h" | "7d"): number | null {
	return sessionCost(windowOf(windowsForAgent(stats, row.agent), window), row.id);
}

/**
 * Sorts the table's rows by `key`. `updated` returns the given order (the group tree) as-is.
 * `5h`/`7d` drop group headings and archive entries, leaving just session rows sorted by cost
 * within the window, descending (rows with no usage sink to the bottom, and the result is a
 * flat list not organized by group).
 */
export function sortRows(rows: ManagerRow[], key: SortKey, stats: StatsResult | null): ManagerRow[] {
	if (key === "updated") {
		return rows;
	}
	const sessions = rows.filter((r): r is Extract<ManagerRow, { kind: "session" }> => r.kind === "session");
	return sessions
		.map((r) => ({ row: r, cost: sessionCostForRow(stats, r.row, key) }))
		.sort((a, b) => {
			if (a.cost === null && b.cost === null) {
				return 0;
			}
			if (a.cost === null) {
				return 1;
			}
			if (b.cost === null) {
				return -1;
			}
			return b.cost - a.cost;
		})
		.map(({ row }): ManagerRow => ({ ...row, indent: false }));
}

/** The token count (input + output + cache read + cache create) and active session count shown on a window's card. */
export interface WindowSummary {
	tokens: number;
	sessionCount: number;
}

export function windowSummary(w: StatsWindow): WindowSummary {
	return {
		tokens: w.total.input + w.total.output + w.total.cache_read + w.total.cache_create,
		sessionCount: Object.keys(w.sessions).length,
	};
}

/**
 * `row`'s category key: the group part of its name, if it has one; otherwise `OTHER_GROUP`
 * ("Other") — covering both named sessions with no category and sessions with no name at all,
 * merged into one section. Matches `flattenTree`'s classification (group vs. other).
 */
export function categoryKeyOf(row: Row): string {
	if (row.name) {
		const [group] = splitName(row.name);
		return group ?? OTHER_GROUP;
	}
	return OTHER_GROUP;
}

/** Whether `key` is an actual category name (as opposed to the "Other"/"Archive" headings).
 * Used to decide whether to show a chip — sections with no category color get no chip. */
export function isRealCategoryKey(key: string): boolean {
	return key !== OTHER_GROUP && key !== ARCHIVED_GROUP;
}

export interface CategoryTotal {
	/** The group name, or `OTHER_GROUP` (matches the table's group-row `key` so they can be looked up together). */
	key: string;
	/** The string shown on screen (this is where "Other" gets localized). */
	label: string;
	cost: number;
	count: number;
}

/**
 * Total cost and session count within `window`, per category (a group name, or "Other" if none).
 * Excludes archived sessions and unnamed child sessions from the count (the same filter
 * `buildManagerTree` uses for `active`/`unnamedOthers`).
 */
function categoryTotalsWith(rows: Row[], costOf: (row: Row) => number | null): CategoryTotal[] {
	const buckets = new Map<string, CategoryTotal>();
	for (const row of rows) {
		if (row.archived || (!row.name && row.child)) {
			continue;
		}
		const key = categoryKeyOf(row);
		const label = key === OTHER_GROUP ? t("category.other") : key;
		const bucket = buckets.get(key) ?? { key, label, cost: 0, count: 0 };
		bucket.cost += costOf(row) ?? 0;
		bucket.count += 1;
		buckets.set(key, bucket);
	}
	return [...buckets.values()];
}

export function categoryTotals(rows: Row[], stats: StatsResult | null, window: "5h" | "7d"): CategoryTotal[] {
	return categoryTotalsWith(rows, (row) => sessionCostForRow(stats, row, window));
}

/**
 * Same as `categoryTotals`, but against one already-resolved `StatsWindow` directly rather than
 * a fixed "5h"/"7d" key within `stats` (T-104 addendum — an agent's analysis section iterates an
 * arbitrary set of windows, not just those two). The caller is expected to have already scoped
 * `rows` to the one agent `window` belongs to (`sessionCost` doesn't care whose window it is).
 */
export function categoryTotalsForWindow(rows: Row[], window: StatsWindow | null): CategoryTotal[] {
	return categoryTotalsWith(rows, (row) => sessionCost(window, row.id));
}

/**
 * The top `n` entries for the per-category bar: categories with 0 cost (no usage in that
 * window) are excluded — the bar doesn't call out "inactive in the 7-day window". The rest are sorted by cost, descending.
 */
export function topCategoryTotals(totals: CategoryTotal[], n: number): CategoryTotal[] {
	return totals
		.filter((c) => c.cost > 0)
		.sort((a, b) => b.cost - a.cost)
		.slice(0, n);
}

// ---- Window pace judgment --------------------------------------------------

/**
 * Below this elapsed *fraction* of the window's own length, the pace hasn't stabilized enough to
 * judge. A fraction rather than a fixed absolute time (T-104 addendum: pace judgment now applies
 * to every window an agent reports — 5-hour, 7-day, 30-day, or anything else — not just a fixed
 * 7-day one) — this is the exact ratio the original fixed 6-hour threshold worked out to for a
 * 7-day window, so a 7-day window's behavior is unchanged; a shorter window reaches this fraction
 * sooner in absolute terms, a longer one later.
 */
const MIN_PACE_ELAPSED_FRACTION = (6 * 60 * 60) / (7 * 24 * 60 * 60);

export type WeeklyPace =
	| { kind: "unknown" }
	| { kind: "too-early"; elapsedPct: number }
	| {
			kind: "on-track";
			/** The projected usage percentage by the end of the window, at this pace (%, at most 100). */
			projectedPct: number;
			elapsedPct: number;
			usedPct: number;
	  }
	| {
			kind: "over-pace";
			/** The projected time (epoch seconds) usage reaches 100% at this pace. */
			exhaustAt: number;
			/** Time remaining from `exhaustAt` to reset (`end`). */
			daysBeforeReset: number;
			hoursBeforeReset: number;
			/** The per-remaining-day cap (%/day) needed to avoid running out. */
			maxDailyPct: number;
			/** The same cap converted to an approximate cost ($/day). `null` if it can't be computed (`usedPct` is 0). */
			maxDailyCost: number | null;
			elapsedPct: number;
			usedPct: number;
	  };

/**
 * Judges whether a window (5-hour, 7-day, 30-day, or any other length — T-104 addendum) will run
 * out at the current pace. `unknown` if `usedPct` is absent. `too-early` if the elapsed fraction
 * `e = (now - start) / (end - start)` is under `MIN_PACE_ELAPSED_FRACTION`, or the window's
 * length (`end - start`) is 0 or less — the pace hasn't stabilized enough to judge yet.
 * Otherwise, the projection `usedPct / e` being at most 100 means `on-track` (won't run out at
 * this pace); over 100 means `over-pace` (returns the projected exhaustion time and the daily
 * cap needed to avoid running out). `windowCost` (the window's total cost) feeds `over-pace`'s
 * `maxDailyCost` (a $ estimate).
 */
export function weeklyPace(usedPct: number | null, start: number, end: number, now: number, windowCost: number): WeeklyPace {
	const duration = end - start;
	if (usedPct == null || duration <= 0) {
		return { kind: "unknown" };
	}
	const elapsed = now - start;
	const elapsedFrac = elapsed / duration;
	if (elapsedFrac < MIN_PACE_ELAPSED_FRACTION) {
		return { kind: "too-early", elapsedPct: Math.max(0, elapsedFrac * 100) };
	}
	const elapsedPct = elapsedFrac * 100;
	const projectedPct = usedPct / elapsedFrac;
	if (projectedPct <= 100) {
		return { kind: "on-track", projectedPct, elapsedPct, usedPct };
	}
	// The exhaustion time: assuming usage keeps accruing to 100% at the same pace that produced `usedPct` over `elapsed` seconds.
	const secondsToExhaust = elapsed * (100 / usedPct);
	const exhaustAt = start + secondsToExhaust;
	const secondsBeforeReset = Math.max(0, end - exhaustAt);
	const daysBeforeReset = Math.floor(secondsBeforeReset / 86400);
	const hoursBeforeReset = Math.floor((secondsBeforeReset % 86400) / 3600);
	const remainingDays = Math.max(0, (end - now) / 86400);
	const maxDailyPct = remainingDays > 0 ? (100 - usedPct) / remainingDays : 0;
	const maxDailyCost = usedPct > 0 && remainingDays > 0 ? (windowCost * (100 - usedPct)) / usedPct / remainingDays : null;
	return { kind: "over-pace", exhaustAt, daysBeforeReset, hoursBeforeReset, maxDailyPct, maxDailyCost, elapsedPct, usedPct };
}

/** Short weekday names, cached per language rather than built on every call. */
const WEEKDAY_FORMATTER: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat("ja-JP", { weekday: "short" }),
	en: new Intl.DateTimeFormat("en-US", { weekday: "short" }),
};

/** Formats `epochSeconds` (local time) as "<weekday> HH:MM". */
export function formatWeekdayTime(epochSeconds: number, lang: Lang): string {
	const d = new Date(epochSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${WEEKDAY_FORMATTER[lang].format(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- Model and effort columns ----------------------------------------------------------

/**
 * A shortened form of a model's display name with any `(...)` suffix dropped (e.g.
 * `"Opus 5.5 (1M context)"` → `"Opus 5.5"`). Used in the table's model column — the full value
 * (`statusInfo.model` as-is) is shown in the tooltip.
 */
export function shortModelName(model: string | null): string {
	if (!model) {
		return "";
	}
	return model.replace(/\s*\([^)]*\)\s*$/, "").trim();
}
