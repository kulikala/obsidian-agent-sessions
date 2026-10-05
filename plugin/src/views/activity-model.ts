// The activity calendar's pure helpers (week math, per-day span pieces, lane layout, summary
// numbers) — free of any `obsidian` import so tests can import them directly. `ActivityView`
// (`activity.ts`) only draws what these compute.
//
// Days are local calendar days built with `new Date(y, m, d + n)`, never by adding 86400 seconds,
// so a week that contains a daylight-saving change still has seven days that start at local
// midnight (a day can be 23 or 25 hours long).

import type { ActivityMode } from "../settings";
import type { ActivitySession, StatsResult } from "../types";
import { windowsForAgent } from "./manager-model";

export const SECONDS_PER_DAY = 86400;

export type Span = [number, number];

/** Local midnight of `date`'s day. */
export function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `date` moved by `n` local calendar days (to local midnight). */
export function addDays(date: Date, n: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** Sunday 00:00 (local) of the week containing `date`. */
export function weekStartOf(date: Date): Date {
	return addDays(date, -date.getDay());
}

const SEVEN_DAYS_MS = 7 * SECONDS_PER_DAY * 1000;

/** `[from, to)` shown at once. `from`/`to` are instants; in "week" and "day" mode they sit on local midnights. */
export interface Period {
	mode: ActivityMode;
	from: Date;
	to: Date;
}

/**
 * The mode that actually applies: "session" needs a known reset (`resetAnchor`, epoch seconds of
 * a reset of the usage limit's 7-day window); without one it behaves as "week".
 */
export function effectiveMode(mode: ActivityMode, resetAnchor: number | null): ActivityMode {
	return mode === "session" && resetAnchor === null ? "week" : mode;
}

/**
 * The period of `mode` that contains `at`. "session": 7 × 24 h ending at a reset (resets repeat
 * every 7 days from `resetAnchor`, so the period is `[reset − 7 d, reset)`, in absolute time);
 * "week": Sunday 00:00 to the next Sunday 00:00; "day": one local day.
 */
export function periodContaining(mode: ActivityMode, at: Date, resetAnchor: number | null): Period {
	const eff = effectiveMode(mode, resetAnchor);
	if (eff === "session" && resetAnchor !== null) {
		const anchorMs = resetAnchor * 1000;
		const k = Math.floor((at.getTime() - anchorMs) / SEVEN_DAYS_MS) + 1;
		const end = anchorMs + k * SEVEN_DAYS_MS;
		return { mode: "session", from: new Date(end - SEVEN_DAYS_MS), to: new Date(end) };
	}
	if (eff === "day") {
		const from = startOfDay(at);
		return { mode: "day", from, to: addDays(from, 1) };
	}
	const from = weekStartOf(at);
	return { mode: eff, from, to: addDays(from, 7) };
}

/** The period `n` steps away (negative = earlier): 7 days in "session" and "week", one day in "day". */
export function shiftPeriod(p: Period, n: number): Period {
	if (p.mode === "session") {
		const from = new Date(p.from.getTime() + n * SEVEN_DAYS_MS);
		return { mode: "session", from, to: new Date(from.getTime() + SEVEN_DAYS_MS) };
	}
	const from = addDays(p.from, p.mode === "day" ? n : 7 * n);
	return { mode: p.mode, from, to: addDays(from, p.mode === "day" ? 1 : 7) };
}

/** Whether there is a later period to go to: not once the period holds `now`, since nothing has happened after it. */
export function canGoNext(p: Period, now: Date): boolean {
	return p.to.getTime() <= now.getTime();
}

export interface DayRange {
	/** Local midnight, epoch seconds. */
	start: number;
	/** The next local midnight, epoch seconds. */
	end: number;
	date: Date;
	/** Seconds since `start` where the period begins on this day (0 unless the period starts mid-day). */
	activeFrom: number;
	/** Seconds since `start` where the period ends on this day (the day's length unless it ends mid-day). */
	activeTo: number;
}

/**
 * The local calendar days a period touches, in order: seven for a week, one for a day, and eight
 * for a "session" period that doesn't start at midnight (the first and last day are partly outside it).
 */
export function periodDays(p: Period): DayRange[] {
	const from = p.from.getTime() / 1000;
	const to = p.to.getTime() / 1000;
	const out: DayRange[] = [];
	for (let date = startOfDay(p.from); date.getTime() / 1000 < to; date = addDays(date, 1)) {
		const start = date.getTime() / 1000;
		const end = addDays(date, 1).getTime() / 1000;
		out.push({ date, start, end, activeFrom: Math.max(0, from - start), activeTo: Math.min(end, to) - start });
	}
	return out;
}

/**
 * The reset (epoch seconds) of the usage limit's 7-day window to align "session" periods to:
 * Claude Code's if it is enabled and its window is known, else Codex's, else `null`. A window is
 * known when `used_percentage` is tracked (otherwise `end` is just "now").
 */
export function pickResetAnchor(stats: StatsResult | null, enabledAgents: readonly string[]): number | null {
	for (const agent of ["claude", "codex"]) {
		if (!enabledAgents.includes(agent)) {
			continue;
		}
		const windows = windowsForAgent(stats, agent);
		const weekly = windows
			? Object.values(windows).find((w) => Math.abs(w.minutes - 10080) <= 5 && w.used_percentage !== null)
			: undefined;
		if (weekly) {
			return weekly.end;
		}
	}
	return null;
}

/** A span's part that falls on one day; `start`/`end` are seconds since that day's local midnight. */
export interface DayPiece {
	day: number;
	start: number;
	end: number;
}

/** Cuts `spans` at local midnights into per-day pieces (day index into `days`). Parts outside
 * `days` are dropped. */
export function splitSpansByDay(spans: readonly Span[], days: readonly DayRange[]): DayPiece[] {
	const out: DayPiece[] = [];
	for (const [a, b] of spans) {
		for (let i = 0; i < days.length; i++) {
			const d = days[i];
			const start = Math.max(a, d.start);
			const end = Math.min(b, d.end);
			if (end > start) {
				out.push({ day: i, start: start - d.start, end: end - d.start });
			}
		}
	}
	return out;
}

export interface LaidOut<T> {
	item: T;
	/** 0-based column inside its overlap cluster. */
	col: number;
	/** The number of columns in that cluster (the item is `1 / cols` of the lane wide). */
	cols: number;
}

/**
 * Side-by-side layout of overlapping intervals inside one lane: items that overlap (directly or
 * through a chain) form a cluster; each takes the first column free at its start, and the whole
 * cluster shares the widest column count it needed. Items that merely touch don't overlap.
 */
export function layoutOverlaps<T extends { start: number; end: number }>(items: readonly T[]): LaidOut<T>[] {
	const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
	const out: LaidOut<T>[] = [];
	let cluster: LaidOut<T>[] = [];
	let colEnds: number[] = [];
	let clusterEnd = -Infinity;
	const close = () => {
		for (const l of cluster) {
			l.cols = colEnds.length;
		}
		out.push(...cluster);
		cluster = [];
		colEnds = [];
	};
	for (const item of sorted) {
		if (cluster.length > 0 && item.start >= clusterEnd) {
			close();
		}
		let col = colEnds.findIndex((end) => end <= item.start);
		if (col === -1) {
			col = colEnds.length;
			colEnds.push(item.end);
		} else {
			colEnds[col] = item.end;
		}
		cluster.push({ item, col, cols: 0 });
		clusterEnd = Math.max(clusterEnd, item.end);
	}
	close();
	return out;
}

/** Whether a block is tall enough to carry its label (`minHeightPx` ≈ the font's line plus padding). */
export function fitsLabel(durationSeconds: number, hourPx: number, minHeightPx = 14): boolean {
	return (durationSeconds / 3600) * hourPx >= minHeightPx;
}

/** Total seconds covered by `spans`, counting overlapping parts once. */
export function unionSeconds(spans: readonly Span[]): number {
	const sorted = [...spans].sort((a, b) => a[0] - b[0]);
	let total = 0;
	let curStart = 0;
	let curEnd = -Infinity;
	for (const [a, b] of sorted) {
		if (a > curEnd) {
			if (curEnd > -Infinity) {
				total += curEnd - curStart;
			}
			curStart = a;
			curEnd = b;
		} else if (b > curEnd) {
			curEnd = b;
		}
	}
	if (curEnd > -Infinity) {
		total += curEnd - curStart;
	}
	return total;
}

/** The most spans open at the same moment (ends are exclusive: back-to-back spans don't count as concurrent). */
export function maxConcurrency(spans: readonly Span[]): number {
	const events: [number, number][] = [];
	for (const [a, b] of spans) {
		events.push([a, 1], [b, -1]);
	}
	events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	let cur = 0;
	let max = 0;
	for (const [, delta] of events) {
		cur += delta;
		max = Math.max(max, cur);
	}
	return max;
}

export interface AgentSummary {
	agent: string;
	hours: number;
	sessions: number;
	maxConcurrent: number;
}

/** Per-agent cards for the sessions given: hours (union of spans), session count, peak overlap. */
export function summarizeByAgent(sessions: readonly ActivitySession[], agents: readonly string[]): AgentSummary[] {
	return agents.map((agent) => {
		const mine = sessions.filter((s) => s.agent === agent && s.spans.length > 0);
		const spans = mine.flatMap((s) => s.spans);
		return {
			agent,
			hours: unionSeconds(spans) / 3600,
			sessions: mine.length,
			maxConcurrent: maxConcurrency(spans),
		};
	});
}

/** Sessions whose name, label, category, or id contains `needle` (case-insensitive); all when blank. */
export function filterSessions(sessions: readonly ActivitySession[], needle: string): ActivitySession[] {
	const n = needle.trim().toLowerCase();
	if (!n) {
		return [...sessions];
	}
	return sessions.filter((s) =>
		[s.name, s.label, s.category, s.id].some((v) => typeof v === "string" && v.toLowerCase().includes(n))
	);
}

/** Per day and agent, how many distinct sessions were active (`counts[day][agent]`). */
export function dayCounts(sessions: readonly ActivitySession[], days: readonly DayRange[]): Record<string, number>[] {
	const out: Record<string, number>[] = days.map(() => ({}));
	for (const s of sessions) {
		const seen = new Set<number>();
		for (const p of splitSpansByDay(s.spans, days)) {
			seen.add(p.day);
		}
		for (const d of seen) {
			out[d][s.agent] = (out[d][s.agent] ?? 0) + 1;
		}
	}
	return out;
}

/** The scroll target (seconds since midnight) for the first activity, `padSeconds` before it;
 * `fallback` (08:00) when there is none. */
export function firstActiveSeconds(pieces: readonly DayPiece[], padSeconds = 1800, fallback = 8 * 3600): number {
	if (pieces.length === 0) {
		return fallback;
	}
	return Math.max(0, Math.min(...pieces.map((p) => p.start)) - padSeconds);
}

/** `H:MM` of seconds since midnight (24:00 for a full day). */
export function clockLabel(secondsSinceMidnight: number): string {
	const m = Math.round(secondsSinceMidnight / 60);
	return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
