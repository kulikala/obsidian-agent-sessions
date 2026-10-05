import { describe, expect, it } from "vitest";
import {
	addDays,
	canGoNext,
	effectiveMode,
	periodContaining,
	periodDays,
	pickResetAnchor,
	shiftPeriod,
	clockLabel,
	dayColumns,
	dayCounts,
	expandForMinHeight,
	filterSessions,
	firstActiveSeconds,
	fitsLabel,
	layoutOverlaps,
	maxConcurrency,
	minBlockSeconds,
	splitDuration,
	toggleAgent,
	visibleAgents,
	splitSpansByDay,
	summarizeByAgent,
	unionSeconds,
	weekStartOf,
	type Interval,
} from "../../src/views/activity-model";
import type { ActivitySession, StatsResult, StatsWindow } from "../../src/types";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

const sp = (a: number, b: number): Interval & { turns: [] } => ({ start: a, end: b, turns: [] });
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe("week math", () => {
	it("starts the week on Sunday, local time", () => {
		// 2026-09-20 is a Sunday
		expect(weekStartOf(at(2026, 9, 26, 23, 59))).toEqual(at(2026, 9, 20));
		expect(weekStartOf(at(2026, 9, 20, 0, 0))).toEqual(at(2026, 9, 20));
		expect(weekStartOf(at(2026, 9, 19, 12))).toEqual(at(2026, 9, 13));
	});

	it("crosses month and year boundaries", () => {
		expect(weekStartOf(at(2026, 1, 1))).toEqual(at(2025, 12, 28));
		expect(addDays(at(2026, 1, 31), 1)).toEqual(at(2026, 2, 1));
	});

	it("keeps every day at local midnight across a daylight-saving change", () => {
		// whatever the host's zone, each day boundary must be a local midnight
		for (const start of [at(2026, 3, 22), at(2026, 10, 25), at(2026, 11, 1)]) {
			const days = periodDays(periodContaining("week", start, null));
			expect(days).toHaveLength(7);
			for (const d of days) {
				expect(new Date(d.start * 1000).getHours()).toBe(0);
				expect(new Date(d.end * 1000).getHours()).toBe(0);
				expect(d.end).toBeGreaterThan(d.start);
			}
		}
	});
});

describe("periods", () => {
	const reset = at(2026, 10, 8, 14, 30).getTime() / 1000; // a Thursday 14:30 reset

	it("week: Sunday 00:00 for 7 days; steps by 7 days", () => {
		const p = periodContaining("week", at(2026, 9, 23, 10), null);
		expect(p).toEqual({ mode: "week", from: at(2026, 9, 20), to: at(2026, 9, 27) });
		expect(shiftPeriod(p, -1).from).toEqual(at(2026, 9, 13));
		expect(shiftPeriod(p, 1).to).toEqual(at(2026, 10, 4));
	});

	it("day: one local day; steps by a day", () => {
		const p = periodContaining("day", at(2026, 9, 23, 18, 5), null);
		expect(p).toEqual({ mode: "day", from: at(2026, 9, 23), to: at(2026, 9, 24) });
		expect(shiftPeriod(p, -1).from).toEqual(at(2026, 9, 22));
	});

	it("session: the 7 days ending at the next reset after `at`", () => {
		const now = at(2026, 10, 5, 9);
		const p = periodContaining("session", now, reset);
		expect(p.mode).toBe("session");
		expect(p.to.getTime() / 1000).toBe(reset);
		expect(p.from.getTime() / 1000).toBe(reset - 7 * 86400);
		// a later reset anchor, or one in the past, gives the same period
		expect(periodContaining("session", now, reset + 14 * 86400)).toEqual(p);
		expect(periodContaining("session", now, reset - 21 * 86400)).toEqual(p);
	});

	it("session: the boundary belongs to the later period", () => {
		const p = periodContaining("session", new Date(reset * 1000), reset);
		expect(p.from.getTime() / 1000).toBe(reset);
		expect(p.to.getTime() / 1000).toBe(reset + 7 * 86400);
	});

	it("session: earlier periods step back by exactly 7 days", () => {
		const p = periodContaining("session", at(2026, 10, 5, 9), reset);
		const prev = shiftPeriod(p, -1);
		expect(prev.to).toEqual(p.from);
		expect(prev.from.getTime() / 1000).toBe(reset - 14 * 86400);
	});

	it("session without a known reset behaves as a Sunday-start week", () => {
		expect(effectiveMode("session", null)).toBe("week");
		expect(effectiveMode("session", 1)).toBe("session");
		expect(periodContaining("session", at(2026, 9, 23), null)).toEqual(periodContaining("week", at(2026, 9, 23), null));
	});

	it("does not go past the period that holds now", () => {
		const now = at(2026, 10, 5, 9);
		for (const mode of ["session", "week", "day"] as const) {
			const current = periodContaining(mode, now, reset);
			expect(canGoNext(current, now)).toBe(false);
			expect(canGoNext(shiftPeriod(current, -1), now)).toBe(true);
		}
	});

	it("lists the days a session period touches, with the part outside it", () => {
		const days = periodDays(periodContaining("session", at(2026, 10, 5, 9), reset));
		expect(days).toHaveLength(8);
		expect(days[0].activeFrom).toBe(reset - 7 * 86400 - days[0].start);
		expect(days[0].activeTo).toBe(days[0].end - days[0].start);
		expect(days[7].activeFrom).toBe(0);
		expect(days[7].activeTo).toBe(reset - days[7].start);
		expect(days[3].activeFrom).toBe(0);
		// a week and a day have no partial days
		expect(periodDays(periodContaining("week", at(2026, 9, 23), null)).every((d) => d.activeFrom === 0)).toBe(true);
		expect(periodDays(periodContaining("day", at(2026, 9, 23), null))).toHaveLength(1);
	});
});

describe("pickResetAnchor", () => {
	const win = (minutes: number, end: number, used: number | null) =>
		({ minutes, end, start: end - minutes * 60, used_percentage: used, total: {}, sessions: {}, label_key: "" }) as unknown as StatsWindow;
	const stats = (claude: number | null, codex: number | null): StatsResult =>
		({
			windows: {},
			agents: {
				claude: { windows: { five_hour: win(300, 1, 10), seven_day: win(10080, 1000, claude) } },
				codex: { windows: { five_hour: win(300, 1, null), seven_day: win(10080, 2000, codex) } },
			},
		}) as unknown as StatsResult;

	it("prefers Claude's tracked 7-day window, then Codex's, else null", () => {
		expect(pickResetAnchor(stats(5, 5), ["claude", "codex"])).toBe(1000);
		expect(pickResetAnchor(stats(null, 5), ["claude", "codex"])).toBe(2000);
		expect(pickResetAnchor(stats(5, 5), ["codex"])).toBe(2000);
		expect(pickResetAnchor(stats(null, null), ["claude", "codex"])).toBeNull();
		expect(pickResetAnchor(null, ["claude"])).toBeNull();
	});
});

describe("splitSpansByDay", () => {
	const days = periodDays({ mode: "week", from: new Date(2026, 8, 14), to: new Date(2026, 8, 21) });

	it("keeps a same-day span as one piece (seconds since midnight)", () => {
		expect(splitSpansByDay([sp(local(2026, 9, 14, 10), local(2026, 9, 14, 11, 30))], days).map(({ span: _s, ...p }) => p)).toEqual([
			{ day: 0, start: 36000, end: 41400 },
		]);
	});

	it("cuts a span at midnight", () => {
		const pieces = splitSpansByDay([sp(local(2026, 9, 14, 23), local(2026, 9, 15, 1))], days).map(({ span: _s, ...p }) => p);
		expect(pieces).toEqual([
			{ day: 0, start: 23 * 3600, end: days[0].end - days[0].start },
			{ day: 1, start: 0, end: 3600 },
		]);
	});

	it("cuts a multi-day span into each day and drops parts outside the week", () => {
		const pieces = splitSpansByDay([sp(local(2026, 9, 13, 22), local(2026, 9, 16, 2))], days);
		expect(pieces.map((p) => p.day)).toEqual([0, 1, 2]);
		expect(pieces[2]).toMatchObject({ day: 2, start: 0, end: 7200 });
	});
});

describe("layoutOverlaps", () => {
	const iv = (start: number, end: number) => ({ start, end });

	it("puts a lone item at full width", () => {
		expect(layoutOverlaps([iv(0, 10)])).toEqual([{ item: iv(0, 10), col: 0, cols: 1 }]);
	});

	it("places overlapping items side by side", () => {
		const l = layoutOverlaps([iv(0, 10), iv(5, 15)]);
		expect(l.map((x) => [x.col, x.cols])).toEqual([[0, 2], [1, 2]]);
	});

	it("does not treat touching items as overlapping", () => {
		const l = layoutOverlaps([iv(0, 10), iv(10, 20)]);
		expect(l.map((x) => [x.col, x.cols])).toEqual([[0, 1], [0, 1]]);
	});

	it("reuses a freed column and sizes the cluster by its widest point", () => {
		// A 0-10, B 2-4, C 5-8 (reuses B's column), D 20-30 is a separate cluster
		const l = layoutOverlaps([iv(0, 10), iv(2, 4), iv(5, 8), iv(20, 30)]);
		const byStart = new Map(l.map((x) => [x.item.start, x]));
		expect([byStart.get(0)!.col, byStart.get(0)!.cols]).toEqual([0, 2]);
		expect([byStart.get(2)!.col, byStart.get(2)!.cols]).toEqual([1, 2]);
		expect([byStart.get(5)!.col, byStart.get(5)!.cols]).toEqual([1, 2]);
		expect([byStart.get(20)!.col, byStart.get(20)!.cols]).toEqual([0, 1]);
	});

	it("chains overlaps into one cluster", () => {
		const l = layoutOverlaps([iv(0, 10), iv(8, 20), iv(18, 30)]);
		expect(l.map((x) => x.cols)).toEqual([2, 2, 2]);
		expect(l.map((x) => x.col)).toEqual([0, 1, 0]);
	});
});

describe("hours and concurrency", () => {
	it("unions overlapping spans once", () => {
		expect(unionSeconds([sp(0, 100), sp(50, 150), sp(200, 250)])).toBe(200);
		expect(unionSeconds([sp(0, 100), sp(10, 20)])).toBe(100);
		expect(unionSeconds([])).toBe(0);
	});

	it("finds the peak overlap, ends exclusive", () => {
		expect(maxConcurrency([sp(0, 10), sp(5, 15), sp(8, 9)])).toBe(3);
		expect(maxConcurrency([sp(0, 10), sp(10, 20)])).toBe(1);
		expect(maxConcurrency([])).toBe(0);
	});

	it("summarizes per agent", () => {
		const s = (id: string, agent: string, spans: ActivitySession["spans"]): ActivitySession => ({
			id, agent, name: id, label: id, category: null, child: false, spans,
		});
		const out = summarizeByAgent(
			[s("a", "claude", [sp(0, 3600)]), s("b", "claude", [sp(1800, 5400)]), s("c", "codex", [sp(0, 7200)])],
			["claude", "codex", "opencode"]
		);
		expect(out).toEqual([
			{ agent: "claude", hours: 1.5, sessions: 2, maxConcurrent: 2 },
			{ agent: "codex", hours: 2, sessions: 1, maxConcurrent: 1 },
			{ agent: "opencode", hours: 0, sessions: 0, maxConcurrent: 0 },
		]);
	});
});

describe("filter, counts, scroll, labels", () => {
	const mk = (id: string, name: string | null, spans: ActivitySession["spans"], agent = "claude"): ActivitySession => ({
		id, agent, name, label: name, category: name?.includes(": ") ? name.split(": ")[0] : null, child: false, spans,
	});

	it("filters by name, category or id, case-insensitively", () => {
		const list = [mk("id-1", "RIM: Notes", []), mk("zz", "Other", [])];
		expect(filterSessions(list, "rim")).toHaveLength(1);
		expect(filterSessions(list, "ZZ")).toHaveLength(1);
		expect(filterSessions(list, "  ")).toHaveLength(2);
		expect(filterSessions(list, "nope")).toHaveLength(0);
	});

	it("counts distinct sessions per day and agent", () => {
		const days = periodDays({ mode: "week", from: new Date(2026, 8, 14), to: new Date(2026, 8, 21) });
		const list = [
			mk("a", "A", [sp(local(2026, 9, 14, 23), local(2026, 9, 15, 1)), sp(local(2026, 9, 14, 10), local(2026, 9, 14, 11))]),
			mk("b", "B", [sp(local(2026, 9, 15, 5), local(2026, 9, 15, 6))], "codex"),
		];
		const c = dayCounts(list, days);
		expect(c[0]).toEqual({ claude: 1 });
		expect(c[1]).toEqual({ claude: 1, codex: 1 });
		expect(c[2]).toEqual({});
	});

	it("scrolls to just before the first activity, else 08:00", () => {
		expect(firstActiveSeconds([{ day: 2, start: 5 * 3600, end: 6 * 3600, span: sp(0, 0) }, { day: 0, start: 9 * 3600, end: 10 * 3600, span: sp(0, 0) }])).toBe(4.5 * 3600);
		expect(firstActiveSeconds([{ day: 0, start: 600, end: 900, span: sp(0, 0) }])).toBe(0);
		expect(firstActiveSeconds([])).toBe(8 * 3600);
	});

	it("shows a label only when the block is tall enough", () => {
		expect(fitsLabel(3600, 40)).toBe(true);
		expect(fitsLabel(600, 40)).toBe(false);
		expect(fitsLabel(1260, 40)).toBe(true);
	});

	it("formats axis labels", () => {
		expect(clockLabel(0)).toBe("0:00");
		expect(clockLabel(9.5 * 3600)).toBe("9:30");
		expect(clockLabel(86400)).toBe("24:00");
	});
});

describe("agent toggles", () => {
	const all = ["claude", "codex", "opencode"];

	it("shows what is not hidden", () => {
		expect(visibleAgents(all, ["codex"])).toEqual(["claude", "opencode"]);
		expect(visibleAgents(all, [])).toEqual(all);
	});

	it("hides and shows an agent", () => {
		expect(toggleAgent([], "codex", all)).toEqual(["codex"]);
		expect(toggleAgent(["codex"], "codex", all)).toEqual([]);
	});

	it("keeps at least one agent on", () => {
		expect(toggleAgent(["claude", "codex"], "opencode", all)).toEqual(["claude", "codex"]);
		expect(toggleAgent([], "claude", ["claude"])).toEqual([]);
	});
});

describe("minimum block height", () => {
	it("is 6 px or 10 minutes, whichever is longer", () => {
		expect(minBlockSeconds(40)).toBe(600); // 6 px = 9 min at 40 px/h, so 10 min wins
		expect(minBlockSeconds(10)).toBe(2160); // 6 px = 36 min at 10 px/h
	});

	it("extends a one-minute piece, keeps the span's true times, and never goes past the day", () => {
		const span = sp(0, 60);
		const out = expandForMinHeight([{ day: 0, start: 100, end: 160, span }, { day: 0, start: 86350, end: 86400, span }], 600);
		expect(out[0]).toMatchObject({ start: 100, end: 700 });
		expect(out[0].span).toBe(span);
		expect(out[1].end).toBe(86400);
	});

	it("puts two one-minute blocks a few minutes apart side by side instead of on top of each other", () => {
		const span = sp(0, 60);
		const pieces = [
			{ day: 0, start: 1000, end: 1060, span },
			{ day: 0, start: 1240, end: 1300, span },
			{ day: 0, start: 5000, end: 5060, span },
		];
		const laid = layoutOverlaps(expandForMinHeight(pieces, 600));
		expect(laid.map((l) => [l.col, l.cols])).toEqual([[0, 2], [1, 2], [0, 1]]);
	});
});

describe("day mode columns", () => {
	const days = periodDays(periodContaining("day", at(2026, 9, 23, 12), null));
	const mk = (id: string, agent: string, spans: ActivitySession["spans"]): ActivitySession => ({
		id, agent, name: id, label: id, category: null, child: false, spans,
	});
	const h = (hour: number) => at(2026, 9, 23, hour).getTime() / 1000;

	it("makes one column per session active that day, grouped by agent order, then by first activity", () => {
		const sessions = [
			mk("late-codex", "codex", [sp(h(15), h(16))]),
			mk("early-claude", "claude", [sp(h(8), h(9))]),
			mk("none", "claude", [sp(at(2026, 9, 22, 8).getTime() / 1000, at(2026, 9, 22, 9).getTime() / 1000)]),
			mk("late-claude", "claude", [sp(h(14), h(15))]),
			mk("early-codex", "codex", [sp(h(7), h(8))]),
		];
		const cols = dayColumns(sessions, ["claude", "codex"], days);
		expect(cols.map((c) => c.session.id)).toEqual(["early-claude", "late-claude", "early-codex", "late-codex"]);
	});

	it("keeps only the part of a session that falls on the day", () => {
		const cols = dayColumns([mk("x", "claude", [sp(at(2026, 9, 22, 23).getTime() / 1000, h(1))])], ["claude"], days);
		expect(cols[0].pieces).toHaveLength(1);
		expect(cols[0].pieces[0]).toMatchObject({ start: 0, end: 3600 });
	});

	it("is one 0-24 h column; overlapping pieces within a lane sit side by side", () => {
		expect(days).toHaveLength(1);
		const pieces = splitSpansByDay([sp(h(9), h(11)), sp(h(10), h(12)), sp(h(1) - 7200, h(1))], days);
		expect(pieces).toHaveLength(3);
		const laid = layoutOverlaps(pieces);
		expect(laid.filter((l) => l.cols === 2)).toHaveLength(2);
		expect(laid.find((l) => l.item.start === 0)).toMatchObject({ col: 0, cols: 1 });
	});
});

describe("splitDuration", () => {
	it("rounds to whole minutes", () => {
		expect(splitDuration(20)).toEqual({ h: 0, m: 0 });
		expect(splitDuration(90)).toEqual({ h: 0, m: 2 });
		expect(splitDuration(3600 + 5 * 60)).toEqual({ h: 1, m: 5 });
	});
});
