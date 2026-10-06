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

/** A half-open time interval, epoch seconds (or seconds since midnight inside a day piece). */
export interface Interval {
	start: number;
	end: number;
}

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
export interface DayPiece<T extends Interval = Interval> {
	day: number;
	start: number;
	end: number;
	/** The span the piece was cut from. */
	span: T;
}

/** Cuts `spans` at local midnights into per-day pieces (day index into `days`). Parts outside
 * `days` are dropped. */
export function splitSpansByDay<T extends Interval>(spans: readonly T[], days: readonly DayRange[]): DayPiece<T>[] {
	const out: DayPiece<T>[] = [];
	for (const span of spans) {
		for (let i = 0; i < days.length; i++) {
			const d = days[i];
			const start = Math.max(span.start, d.start);
			const end = Math.min(span.end, d.end);
			if (end > start) {
				out.push({ day: i, start: start - d.start, end: end - d.start, span });
			}
		}
	}
	return out;
}

/** The shortest a block is drawn: 6 px or 10 minutes at the current scale, whichever is longer (seconds). */
export function minBlockSeconds(hourPx: number, minPx = 6, minMinutes = 10): number {
	return Math.max((minPx / hourPx) * 3600, minMinutes * 60);
}

/**
 * Pieces for drawing: each one at least `minSeconds` long (ends extended, never past the day's
 * 24 h), so a one-minute block stays visible. The true times stay in `span`. Run the layout on
 * the result so blocks that now overlap sit side by side instead of hiding each other.
 */
export function expandForMinHeight<T extends DayPiece>(pieces: readonly T[], minSeconds: number): T[] {
	return pieces.map((p) => ({ ...p, end: Math.min(Math.max(p.end, p.start + minSeconds), Math.max(p.end, SECONDS_PER_DAY)) }));
}

/**
 * The calendar's left-to-right order of sessions: by when each first worked (at any time, not just
 * in the period shown), ties by id. It depends on nothing the view changes (period, mode, gap,
 * agent switches, filter), so a session keeps its place everywhere.
 */
export function compareSessions(a: Pick<ActivitySession, "id" | "first">, b: Pick<ActivitySession, "id" | "first">): number {
	return a.first - b.first || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface LaidOut<T> {
	item: T;
	/** 0-based column inside its overlap cluster. */
	col: number;
	/** The number of columns in that cluster (the item is `1 / cols` of the lane wide). */
	cols: number;
}

/**
 * Side-by-side layout of overlapping intervals inside one lane, keeping `order`: of two items
 * that overlap, the one `order` puts first is always to the left. Taken in that order, each item
 * goes to the leftmost column right of every overlapping item placed before it. Items that
 * overlap (directly or through a chain) form a cluster that shares its widest column count; an
 * item with nothing beside it is full width. Items that merely touch don't overlap.
 */
export function layoutOverlaps<T extends { start: number; end: number }>(
	items: readonly T[],
	order: (a: T, b: T) => number
): LaidOut<T>[] {
	const placed: LaidOut<T>[] = [];
	for (const item of [...items].sort((a, b) => order(a, b) || a.start - b.start)) {
		let col = 0;
		for (const p of placed) {
			if (p.item.start < item.end && item.start < p.item.end) {
				col = Math.max(col, p.col + 1);
			}
		}
		placed.push({ item, col, cols: 0 });
	}
	// Clusters: sweep by start; an item starting at or after everything before it has ended opens a new one.
	const byStart = [...placed].sort((a, b) => a.item.start - b.item.start);
	let cluster: LaidOut<T>[] = [];
	let clusterEnd = -Infinity;
	const close = () => {
		const cols = Math.max(...cluster.map((l) => l.col)) + 1;
		for (const l of cluster) {
			l.cols = cols;
		}
		cluster = [];
	};
	for (const l of byStart) {
		if (cluster.length > 0 && l.item.start >= clusterEnd) {
			close();
		}
		cluster.push(l);
		clusterEnd = Math.max(clusterEnd, l.item.end);
	}
	if (cluster.length > 0) {
		close();
	}
	return byStart;
}

/** Whether a block is tall enough to carry its label (`minHeightPx` ≈ the font's line plus padding). */
export function fitsLabel(durationSeconds: number, hourPx: number, minHeightPx = 14): boolean {
	return (durationSeconds / 3600) * hourPx >= minHeightPx;
}

/** Total seconds covered by `spans`, counting overlapping parts once. */
export function unionSeconds(spans: readonly Interval[]): number {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let total = 0;
	let curStart = 0;
	let curEnd = -Infinity;
	for (const { start: a, end: b } of sorted) {
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
export function maxConcurrency(spans: readonly Interval[]): number {
	const events: [number, number][] = [];
	for (const { start, end } of spans) {
		events.push([start, 1], [end, -1]);
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

/** The agents to show: `all` minus the hidden ones. */
export function visibleAgents(all: readonly string[], hidden: readonly string[]): string[] {
	return all.filter((a) => !hidden.includes(a));
}

/**
 * The hidden list after toggling `agent`. At least one of `all` stays shown: hiding the last
 * visible agent changes nothing.
 */
export function toggleAgent(hidden: readonly string[], agent: string, all: readonly string[]): string[] {
	if (hidden.includes(agent)) {
		return hidden.filter((a) => a !== agent);
	}
	if (visibleAgents(all, hidden).filter((a) => a !== agent).length === 0) {
		return [...hidden];
	}
	return [...hidden, agent];
}

export interface SessionColumn {
	session: ActivitySession;
	pieces: DayPiece<ActivitySession["spans"][number]>[];
}

/**
 * Day mode: one column per session active on `day` (`dayIndex` into `days`), grouped by agent
 * in `agentOrder` (other agents last), each group in the calendar's session order (`compareSessions`).
 */
export function dayColumns(
	sessions: readonly ActivitySession[],
	agentOrder: readonly string[],
	days: readonly DayRange[],
	dayIndex = 0
): SessionColumn[] {
	const rank = (agent: string) => {
		const i = agentOrder.indexOf(agent);
		return i === -1 ? agentOrder.length : i;
	};
	const columns: SessionColumn[] = [];
	for (const session of sessions) {
		const pieces = splitSpansByDay(session.spans, days).filter((p) => p.day === dayIndex);
		if (pieces.length > 0) {
			columns.push({ session, pieces });
		}
	}
	return columns.sort(
		(a, b) =>
			rank(a.session.agent) - rank(b.session.agent) || compareSessions(a.session, b.session)
	);
}

/** `seconds` as whole hours and minutes (minutes rounded); both 0 for under 30 seconds. */
export function splitDuration(seconds: number): { h: number; m: number } {
	const total = Math.round(Math.max(0, seconds) / 60);
	return { h: Math.floor(total / 60), m: total % 60 };
}

/**
 * After a reload: the block of `sessions` that `prev` (a block shown before the reload) became.
 * The session's span overlapping `prev` the most wins (a running block grows, a split one keeps
 * its larger part); ties go to the one starting closest. `null` when the session or any
 * overlapping span is gone.
 */
export function rematchSpan<T extends Interval>(
	prev: { sessionId: string; span: Interval },
	sessions: readonly { id: string; spans: readonly T[] }[]
): T | null {
	const session = sessions.find((s) => s.id === prev.sessionId);
	if (!session) {
		return null;
	}
	let best: T | null = null;
	let bestOverlap = 0;
	for (const span of session.spans) {
		const overlap = Math.min(span.end, prev.span.end) - Math.max(span.start, prev.span.start);
		if (overlap <= 0) {
			continue;
		}
		if (
			best === null ||
			overlap > bestOverlap ||
			(overlap === bestOverlap && Math.abs(span.start - prev.span.start) < Math.abs(best.start - prev.span.start))
		) {
			best = span;
			bestOverlap = overlap;
		}
	}
	return best;
}

export interface AgentCardState {
	/** Whether the agent is shown (its card is "on"). */
	on: boolean;
	/** Whether clicking the card may change it: the last shown agent can't be turned off. */
	canToggle: boolean;
}

/** The state of an agent's summary card, which doubles as that agent's show/hide switch. */
export function agentCardState(agent: string, hidden: readonly string[], all: readonly string[]): AgentCardState {
	const on = !hidden.includes(agent);
	return { on, canToggle: !on || visibleAgents(all, hidden).length > 1 };
}

/**
 * Where the "now" line goes: the index of the day of `days` that holds `nowSeconds` and the
 * seconds since that day's midnight, or `null` when the period doesn't hold now.
 */
export function nowLinePosition(days: readonly DayRange[], nowSeconds: number): { day: number; seconds: number } | null {
	const day = days.findIndex((d) => nowSeconds >= d.start && nowSeconds < d.end);
	if (day === -1) {
		return null;
	}
	return { day, seconds: nowSeconds - days[day].start };
}
