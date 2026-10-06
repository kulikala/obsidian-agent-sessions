// The rate-limit view's pure data helpers (window math, limits-file parsing) — kept free of any
// `obsidian` import since tests import this module directly, and the `obsidian` npm package has
// no runtime (its `main` is empty) outside the real app. `LimitsView` itself, the DOM-rendering
// class that needs real `obsidian` exports (`setIcon`/`setTooltip`), lives in `limits-render.ts`.
//
// Claude: `~/.agents/sessions/status/*.json` files each carry the account-wide `rate_limits`,
// written in real time by Claude Code's own statusLine hook. Since each file's last-written time
// (mtime) differs, this uses whichever file with `rate_limits` was written most recently (assumes
// the account isn't being used from multiple places at once). Always exactly two rows (5h/7d) —
// Claude's account always has both.
// Codex: no statusLine-equivalent mechanism exists, so there's no live
// file to read — instead this polls `json stats`'s `agents.codex.windows` (the same shape the
// manager's per-agent analysis uses) every `STATS_FETCH_INTERVAL_MS`, converting each
// `StatsWindow` into the same `RateLimitWindow` shape via `fromStatsWindow` so every agent renders
// through the identical `renderAgentWindow`. Unlike Claude, the row *count* is dynamic — one row
// per window this agent actually has a tracked percentage for (`used_percentage !== null`), which
// can be the usual 5h/7d pair, a single non-standard window (e.g. a 30-day-only plan — a
// confirmed real case), more than two, or occasionally none at all (nothing shown for that agent
// in that case, rather than a permanently dashed-out placeholder row).
// A used-up window (`json stats`'s `exhausted`) reads 100%: Claude's `rate_limits` snapshot stays
// just below it (typically 99%) once the limit is hit, so while either Claude reading is at
// `CLAUDE_NEAR_LIMIT_PCT` or more, Claude joins the `json stats` poll too and `withExhaustion`
// lifts a used-up window to 100%.
// Either way: updates the bars, usage percentage, and countdown to reset (shown as "—" when
// `resetsAt` is absent) once per second, and re-reads/re-fetches immediately on click.

import { t } from "../i18n";
import type { StatsWindow, StatsWindows } from "../types";
import { displayedUsedPct, orderedWindows } from "./manager-model";

export interface RateLimitWindow {
	/** `null` means "just past reset, with no fresh `rate_limits` yet" (right after
	 * `rollForwardWindow` has rolled it forward). */
	usedPercentage: number | null;
	resetsAt: number | null;
	/** The window's limit has been reached (`json stats`'s `exhausted`); `usedPercentage` then reads
	 * at least 100. */
	exhausted?: boolean;
	/** When it was reached (epoch seconds), `null` if unknown. */
	exhaustedAt?: number | null;
}

/** A Claude reading at or above this makes the side panel also fetch `json stats` for Claude, to
 * learn whether a window is used up (see `withExhaustion`). Below it, the live file alone is read. */
export const CLAUDE_NEAR_LIMIT_PCT = 90;

/** Whether either of Claude's live readings is close enough to its limit to check for exhaustion. */
export function claudeNearLimit(info: LimitsInfo | null): boolean {
	return [info?.fiveHour, info?.sevenDay].some((w) => w?.usedPercentage != null && w.usedPercentage >= CLAUDE_NEAR_LIMIT_PCT);
}

/**
 * `live` (a Claude window from the status file, already rolled forward) marked used up when the
 * matching `json stats` window says so: same window (its `end` within a minute of `live.resetsAt`)
 * and `exhausted`. `usedPercentage` then reads at least 100. Anything else returns `live` as-is.
 */
export function withExhaustion(live: RateLimitWindow | null, stats: StatsWindow | undefined): RateLimitWindow | null {
	if (!live || live.resetsAt == null || !stats?.exhausted || Math.abs(stats.end - live.resetsAt) > 60) {
		return live;
	}
	return {
		...live,
		usedPercentage: Math.max(100, live.usedPercentage ?? 0),
		exhausted: true,
		exhaustedAt: stats.exhausted_at ?? null,
	};
}

/** Lengths of the 5-hour and 7-day windows, in seconds. Matches `agentsessions/stats.py`'s
 * `FIVE_HOUR_SECONDS`/`SEVEN_DAY_SECONDS` (can't be shared with the Python side, so it's duplicated here). */
export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

/**
 * A non-Claude agent's side-panel rows: every window it actually has a tracked
 * percentage for, in length order — never the ones it doesn't track right now (`used_percentage
 * === null`, e.g. a free-plan Codex account with no 5-hour/7-day quota at all, only a 30-day
 * one — the always-present `five_hour`/`seven_day` placeholders are dropped here, leaving just
 * the real `window_43200m`). Can be empty (nothing shown for that agent) if none are tracked yet.
 */
export function realWindows(windows: StatsWindows | null): StatsWindow[] {
	return orderedWindows(windows).filter((w) => w.used_percentage !== null);
}

/**
 * Whether a row needs the small top margin that visually separates one agent's group of rows
 * from the previous agent's — true only for the very first row of every agent *after*
 * the first shown, since that first agent's own first row needs no separation from anything
 * above it. `agentIndex`/`rowIndexWithinAgent` are both 0-based.
 */
export function isGroupStartRow(agentIndex: number, rowIndexWithinAgent: number): boolean {
	return agentIndex > 0 && rowIndexWithinAgent === 0;
}

export interface LimitsInfo {
	fiveHour: RateLimitWindow | null;
	sevenDay: RateLimitWindow | null;
}

/** One file's worth of what `readLimitsFiles` collects. Shaped for use by the pure-function test (`pickLatestLimits`). */
export interface RawLimitsFile {
	mtimeMs: number;
	rate_limits?: {
		five_hour?: { used_percentage?: unknown; resets_at?: unknown };
		seven_day?: { used_percentage?: unknown; resets_at?: unknown };
	};
}

function num(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function windowOf(raw: { used_percentage?: unknown; resets_at?: unknown } | undefined): RateLimitWindow | null {
	const used = num(raw?.used_percentage);
	if (used == null) {
		return null;
	}
	return { usedPercentage: used, resetsAt: num(raw?.resets_at) };
}

/**
 * Takes `five_hour`/`seven_day` from whichever file with `rate_limits` has the newest mtime.
 * `null` if there's no such file.
 */
export function pickLatestLimits(files: RawLimitsFile[]): LimitsInfo | null {
	const candidates = files.filter((f) => f.rate_limits);
	if (candidates.length === 0) {
		return null;
	}
	const latest = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
	return {
		fiveHour: windowOf(latest.rate_limits?.five_hour),
		sevenDay: windowOf(latest.rate_limits?.seven_day),
	};
}

/**
 * If `w.resetsAt` is in the past relative to `now`, rolls it forward in steps of
 * `durationSeconds` (the 5-hour/7-day window length) to get the current window's `resetsAt`
 * (same rule as `agentsessions/stats.py`'s `_roll_forward`). Right after a reset, while no fresh
 * `rate_limits` has arrived yet, sets `usedPercentage` to `null` (unknown). Returns `w` as-is if
 * it's `null` or has no `resetsAt` (nothing to roll forward).
 */
export function rollForwardWindow(w: RateLimitWindow | null, durationSeconds: number, now: number): RateLimitWindow | null {
	if (!w || w.resetsAt == null || w.resetsAt >= now) {
		return w;
	}
	const periods = Math.ceil((now - w.resetsAt) / durationSeconds);
	return { usedPercentage: null, resetsAt: w.resetsAt + periods * durationSeconds };
}

/**
 * Converts a `json stats` `StatsWindow` (`agents.<agent>.windows`) into the same
 * `RateLimitWindow` shape the file-based (Claude) path produces, so both render through the
 * identical `renderWindow`. `w.end` stands in for `resetsAt` (the window's own boundary — Codex's
 * own more precise `rate_limits.resets_in_seconds` isn't part of this shape). `usedPercentage`
 * carries through `null` as-is (rather than treating it the same as "no data") — a Codex account
 * on a plan with no 5h/7d tracking at all is a confirmed real case, and the countdown (from
 * `end`) is still worth showing even when the percentage itself is unknown. `null` only when `w`
 * itself is (nothing fetched yet, or the fetch failed).
 */
export function fromStatsWindow(w: StatsWindow | null): RateLimitWindow | null {
	if (!w) {
		return null;
	}
	return {
		usedPercentage: displayedUsedPct(w),
		resetsAt: w.end,
		exhausted: !!w.exhausted,
		exhaustedAt: w.exhausted_at ?? null,
	};
}

/** `h:mm:ss` (clamped to 0 if negative). 24 hours or more drops the seconds and switches to "Nd h:mm". */
export function formatCountdown(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const pad = (n: number) => String(n).padStart(2, "0");
	const totalHours = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (totalHours >= 24) {
		const days = Math.floor(totalHours / 24);
		const h = totalHours % 24;
		return t("limits.countdownDays", { days, h, mm: pad(m) });
	}
	const sec = s % 60;
	return `${totalHours}:${pad(m)}:${pad(sec)}`;
}

