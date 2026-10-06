// The activity calendar's data layer, apart from the view: an in-memory store of what
// `json activity --raw` returned, kept per local day, and the pure steps that turn it into what
// is drawn (join with the chosen gap, the one-minute minimum, clipping to the period). The
// program is asked only for days not loaded yet; changing the gap, the mode, the agents, or the
// filter recomputes from the store and never calls it. No `obsidian` import (tested in
// test/views/activity-data.test.ts).
//
// `joinRuns` follows `agentsessions/sessions/activity.py`'s `join_turns` + `clip_spans` step
// for step, so joining here gives what the program's own join gave.

import type { ActivitySession, ActivitySpan, ActivityTurn, RawRun, RawSession, RawTurn } from "../types";
import type { DayRange } from "./activity-model";

/** A block shorter than this is stretched to it, so a one-message turn stays visible (seconds). */
export const MIN_BLOCK_SECONDS = 60;

/** Whether a run touches `[start, end)`. A zero-length run counts when it lies inside it. */
function runInRange(run: { start: number; end: number }, start: number, end: number): boolean {
	return (run.end > start || (run.start === run.end && run.start >= start)) && run.start < end;
}

// ---- Joining -------------------------------------------------------------------------------

/**
 * One session's blocks for `gapMinutes`: its runs (every segment of every turn, and sub-agent
 * runs) are joined when less than the gap apart; a block shorter than a minute is stretched to
 * one; each block lists the human turns (prompt or answer) with a run in it, with the part of the
 * turn inside the block and the seconds of work in it.
 */
export function joinRuns(session: Pick<RawSession, "turns" | "runs">, gapMinutes: number): ActivitySpan[] {
	const gap = gapMinutes * 60;
	const turnAt = new Map<number, RawTurn>();
	for (const t of session.turns) {
		turnAt.set(t.start, t);
	}
	const runs = [...session.runs].sort((a, b) => a.start - b.start || a.end - b.end);
	interface Block {
		start: number;
		end: number;
		segs: Map<number, [number, number][]>;
	}
	const blocks: Block[] = [];
	let cur: Block | null = null;
	for (const run of runs) {
		if (cur !== null && run.start - cur.end < gap) {
			cur.end = Math.max(cur.end, run.end);
		} else {
			cur = { start: run.start, end: run.end, segs: new Map() };
			blocks.push(cur);
		}
		if (run.turn !== null) {
			const list = cur.segs.get(run.turn);
			if (list) {
				list.push([run.start, run.end]);
			} else {
				cur.segs.set(run.turn, [[run.start, run.end]]);
			}
		}
	}
	return blocks.map((blk) => {
		const turns: ActivityTurn[] = [];
		const ordered = [...blk.segs.entries()].sort((a, b) => a[1][0][0] - b[1][0][0]);
		for (const [key, segs] of ordered) {
			const turn = turnAt.get(key);
			if (!turn || (turn.kind !== "prompt" && turn.kind !== "answer")) {
				continue;
			}
			turns.push({
				start: segs[0][0],
				end: Math.max(...segs.map((s) => s[1])),
				active: segs.reduce((sum, s) => sum + (s[1] - s[0]), 0),
				prompt: turn.prompt,
				kind: turn.kind,
				reply: turn.reply,
			});
		}
		const end = blk.end - blk.start < MIN_BLOCK_SECONDS ? blk.start + MIN_BLOCK_SECONDS : blk.end;
		return { start: blk.start, end, turns };
	});
}

/** The parts of `spans` inside `[from, to)`; empty ones are dropped, and a clipped block keeps the turns that touch what is left. */
export function clipSpans(spans: readonly ActivitySpan[], from: number, to: number): ActivitySpan[] {
	const out: ActivitySpan[] = [];
	for (const span of spans) {
		const start = Math.max(span.start, from);
		const end = Math.min(span.end, to);
		if (end > start) {
			out.push({ start, end, turns: span.turns.filter((t) => t.end > start && t.start < end) });
		}
	}
	return out;
}

/** The sessions of `raw` as blocks for `gapMinutes`, clipped to `[from, to)` (epoch seconds); sessions with none left are dropped. */
export function buildSessions(raw: readonly RawSession[], gapMinutes: number, from: number, to: number): ActivitySession[] {
	const out: ActivitySession[] = [];
	for (const s of raw) {
		const spans = clipSpans(joinRuns(s, gapMinutes), from, to);
		if (spans.length > 0) {
			// Without `first` from the program, the earliest run loaded stands in.
			const first = s.first ?? Math.min(...s.runs.map((r) => r.start));
			out.push({ id: s.id, agent: s.agent, name: s.name, label: s.label, category: s.category, child: s.child, first, spans });
		}
	}
	return out;
}

// ---- The store -----------------------------------------------------------------------------

/** What the program returned for a range, cut to the runs that touch `[start, end)`. */
export function sliceRaw(raw: readonly RawSession[], start: number, end: number): RawSession[] {
	const out: RawSession[] = [];
	for (const s of raw) {
		const runs = s.runs.filter((r) => runInRange(r, start, end));
		if (runs.length === 0) {
			continue;
		}
		const keys = new Set(runs.map((r) => r.turn));
		out.push({ ...s, runs, turns: s.turns.filter((t) => keys.has(t.start)) });
	}
	return out;
}

/** Consecutive days (each starting where the previous ended) as one group, so each group is one program call. */
export function groupContiguous(days: readonly DayRange[]): DayRange[][] {
	const groups: DayRange[][] = [];
	for (const day of days) {
		const last = groups[groups.length - 1];
		if (last && last[last.length - 1].end === day.start) {
			last.push(day);
		} else {
			groups.push([day]);
		}
	}
	return groups;
}

/**
 * Which days to ask the program for: `missing` = not loaded yet; `open` = also the days that
 * were loaded before they ended (today, or any day fetched part-way), which can have grown;
 * `all` = every day (an explicit reload). Days that haven't started are never asked for.
 */
export type FetchMode = "missing" | "open" | "all";

interface DayEntry {
	/** When the request that filled it started: a day fetched at or after its end is final. */
	fetchedAt: number;
	sessions: RawSession[];
}

export class ActivityStore {
	private days = new Map<number, DayEntry>();
	/** Bumped whenever the content changes; keys the memoized results. */
	version = 0;
	private merged: { key: string; value: RawSession[] } | null = null;

	has(day: DayRange): boolean {
		return this.days.has(day.start);
	}

	/** Whether any of `days` is loaded (something to show right away). */
	hasAny(days: readonly DayRange[]): boolean {
		return days.some((d) => this.has(d));
	}

	plan(days: readonly DayRange[], nowSeconds: number, mode: FetchMode): DayRange[] {
		return days.filter((day) => {
			if (day.start > nowSeconds) {
				return false;
			}
			const entry = this.days.get(day.start);
			if (!entry || mode === "all") {
				return true;
			}
			return mode === "open" && entry.fetchedAt < day.end;
		});
	}

	/** Stores what the program returned for `days` (the result of one call over their whole span). */
	put(days: readonly DayRange[], raw: readonly RawSession[], fetchedAt: number): void {
		for (const day of days) {
			this.days.set(day.start, { fetchedAt, sessions: sliceRaw(raw, day.start, day.end) });
		}
		this.version++;
	}

	clear(): void {
		this.days.clear();
		this.version++;
	}

	/**
	 * The loaded days' sessions as one set: a session's turns and runs from every day merged, a run
	 * seen on two days (it crossed midnight) kept once (the longer copy), and a turn kept as the
	 * most recently fetched copy.
	 */
	rawFor(days: readonly DayRange[]): RawSession[] {
		const key = `${this.version}|${days.map((d) => d.start).join(",")}`;
		if (this.merged?.key === key) {
			return this.merged.value;
		}
		const entries = days
			.map((d) => this.days.get(d.start))
			.filter((e): e is DayEntry => e !== undefined)
			.sort((a, b) => a.fetchedAt - b.fetchedAt);
		const bySession = new Map<string, { meta: RawSession; turns: Map<number, RawTurn>; runs: Map<string, RawRun> }>();
		for (const entry of entries) {
			for (const s of entry.sessions) {
				let acc = bySession.get(s.id);
				if (!acc) {
					acc = { meta: s, turns: new Map(), runs: new Map() };
					bySession.set(s.id, acc);
				}
				acc.meta = s;
				for (const t of s.turns) {
					acc.turns.set(t.start, t);
				}
				for (const r of s.runs) {
					const k = `${r.turn}|${r.start}`;
					const had = acc.runs.get(k);
					if (!had || r.end >= had.end) {
						acc.runs.set(k, r);
					}
				}
			}
		}
		const value = [...bySession.values()].map(({ meta, turns, runs }) => ({
			id: meta.id,
			agent: meta.agent,
			name: meta.name,
			label: meta.label,
			category: meta.category,
			child: meta.child,
			first: meta.first,
			turns: [...turns.values()],
			runs: [...runs.values()],
		}));
		this.merged = { key, value };
		return value;
	}
}

/** Memoizes `buildSessions` per (store version, gap, period): toggling back and forth is a lookup. */
export class SessionsMemo {
	private cache = new Map<string, ActivitySession[]>();

	get(store: ActivityStore, days: readonly DayRange[], gapMinutes: number, from: number, to: number): ActivitySession[] {
		const key = `${store.version}|${gapMinutes}|${from}|${to}`;
		const hit = this.cache.get(key);
		if (hit) {
			return hit;
		}
		const value = buildSessions(store.rawFor(days), gapMinutes, from, to);
		if (this.cache.size >= 24) {
			this.cache.delete(this.cache.keys().next().value as string);
		}
		this.cache.set(key, value);
		return value;
	}
}

/**
 * The view's data source: the store, the memo, and the one place that calls the program. Asking
 * for blocks never fetches; `load` fetches only the days `FetchMode` says are due, one call per
 * run of consecutive days.
 */
export class ActivityLoader {
	readonly store = new ActivityStore();
	private memo = new SessionsMemo();

	constructor(private fetchRaw: (from: Date, to: Date) => Promise<RawSession[]>) {}

	hasAny(days: readonly DayRange[]): boolean {
		return this.store.hasAny(days);
	}

	/** Fetches what is due for `days`; resolves to whether anything was fetched. Rejects when a call fails (days fetched before it stay stored). */
	async load(days: readonly DayRange[], nowSeconds: number, mode: FetchMode): Promise<boolean> {
		const need = this.store.plan(days, nowSeconds, mode);
		for (const group of groupContiguous(need)) {
			const startedAt = Date.now() / 1000;
			const raw = await this.fetchRaw(new Date(group[0].start * 1000), new Date(group[group.length - 1].end * 1000));
			this.store.put(group, raw, startedAt);
		}
		return need.length > 0;
	}

	/** The blocks for `[from, to)` at `gapMinutes` from what is loaded; `null` until some of `days` is. */
	sessions(days: readonly DayRange[], gapMinutes: number, from: number, to: number): ActivitySession[] | null {
		return this.store.hasAny(days) ? this.memo.get(this.store, days, gapMinutes, from, to) : null;
	}
}
