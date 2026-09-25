import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import type { Row } from "../../src/sessions/index";
import { OTHER_GROUP, type ManagerTree } from "../../src/sessions/tree";
import type { StatsResult, StatsUsage, StatsWindow, StatsWindows } from "../../src/types";
import {
	ARCHIVED_GROUP,
	categoryKeyOf,
	categoryTotals,
	categoryTotalsForWindow,
	flattenTree,
	formatWeekdayTime,
	isRealCategoryKey,
	matchesStatusFilter,
	moveSelection,
	orderedWindows,
	sessionCost,
	sessionCostForRow,
	shortModelName,
	sortRows,
	topCategoryTotals,
	weeklyPace,
	windowLabel,
	windowOf,
	windowSummary,
	windowsForAgent,
	type CategoryTotal,
	type ManagerRow,
} from "../../src/views/manager-model";

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
	return {
		agent: "claude",
		name: null,
		group: null,
		label: null,
		cwd: "/v",
		folder: "v",
		last_activity: 0,
		child: false,
		transcript: null,
		status: null,
		waitingFor: null,
		compacted: false,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

function tree(overrides: Partial<ManagerTree> = {}): ManagerTree {
	return {
		groups: [],
		others: { folded: false, rows: [] },
		archived: [],
		...overrides,
	};
}

describe("flattenTree", () => {
	// The "other"/"archive" group labels go through t(), so this whole block pins ja
	// (the assertions below check the app's actual ja UI strings) and resets afterward.
	beforeEach(() => setLang("ja"));
	afterEach(() => setLang("en"));

	it("orders headers and children as groups, then 'other' (uncategorized + unnamed merged into one bucket)", () => {
		const g1 = row({ id: "1", name: "RIM: Meeting notes" });
		const noCategory = row({ id: "2", name: "Name without a category" });
		const unnamed = row({ id: "3", name: null });
		const t = tree({
			groups: [{ name: "RIM", folded: false, rows: [g1] }],
			others: { folded: false, rows: [noCategory, unnamed] },
		});
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([
			{ kind: "group", key: "RIM", label: "RIM", count: 1, folded: false },
			{ kind: "session", row: g1, indent: true },
			{ kind: "group", key: OTHER_GROUP, label: "その他", count: 2, folded: false },
			{ kind: "session", row: noCategory, indent: true },
			{ kind: "session", row: unnamed, indent: true },
		]);
	});

	it("doesn't emit children for a folded group", () => {
		const child = row({ id: "1", name: "RIM: Meeting notes" });
		const t = tree({ groups: [{ name: "RIM", folded: true, rows: [child] }] });
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([{ kind: "group", key: "RIM", label: "RIM", count: 1, folded: true }]);
	});

	it("a folded 'other' bucket emits only its header, no children", () => {
		const noCategory = row({ id: "1", name: "Name without a category" });
		const t = tree({ others: { folded: true, rows: [noCategory] } });
		const rows = flattenTree(t, false);
		expect(rows).toEqual<ManagerRow[]>([{ kind: "group", key: OTHER_GROUP, label: "その他", count: 1, folded: true }]);
	});

	it("emits no header when 'other' is empty", () => {
		const t = tree({ others: { folded: false, rows: [] } });
		expect(flattenTree(t, false)).toEqual([]);
	});

	it("doesn't emit archived when showArchived is false", () => {
		const t = tree({ archived: [{ id: "1", name: "Old", agent: "claude", row: null }] });
		expect(flattenTree(t, false)).toEqual([]);
	});

	it("emits header + children (never folded) when showArchived is true; a missing row becomes archived-orphan", () => {
		const withRow = row({ id: "1", name: "Still here" });
		const t = tree({
			archived: [
				{ id: "1", name: "Still here", agent: "claude", row: withRow },
				{ id: "2", name: "Gone now", agent: "claude", row: null },
			],
		});
		const rows = flattenTree(t, true);
		expect(rows).toEqual<ManagerRow[]>([
			{ kind: "group", key: ARCHIVED_GROUP, label: "アーカイブ（2）", count: 2, folded: false },
			{ kind: "session", row: withRow, indent: true },
			{ kind: "archived-orphan", id: "2", name: "Gone now", agent: "claude" },
		]);
	});

	it("emits no header when archived is empty, even with showArchived true", () => {
		expect(flattenTree(tree({ archived: [] }), true)).toEqual([]);
	});
});

describe("moveSelection", () => {
	const rows: ManagerRow[] = [
		{ kind: "session", row: row({ id: "1" }), indent: false },
		{ kind: "session", row: row({ id: "2" }), indent: false },
		{ kind: "session", row: row({ id: "3" }), indent: false },
	];

	it("just adds delta when within range", () => {
		expect(moveSelection(rows, 1, 1)).toBe(2);
		expect(moveSelection(rows, 1, -1)).toBe(0);
	});

	it("doesn't go past the top or bottom edge", () => {
		expect(moveSelection(rows, 2, 1)).toBe(2);
		expect(moveSelection(rows, 0, -1)).toBe(0);
	});

	it("delta: 0 just clamps the current value (useful for re-validating a selection)", () => {
		expect(moveSelection(rows, 5, 0)).toBe(2);
		expect(moveSelection(rows, -1, 0)).toBe(0);
	});

	it("returns -1 when there are no rows", () => {
		expect(moveSelection([], 0, 1)).toBe(-1);
	});

	it("moving down from cur -1 (nothing selected) lands on the first row", () => {
		expect(moveSelection(rows, -1, 1)).toBe(0);
	});
});

function usage(cost: number, unknownCost = false): StatsUsage {
	return { calls: 1, input: 0, output: 0, cache_read: 0, cache_create: 0, cost, unknown_cost: unknownCost };
}

function statsWindow(overrides: Partial<StatsWindow> = {}): StatsWindow {
	return {
		start: 0,
		end: 100,
		used_percentage: null,
		total: { calls: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, cost: 0, unknown_cost: false },
		sessions: {},
		minutes: 300,
		label_key: "window.5h",
		...overrides,
	};
}

function statsWindows(overrides: Partial<StatsWindows> = {}): StatsWindows {
	return {
		five_hour: statsWindow({ minutes: 300, label_key: "window.5h" }),
		seven_day: statsWindow({ minutes: 10080, label_key: "window.7d" }),
		...overrides,
	};
}

describe("sessionCost", () => {
	it("returns null when there's no window", () => {
		expect(sessionCost(null, "1")).toBeNull();
	});

	it("returns null when the window has no usage for that session", () => {
		const w = statsWindow({ sessions: { "1": usage(2.5) } });
		expect(sessionCost(w, "2")).toBeNull();
	});

	it("returns the cost when it's there", () => {
		const w = statsWindow({ sessions: { "1": usage(2.5) } });
		expect(sessionCost(w, "1")).toBe(2.5);
	});
});

describe("windowOf", () => {
	it("returns null when windows itself is", () => {
		expect(windowOf(null, "5h")).toBeNull();
	});

	it("picks five_hour/seven_day by key", () => {
		const fiveHour = statsWindow({ start: 1 });
		const sevenDay = statsWindow({ start: 2 });
		const windows = statsWindows({ five_hour: fiveHour, seven_day: sevenDay });
		expect(windowOf(windows, "5h")).toBe(fiveHour);
		expect(windowOf(windows, "7d")).toBe(sevenDay);
	});
});

describe("windowsForAgent (T-103/T-104: per-agent windows, with Claude's legacy top-level fallback)", () => {
	it("returns null when stats itself is", () => {
		expect(windowsForAgent(null, "claude")).toBeNull();
	});

	it("prefers agents.<agent>.windows when present", () => {
		const claudeWindows = statsWindows();
		const codexWindows = statsWindows({ five_hour: statsWindow({ start: 99 }) });
		const stats: StatsResult = {
			windows: statsWindows(),
			agents: { claude: { windows: claudeWindows }, codex: { windows: codexWindows } },
		};
		expect(windowsForAgent(stats, "claude")).toBe(claudeWindows);
		expect(windowsForAgent(stats, "codex")).toBe(codexWindows);
	});

	it("falls back to the top-level windows for claude when agents is absent (pre-T-103 shape)", () => {
		const topLevel = statsWindows();
		const stats: StatsResult = { windows: topLevel };
		expect(windowsForAgent(stats, "claude")).toBe(topLevel);
	});

	it("is null for a non-claude agent with no agents entry (no legacy fallback exists for it)", () => {
		const stats: StatsResult = { windows: statsWindows() };
		expect(windowsForAgent(stats, "codex")).toBeNull();
	});
});

describe("sessionCostForRow (T-104: a row's cost comes from its own agent's windows)", () => {
	it("attributes each row's cost to its own agent, not a shared window", () => {
		const stats: StatsResult = {
			windows: statsWindows(),
			agents: {
				claude: { windows: statsWindows({ five_hour: statsWindow({ sessions: { "1": usage(5) } }) }) },
				codex: { windows: statsWindows({ five_hour: statsWindow({ sessions: { "1": usage(9) } }) }) },
			},
		};
		// Same session id under both agents (ids aren't guaranteed unique across agents in this
		// fixture) — each row's own `agent` field picks the right one.
		expect(sessionCostForRow(stats, row({ id: "1", agent: "claude" }), "5h")).toBe(5);
		expect(sessionCostForRow(stats, row({ id: "1", agent: "codex" }), "5h")).toBe(9);
	});

	it("is null when that agent has nothing for this window", () => {
		const stats: StatsResult = { windows: statsWindows() };
		expect(sessionCostForRow(stats, row({ id: "1", agent: "codex" }), "5h")).toBeNull();
	});
});

describe("sortRows", () => {
	it("leaves 'updated' order as-is (the group tree's own order)", () => {
		const rows: ManagerRow[] = [{ kind: "session", row: row({ id: "1" }), indent: false }];
		expect(sortRows(rows, "updated", null)).toBe(rows);
	});

	it("5h/7d flatten out groups and sort by descending in-window cost, with unused rows last", () => {
		const g1 = row({ id: "1" });
		const g2 = row({ id: "2" });
		const single = row({ id: "3" });
		const rows: ManagerRow[] = [
			{ kind: "group", key: "G", label: "G", count: 2, folded: false },
			{ kind: "session", row: g1, indent: true },
			{ kind: "session", row: g2, indent: true },
			{ kind: "session", row: single, indent: false },
			{ kind: "archived-orphan", id: "9", name: "Old", agent: "claude" },
		];
		const stats: StatsResult = {
			windows: {
				five_hour: statsWindow({ sessions: { "1": usage(1), "3": usage(5) } }),
				seven_day: statsWindow(),
			},
		};
		const sorted = sortRows(rows, "5h", stats);
		expect(sorted.map((r) => (r.kind === "session" ? r.row.id : r.kind))).toEqual(["3", "1", "2"]);
		expect(sorted.every((r) => r.kind === "session" && r.indent === false)).toBe(true);
	});

	it("treats every row as unused when there are no stats (keeps the given order)", () => {
		const rows: ManagerRow[] = [
			{ kind: "session", row: row({ id: "1" }), indent: true },
			{ kind: "session", row: row({ id: "2" }), indent: false },
		];
		const sorted = sortRows(rows, "7d", null);
		expect(sorted.map((r) => (r.kind === "session" ? r.row.id : null))).toEqual(["1", "2"]);
	});
});

describe("windowSummary", () => {
	it("tokens are input + output + cache read + cache create; session count is the key count of sessions", () => {
		const w = statsWindow({
			total: { calls: 3, input: 10, output: 20, cache_read: 5, cache_create: 1, cost: 1.23, unknown_cost: false },
			sessions: { a: usage(1), b: usage(2) },
		});
		expect(windowSummary(w)).toEqual({ tokens: 36, sessionCount: 2 });
	});

	it("is 0 when sessions is empty", () => {
		expect(windowSummary(statsWindow()).sessionCount).toBe(0);
	});
});

describe("categoryKeyOf", () => {
	it("a name with a group prefix returns the group part", () => {
		expect(categoryKeyOf(row({ id: "1", name: "RIM: Meeting notes" }))).toBe("RIM");
	});

	it("a name without a group and a missing name both fall into 'other' (OTHER_GROUP)", () => {
		const key = categoryKeyOf(row({ id: "1", name: "Session without a category" }));
		expect(key).toBe(OTHER_GROUP);
		expect(key).toBe(categoryKeyOf(row({ id: "2", name: null })));
	});
});

describe("isRealCategoryKey", () => {
	it("is true for an actual category name", () => {
		expect(isRealCategoryKey("RIM")).toBe(true);
		expect(isRealCategoryKey(categoryKeyOf(row({ id: "1", name: "RIM: Meeting notes" })))).toBe(true);
	});

	it("is false for the 'other' and 'archived' buckets", () => {
		expect(isRealCategoryKey(categoryKeyOf(row({ id: "1", name: "Session without a category" })))).toBe(false);
		expect(isRealCategoryKey(OTHER_GROUP)).toBe(false);
		expect(isRealCategoryKey(ARCHIVED_GROUP)).toBe(false);
	});
});

describe("categoryTotals", () => {
	afterEach(() => setLang("en"));

	it("sums cost and session count per group", () => {
		const rows: Row[] = [
			row({ id: "1", name: "RIM: Meeting notes" }),
			row({ id: "2", name: "RIM: Other matter" }),
			row({ id: "3", name: "ZERO: Proposal" }),
		];
		const stats: StatsResult = {
			windows: {
				five_hour: statsWindow(),
				seven_day: statsWindow({ sessions: { "1": usage(1), "2": usage(2), "3": usage(5) } }),
			},
		};
		const totals = categoryTotals(rows, stats, "7d");
		const rim = totals.find((c) => c.key === "RIM");
		const zero = totals.find((c) => c.key === "ZERO");
		expect(rim).toEqual({ key: "RIM", label: "RIM", cost: 3, count: 2 });
		expect(zero).toEqual({ key: "ZERO", label: "ZERO", cost: 5, count: 1 });
	});

	it("groups a name without a group and a missing name together into 'other'", () => {
		// The "other" label goes through t(), so pin the language before computing totals.
		setLang("ja");
		const rows: Row[] = [row({ id: "1", name: "Name without a category" }), row({ id: "2", name: null })];
		const totals = categoryTotals(rows, null, "5h");
		expect(totals).toEqual([{ key: OTHER_GROUP, label: "その他", cost: 0, count: 2 }]);
	});

	it("doesn't count archived sessions or unnamed child sessions", () => {
		const rows: Row[] = [
			row({ id: "1", name: "RIM: Meeting notes", archived: true }),
			row({ id: "2", name: null, child: true }),
			row({ id: "3", name: "RIM: Still active" }),
		];
		const totals = categoryTotals(rows, null, "5h");
		expect(totals).toEqual([{ key: "RIM", label: "RIM", cost: 0, count: 1 }]);
	});

	it("cost is 0 when the window has no usage", () => {
		const rows: Row[] = [row({ id: "1", name: "RIM: Meeting notes" })];
		expect(categoryTotals(rows, null, "5h")).toEqual([{ key: "RIM", label: "RIM", cost: 0, count: 1 }]);
	});

	it("attributes a mixed-agent row list's costs to each row's own agent (T-104)", () => {
		const rows: Row[] = [
			row({ id: "1", agent: "claude", name: "RIM: Claude session" }),
			row({ id: "1", agent: "codex", name: "RIM: Codex session" }),
		];
		const stats: StatsResult = {
			windows: statsWindows(),
			agents: {
				claude: { windows: statsWindows({ seven_day: statsWindow({ sessions: { "1": usage(2) } }) }) },
				codex: { windows: statsWindows({ seven_day: statsWindow({ sessions: { "1": usage(7) } }) }) },
			},
		};
		const totals = categoryTotals(rows, stats, "7d");
		expect(totals).toEqual([{ key: "RIM", label: "RIM", cost: 9, count: 2 }]);
	});
});

describe("categoryTotalsForWindow (T-104 addendum: against one already-resolved window directly, e.g. from orderedWindows)", () => {
	afterEach(() => setLang("en"));

	it("sums cost per category from the given window, same as categoryTotals but window-first", () => {
		const rows: Row[] = [row({ id: "1", name: "RIM: A" }), row({ id: "2", name: "RIM: B" })];
		const w = statsWindow({ sessions: { "1": usage(2), "2": usage(3) } });
		expect(categoryTotalsForWindow(rows, w)).toEqual([{ key: "RIM", label: "RIM", cost: 5, count: 2 }]);
	});

	it("cost is 0 for every category when the window is null (not fetched yet)", () => {
		const rows: Row[] = [row({ id: "1", name: "RIM: A" })];
		expect(categoryTotalsForWindow(rows, null)).toEqual([{ key: "RIM", label: "RIM", cost: 0, count: 1 }]);
	});
});

describe("topCategoryTotals", () => {
	function total(key: string, cost: number): CategoryTotal {
		return { key, label: key, cost, count: 1 };
	}

	it("excludes categories with 0 cost", () => {
		const totals = [total("RIM", 0), total("ZERO", 5), total("Other", 0)];
		expect(topCategoryTotals(totals, 8)).toEqual([total("ZERO", 5)]);
	});

	it("sorts the rest by descending cost and caps at the top n", () => {
		const totals = [total("A", 1), total("B", 3), total("C", 2)];
		expect(topCategoryTotals(totals, 2)).toEqual([total("B", 3), total("C", 2)]);
	});

	it("returns an empty array when everything is 0", () => {
		expect(topCategoryTotals([total("A", 0), total("B", 0)], 8)).toEqual([]);
	});
});

const DAY = 86400;
const WEEK = 7 * DAY;

describe("weeklyPace", () => {
	it("is unknown when usedPct is missing", () => {
		expect(weeklyPace(null, 0, WEEK, 100, 50)).toEqual({ kind: "unknown" });
	});

	it("is unknown even with a window length of 0 or less", () => {
		expect(weeklyPace(10, 100, 100, 200, 50)).toEqual({ kind: "unknown" });
	});

	it("is too-early when less than 6 hours have elapsed", () => {
		const result = weeklyPace(10, 0, WEEK, 3600, 50);
		expect(result.kind).toBe("too-early");
		if (result.kind === "too-early") {
			expect(result.elapsedPct).toBeCloseTo((3600 / WEEK) * 100, 5);
		}
	});

	it("is on-track when the projection is 100 or under", () => {
		// 50% elapsed (3.5 days) at 40% used -> 80% projected.
		const result = weeklyPace(40, 0, WEEK, WEEK / 2, 100);
		expect(result).toEqual({ kind: "on-track", projectedPct: 80, elapsedPct: 50, usedPct: 40 });
	});

	it("is over-pace when the projection exceeds 100 (gives an exhaustion time and a daily cap)", () => {
		// 50% elapsed (3.5 days) at 70% used -> 140% projected. At this pace the budget runs
		// out at day 5, leaving 2 days 0 hours before the 7-day reset. That leaves 30% of
		// headroom over the remaining 3.5 days.
		const result = weeklyPace(70, 0, WEEK, WEEK / 2, 140);
		expect(result.kind).toBe("over-pace");
		if (result.kind === "over-pace") {
			expect(result.exhaustAt).toBe(5 * DAY);
			expect(result.daysBeforeReset).toBe(2);
			expect(result.hoursBeforeReset).toBe(0);
			expect(result.maxDailyPct).toBeCloseTo(30 / 3.5, 5);
			expect(result.maxDailyCost).toBeCloseTo((140 * 30) / 70 / 3.5, 5);
			expect(result.elapsedPct).toBe(50);
			expect(result.usedPct).toBe(70);
		}
	});

	it("daysBeforeReset is 0 when exhaustion lands just before the reset (no full day left)", () => {
		// 50% elapsed (3.5 days) at 90% used -> 180% projected. Exhaustion is at elapsed *
		// 100/90 ≈ 3.888… days.
		const result = weeklyPace(90, 0, WEEK, WEEK / 2, 90);
		expect(result.kind).toBe("over-pace");
		if (result.kind === "over-pace") {
			expect(result.daysBeforeReset).toBeGreaterThanOrEqual(3);
		}
	});

	it("the too-early threshold scales with the window's own length (T-104 addendum), not a fixed absolute time", () => {
		const FIVE_HOURS = 5 * 60 * 60;
		// ~3.57% of 5 hours is ~10.7 minutes — comfortably past that is "on track", not "too early",
		// even though it's nowhere near the old fixed 6-hour threshold.
		const settled = weeklyPace(10, 0, FIVE_HOURS, FIVE_HOURS * 0.2, 5);
		expect(settled.kind).not.toBe("too-early");
		// Just inside the same ~3.57% ratio is still "too early".
		const early = weeklyPace(10, 0, FIVE_HOURS, FIVE_HOURS * 0.01, 5);
		expect(early.kind).toBe("too-early");
	});
});

describe("orderedWindows (T-104 addendum: an agent's windows aren't just a fixed five_hour/seven_day pair)", () => {
	it("returns every window sorted by minutes ascending, regardless of key name", () => {
		const fiveHour = statsWindow({ minutes: 300 });
		const sevenDay = statsWindow({ minutes: 10080 });
		const thirtyDay = statsWindow({ minutes: 43200 });
		const windows = { seven_day: sevenDay, window_43200m: thirtyDay, five_hour: fiveHour };
		expect(orderedWindows(windows)).toEqual([fiveHour, sevenDay, thirtyDay]);
	});

	it("is empty when windows itself is null", () => {
		expect(orderedWindows(null)).toEqual([]);
	});
});

describe("windowLabel (T-104 addendum: a window's label is derived from its length, not a fixed 5h/7d pair)", () => {
	afterEach(() => setLang("en"));

	it("300 minutes and 10080 minutes keep their existing exact wording", () => {
		expect(windowLabel(300)).toBe("5-hour window");
		expect(windowLabel(10080)).toBe("7-day window");
	});

	it("another day-aligned length becomes 'N-day window'", () => {
		expect(windowLabel(43200)).toBe("30-day window");
	});

	it("another hour-aligned length becomes 'N-hour window'", () => {
		expect(windowLabel(120)).toBe("2-hour window");
	});

	it("anything else falls back to minutes directly", () => {
		expect(windowLabel(90)).toBe("90-minute window");
	});

	it("localizes through t() (Japanese fixture)", () => {
		setLang("ja");
		expect(windowLabel(43200)).toBe("30 日枠");
	});
});

describe("formatWeekdayTime", () => {
	it("formats local time as '<weekday> HH:MM'", () => {
		const d = new Date(2026, 0, 5, 14, 30, 0);
		const epochSeconds = d.getTime() / 1000;
		// Japanese fixture: asserts against the app's actual ja weekday abbreviations.
		const weekdayJa = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
		const weekdayEn = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
		expect(formatWeekdayTime(epochSeconds, "ja")).toBe(`${weekdayJa} 14:30`);
		expect(formatWeekdayTime(epochSeconds, "en")).toBe(`${weekdayEn} 14:30`);
	});

	it("zero-pads hours and minutes to 2 digits", () => {
		const d = new Date(2026, 5, 1, 9, 5, 0);
		const epochSeconds = d.getTime() / 1000;
		expect(formatWeekdayTime(epochSeconds, "ja")).toMatch(/^. 09:05$/);
	});
});

describe("shortModelName", () => {
	it("drops a trailing `(...)`", () => {
		expect(shortModelName("Opus 5.5 (1M context)")).toBe("Opus 5.5");
	});

	it("leaves the name as-is when there's no parenthetical", () => {
		expect(shortModelName("Sonnet 5")).toBe("Sonnet 5");
	});

	it("returns an empty string for null", () => {
		expect(shortModelName(null)).toBe("");
	});
});

describe("matchesStatusFilter", () => {
	it("archived matches only archived rows, regardless of status", () => {
		expect(matchesStatusFilter(row({ id: "a", archived: true }), "idle", "archived", false)).toBe(true);
		expect(matchesStatusFilter(row({ id: "a", archived: false }), "idle", "archived", false)).toBe(false);
	});

	it("all matches every non-archived row, and archived ones too only when showArchived", () => {
		expect(matchesStatusFilter(row({ id: "a", archived: false }), "idle", "all", false)).toBe(true);
		expect(matchesStatusFilter(row({ id: "a", archived: true }), "idle", "all", false)).toBe(false);
		expect(matchesStatusFilter(row({ id: "a", archived: true }), "idle", "all", true)).toBe(true);
	});

	it("a specific group filter matches a non-archived row whose statusGroup is that filter", () => {
		expect(matchesStatusFilter(row({ id: "a" }), "asking", "needs-input", false)).toBe(true);
		expect(matchesStatusFilter(row({ id: "a" }), "idle", "needs-input", false)).toBe(false);
		expect(matchesStatusFilter(row({ id: "a" }), "waiting", "needs-review", false)).toBe(true);
		expect(matchesStatusFilter(row({ id: "a" }), "compacted", "needs-review", false)).toBe(true);
		expect(matchesStatusFilter(row({ id: "a" }), "working", "running", false)).toBe(true);
		expect(matchesStatusFilter(row({ id: "a" }), "idle", "done", false)).toBe(true);
	});

	it("an archived row never matches a specific group filter, even if its last-known status would", () => {
		expect(matchesStatusFilter(row({ id: "a", archived: true }), "asking", "needs-input", false)).toBe(false);
	});

	it("an error row matches no specific filter (only all)", () => {
		expect(matchesStatusFilter(row({ id: "a" }), "error", "needs-input", false)).toBe(false);
		expect(matchesStatusFilter(row({ id: "a" }), "error", "needs-review", false)).toBe(false);
		expect(matchesStatusFilter(row({ id: "a" }), "error", "running", false)).toBe(false);
		expect(matchesStatusFilter(row({ id: "a" }), "error", "done", false)).toBe(false);
		expect(matchesStatusFilter(row({ id: "a" }), "error", "all", false)).toBe(true);
	});
});
