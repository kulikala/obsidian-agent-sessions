import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { periodContaining, periodDays, type DayRange } from "../../src/views/activity-model";
import {
	ActivityLoader,
	ActivityStore,
	buildSessions,
	clipSpans,
	groupContiguous,
	joinRuns,
	sliceRaw,
} from "../../src/views/activity-data";
import type { RawSession } from "../../src/types";

interface Fixture {
	range: [number, number];
	gaps: number[];
	sessions: { id: string; turns: RawSession["turns"]; runs: RawSession["runs"]; joined: Record<string, unknown> }[];
}

// Written by `test/fixtures/make-activity-fixture.py` from the program's own join, so what is
// compared here is the plugin's join against `join_turns` + `clip_spans`.
const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "activity-equivalence.json"), "utf8"));

const meta = { agent: "claude", name: null, label: null, category: null, child: false };
const raw = (id: string, runs: [number, number, number | null][], turns: [number, string][] = []): RawSession => ({
	id,
	...meta,
	turns: turns.map(([start, prompt]) => ({ start, end: start + 1, prompt, kind: "prompt" as const, reply: "" })),
	runs: runs.map(([start, end, turn]) => ({ start, end, turn })),
});

describe("joining from raw runs equals the program's join", () => {
	for (const gap of fixture.gaps) {
		it(`${gap} minutes`, () => {
			let blocks = 0;
			for (const s of fixture.sessions) {
				const got = clipSpans(joinRuns(s, gap), fixture.range[0], fixture.range[1]);
				expect(got).toEqual(s.joined[String(gap)]);
				blocks += got.length;
			}
			expect(blocks).toBeGreaterThan(20); // the fixture isn't trivially empty
		});
	}

	it("a wider gap never makes more blocks", () => {
		const count = (g: number) => fixture.sessions.reduce((n, s) => n + joinRuns(s, g).length, 0);
		expect(count(60)).toBeLessThanOrEqual(count(30));
		expect(count(120)).toBeLessThanOrEqual(count(60));
		expect(count(30)).toBeGreaterThan(count(120));
	});
});

describe("joinRuns", () => {
	it("stretches a short block to one minute but keeps the turn's true times", () => {
		const [b] = joinRuns(raw("a", [[100, 130, 100]], [[100, "x"]]), 30);
		expect([b.start, b.end]).toEqual([100, 160]);
		expect([b.turns[0].start, b.turns[0].end, b.turns[0].active]).toEqual([100, 130, 30]);
	});

	it("counts sub-agent runs as work but never lists them", () => {
		const [b] = joinRuns(raw("a", [[0, 100, 0], [200, 5000, null]], [[0, "go"]]), 30);
		expect([b.start, b.end, b.turns.length]).toEqual([0, 5000, 1]);
	});
});

const days = (n: number, startDay = 0): DayRange[] =>
	periodDays({ mode: "week", from: new Date(2026, 8, 13 + startDay), to: new Date(2026, 8, 13 + startDay + n) });

describe("ActivityStore fetch planning", () => {
	const week = days(7);
	const noon = week[3].start + 12 * 3600; // Wednesday noon: days 4-6 haven't started

	it("asks for the days that have started, and nothing else", () => {
		const store = new ActivityStore();
		expect(store.plan(week, noon, "missing").map((d) => d.start)).toEqual(week.slice(0, 4).map((d) => d.start));
	});

	it("asks only for what is missing once some is loaded", () => {
		const store = new ActivityStore();
		store.put(week.slice(0, 2), [], noon);
		expect(store.plan(week, noon, "missing").map((d) => d.start)).toEqual(week.slice(2, 4).map((d) => d.start));
	});

	it("open: also the days loaded before they ended; all: everything", () => {
		const store = new ActivityStore();
		store.put(week.slice(0, 4), [], noon); // days 0-2 fetched long after they ended (final) -- as `noon` is past them; day 3 is open
		expect(store.plan(week, noon, "open").map((d) => d.start)).toEqual([week[3].start]);
		expect(store.plan(week, noon, "all")).toHaveLength(4);
		store.put([week[3]], [], week[3].end + 5); // refetched after it ended: final
		expect(store.plan(week, noon + 86400, "open").map((d) => d.start)).toEqual([week[4].start]);
	});

	it("groups consecutive days into one call each", () => {
		const g = groupContiguous([week[0], week[1], week[3], week[4], week[6]]);
		expect(g.map((x) => x.length)).toEqual([2, 2, 1]);
	});
});

describe("ActivityStore content", () => {
	const [d0, d1, d2] = days(3);

	it("keeps each day's runs, and a run crossing midnight once", () => {
		const store = new ActivityStore();
		const crossing = raw("a", [[d0.end - 600, d1.start + 600, 5]], [[5, "late"]]);
		store.put([d0, d1], [crossing], d1.end + 1);
		const merged = store.rawFor([d0, d1]);
		expect(merged).toHaveLength(1);
		expect(merged[0].runs).toHaveLength(1);
		expect(merged[0].turns.map((t) => t.prompt)).toEqual(["late"]);
	});

	it("takes the longer copy of a growing run and the latest copy of a turn", () => {
		const store = new ActivityStore();
		store.put([d2], [raw("a", [[d2.start + 100, d2.start + 200, 7]], [[7, "v1"]])], d2.start + 300);
		store.put([d2], [raw("a", [[d2.start + 100, d2.start + 900, 7]], [[7, "v2"]])], d2.start + 1000);
		const [s] = store.rawFor([d2]);
		expect(s.runs.map((r) => r.end)).toEqual([d2.start + 900]);
		expect(s.turns[0].prompt).toBe("v2");
	});

	it("slices a range into per-day sessions and bumps the version", () => {
		const a = raw("a", [[d0.start + 10, d0.start + 20, 1], [d2.start + 10, d2.start + 20, 2]], [[1, "one"], [2, "two"]]);
		expect(sliceRaw([a], d0.start, d0.end)[0].turns.map((t) => t.prompt)).toEqual(["one"]);
		const store = new ActivityStore();
		const v = store.version;
		store.put([d0, d1, d2], [a], d2.end + 1);
		expect(store.version).toBe(v + 1);
		expect(store.rawFor([d1])).toEqual([]);
	});
});

describe("the session order key", () => {
	const [d0, d1] = days(2);

	it("carries the program's `first` through the store into the blocks, whatever the period or gap", () => {
		const a: RawSession = { ...raw("a", [[d0.start + 3600, d0.start + 7200, 1], [d1.start + 3600, d1.start + 7200, 2]]), first: d0.start - 86400 };
		const store = new ActivityStore();
		store.put([d0, d1], [a], d1.end + 1);
		expect(store.rawFor([d1])[0].first).toBe(d0.start - 86400);
		for (const gap of [30, 60, 120]) {
			expect(buildSessions(store.rawFor([d1]), gap, d1.start, d1.end)[0].first).toBe(d0.start - 86400);
			expect(buildSessions(store.rawFor([d0, d1]), gap, d0.start, d1.end)[0].first).toBe(d0.start - 86400);
		}
	});

	it("falls back to the earliest run loaded when the program gives none", () => {
		const a = raw("a", [[d0.start + 7200, d0.start + 9000, 2], [d0.start + 3600, d0.start + 4000, 1]]);
		expect(buildSessions([a], 30, d0.start, d0.end)[0].first).toBe(d0.start + 3600);
	});
});

describe("ActivityLoader: switching never calls the program", () => {
	const makeLoader = () => {
		const calls: [Date, Date][] = [];
		const loader = new ActivityLoader(async (from, to) => {
			calls.push([from, to]);
			const a = from.getTime() / 1000;
			return [raw("s", [[a + 1000, a + 1100, a + 1000], [a + 1000 + 3000, a + 3200 + 1000, a + 4000]], [[a + 1000, "p1"], [a + 4000, "p2"]])];
		});
		return { calls, loader };
	};

	it("fetches the week once, then gap, mode and agent changes are computed from the store", async () => {
		const { calls, loader } = makeLoader();
		const week = periodContaining("week", new Date(2026, 8, 20), null);
		const wd = periodDays(week);
		const now = week.to.getTime() / 1000 + 86400; // the week is over
		expect(await loader.load(wd, now, "missing")).toBe(true);
		expect(calls).toHaveLength(1);
		const from = week.from.getTime() / 1000;
		const to = week.to.getTime() / 1000;
		const at30 = loader.sessions(wd, 30, from, to)!;
		const at120 = loader.sessions(wd, 120, from, to)!;
		expect(at30[0].spans.length).toBeGreaterThan(at120[0].spans.length);
		// back and forth: the same memoized objects
		expect(loader.sessions(wd, 30, from, to)).toBe(at30);
		expect(loader.sessions(wd, 120, from, to)).toBe(at120);
		// week -> a day inside it: nothing to fetch
		const day = periodContaining("day", new Date(2026, 8, 21, 12), null);
		expect(await loader.load(periodDays(day), now, "missing")).toBe(false);
		expect(loader.sessions(periodDays(day), 60, day.from.getTime() / 1000, day.to.getTime() / 1000)).not.toBeNull();
		expect(calls).toHaveLength(1);
	});

	it("fetches only the missing days when moving to another period", async () => {
		const { calls, loader } = makeLoader();
		const w1 = periodContaining("week", new Date(2026, 8, 20), null);
		const now = w1.to.getTime() / 1000 + 14 * 86400;
		await loader.load(periodDays(w1), now, "missing");
		const w2 = periodContaining("week", new Date(2026, 8, 27), null);
		await loader.load(periodDays(w2), now, "missing");
		expect(calls).toHaveLength(2);
		expect(calls[1][0].getTime()).toBe(w2.from.getTime());
		expect(calls[1][1].getTime()).toBe(w2.to.getTime());
		// a 7-day window overlapping both weeks needs nothing
		const mid = { mode: "session" as const, from: new Date(w1.from.getTime() + 3 * 86400000), to: new Date(w1.from.getTime() + 10 * 86400000) };
		expect(await loader.load(periodDays(mid), now, "missing")).toBe(false);
		expect(loader.sessions(periodDays(mid), 30, mid.from.getTime() / 1000, mid.to.getTime() / 1000)).not.toBeNull();
	});

	it("shows nothing until some day of the period is loaded", () => {
		const { loader } = makeLoader();
		const w = periodContaining("week", new Date(2026, 8, 20), null);
		expect(loader.sessions(periodDays(w), 30, 0, 1)).toBeNull();
	});
});

describe("speed", () => {
	// A 7-day period of 300 sessions with ~40 runs each: what a gap or mode toggle recomputes.
	const sessions: RawSession[] = [];
	const week = periodDays(periodContaining("week", new Date(2026, 8, 20), null));
	for (let i = 0; i < 300; i++) {
		const runs: [number, number, number | null][] = [];
		const turns: [number, string][] = [];
		for (let k = 0; k < 40; k++) {
			const start = week[0].start + k * 15000 + (i % 7) * 100;
			runs.push([start, start + 300 + ((k * 37) % 2000), start]);
			turns.push([start, `prompt ${k}`]);
		}
		sessions.push(raw(`s${i}`, runs, turns));
	}

	it("recomputes the blocks of a busy week in a few tens of milliseconds", () => {
		const t0 = performance.now();
		for (const gap of [30, 60, 120, 30]) {
			buildSessions(sessions, gap, week[0].start, week[6].end);
		}
		const per = (performance.now() - t0) / 4;
		console.log(`activity: building a 300-session week for one gap takes ${per.toFixed(1)} ms`);
		expect(per).toBeLessThan(250);
	});
});
