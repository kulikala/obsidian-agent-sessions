import { describe, expect, it } from "vitest";
import {
	addDays,
	clockLabel,
	dayCounts,
	filterSessions,
	firstActiveSeconds,
	fitsLabel,
	layoutOverlaps,
	maxConcurrency,
	splitSpansByDay,
	summarizeByAgent,
	unionSeconds,
	weekDays,
	weekRange,
	weekStartOf,
	type Span,
} from "../../src/views/activity-model";
import type { ActivitySession } from "../../src/types";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

describe("week math", () => {
	it("starts the week on Monday, local time", () => {
		// 2026-09-20 is a Sunday, 2026-09-14 the Monday before it
		expect(weekStartOf(new Date(2026, 8, 20, 23, 59))).toEqual(new Date(2026, 8, 14));
		expect(weekStartOf(new Date(2026, 8, 14, 0, 0))).toEqual(new Date(2026, 8, 14));
		expect(weekStartOf(new Date(2026, 8, 17, 12))).toEqual(new Date(2026, 8, 14));
		expect(weekStartOf(new Date(2026, 8, 21))).toEqual(new Date(2026, 8, 21));
	});

	it("crosses month and year boundaries", () => {
		expect(weekStartOf(new Date(2026, 0, 1))).toEqual(new Date(2025, 11, 29));
		expect(addDays(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 1));
	});

	it("gives seven consecutive local days and a week range", () => {
		const start = new Date(2026, 8, 14);
		const days = weekDays(start);
		expect(days).toHaveLength(7);
		for (let i = 0; i < 7; i++) {
			expect(days[i].date).toEqual(new Date(2026, 8, 14 + i));
			expect(days[i].end).toBe(i < 6 ? days[i + 1].start : weekRange(start).to.getTime() / 1000);
		}
		expect(weekRange(start).from).toEqual(start);
	});

	it("keeps every day at local midnight across a daylight-saving change", () => {
		// whatever the host's zone, each day boundary must be a local midnight
		for (const start of [new Date(2026, 2, 23), new Date(2026, 9, 26), new Date(2026, 10, 2)]) {
			for (const d of weekDays(start)) {
				expect(new Date(d.start * 1000).getHours()).toBe(0);
				expect(new Date(d.end * 1000).getHours()).toBe(0);
				expect(d.end).toBeGreaterThan(d.start);
			}
		}
	});
});

describe("splitSpansByDay", () => {
	const days = weekDays(new Date(2026, 8, 14));

	it("keeps a same-day span as one piece (seconds since midnight)", () => {
		expect(splitSpansByDay([[local(2026, 9, 14, 10), local(2026, 9, 14, 11, 30)]], days)).toEqual([
			{ day: 0, start: 36000, end: 41400 },
		]);
	});

	it("cuts a span at midnight", () => {
		const pieces = splitSpansByDay([[local(2026, 9, 14, 23), local(2026, 9, 15, 1)]], days);
		expect(pieces).toEqual([
			{ day: 0, start: 23 * 3600, end: days[0].end - days[0].start },
			{ day: 1, start: 0, end: 3600 },
		]);
	});

	it("cuts a multi-day span into each day and drops parts outside the week", () => {
		const pieces = splitSpansByDay([[local(2026, 9, 13, 22), local(2026, 9, 16, 2)]], days);
		expect(pieces.map((p) => p.day)).toEqual([0, 1, 2]);
		expect(pieces[2]).toEqual({ day: 2, start: 0, end: 7200 });
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
		expect(unionSeconds([[0, 100], [50, 150], [200, 250]])).toBe(200);
		expect(unionSeconds([[0, 100], [10, 20]])).toBe(100);
		expect(unionSeconds([])).toBe(0);
	});

	it("finds the peak overlap, ends exclusive", () => {
		expect(maxConcurrency([[0, 10], [5, 15], [8, 9]])).toBe(3);
		expect(maxConcurrency([[0, 10], [10, 20]])).toBe(1);
		expect(maxConcurrency([])).toBe(0);
	});

	it("summarizes per agent", () => {
		const s = (id: string, agent: string, spans: Span[]): ActivitySession => ({
			id, agent, name: id, label: id, category: null, child: false, spans,
		});
		const out = summarizeByAgent(
			[s("a", "claude", [[0, 3600]]), s("b", "claude", [[1800, 5400]]), s("c", "codex", [[0, 7200]])],
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
	const mk = (id: string, name: string | null, spans: Span[], agent = "claude"): ActivitySession => ({
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
		const days = weekDays(new Date(2026, 8, 14));
		const list = [
			mk("a", "A", [[local(2026, 9, 14, 23), local(2026, 9, 15, 1)], [local(2026, 9, 14, 10), local(2026, 9, 14, 11)]]),
			mk("b", "B", [[local(2026, 9, 15, 5), local(2026, 9, 15, 6)]], "codex"),
		];
		const c = dayCounts(list, days);
		expect(c[0]).toEqual({ claude: 1 });
		expect(c[1]).toEqual({ claude: 1, codex: 1 });
		expect(c[2]).toEqual({});
	});

	it("scrolls to just before the first activity, else 08:00", () => {
		expect(firstActiveSeconds([{ day: 2, start: 5 * 3600, end: 6 * 3600 }, { day: 0, start: 9 * 3600, end: 10 * 3600 }])).toBe(4.5 * 3600);
		expect(firstActiveSeconds([{ day: 0, start: 600, end: 900 }])).toBe(0);
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
