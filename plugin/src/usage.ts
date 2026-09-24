// Token accounting. Re-sums `json usage ID`'s results over a selected range (turn `index`,
// inclusive of both ends) and formats it for display and Markdown copy. Pure functions only —
// no dependency on `obsidian` or `@xterm/xterm` (tested in test/usage.test.ts).

import { t } from "./i18n";
import type { UsageTotal, UsageTurn } from "./types";

const TOTAL_KEYS = ["calls", "input", "cache_create", "cache_read", "output", "thinking"] as const;

function emptyTotal(): UsageTotal {
	return {
		calls: 0,
		input: 0,
		cache_create: 0,
		cache_read: 0,
		output: 0,
		thinking: 0,
		cost: 0,
		tools: {},
		estimated: false,
		duration: null,
		first_ts: null,
		last_ts: null,
		context_last: 0,
	};
}

/**
 * Sums the turns whose `index` falls within `from`–`to` (inclusive; can be passed in either
 * order). Besides `cost` and `tools` (summed per name), `duration` is the span from the
 * earliest turn's `ts` (start) to the latest counted assistant row's `last_ts` within the range
 * (`null` unless both are available).
 */
export function sumRange(turns: UsageTurn[], from: number, to: number): UsageTotal {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	const total = emptyTotal();
	for (const turn of turns) {
		if (turn.index < lo || turn.index > hi) {
			continue;
		}
		for (const key of TOTAL_KEYS) {
			total[key] += turn[key];
		}
		total.cost += turn.cost;
		for (const [name, count] of Object.entries(turn.tools)) {
			total.tools[name] = (total.tools[name] ?? 0) + count;
		}
		if (turn.estimated) {
			total.estimated = true;
		}
		if (turn.ts !== null && (total.first_ts === null || turn.ts < total.first_ts)) {
			total.first_ts = turn.ts;
		}
		if (turn.last_ts !== null && (total.last_ts === null || turn.last_ts >= total.last_ts)) {
			total.last_ts = turn.last_ts;
			total.context_last = turn.context_last;
		}
	}
	total.duration = total.first_ts !== null && total.last_ts !== null ? total.last_ts - total.first_ts : null;
	return total;
}

/** Comma-separated thousands. */
export function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

/** `999`→`999`, `1,234`→`1.2k`, `1,234,567`→`1.2M`, `1,234,000,000`→`1.2B`.
 * Used for input/output on cards and the turn table, and total tokens in the detail view. */
export function formatK(n: number): string {
	const abs = Math.abs(n);
	if (abs < 1000) {
		return String(n);
	}
	if (abs < 1_000_000) {
		// If rounding carries into the next magnitude (e.g. 999,950 → 1.0M), defer to the M formatting.
		const rounded = Math.round(n / 100) * 100;
		if (Math.abs(rounded) >= 1_000_000) {
			return formatK(rounded);
		}
		return `${(n / 1000).toFixed(1)}k`;
	}
	if (abs < 1_000_000_000) {
		// Same reasoning, for M carrying into B (e.g. 999,950,000 → 1.0B).
		const rounded = Math.round(n / 100_000) * 100_000;
		if (Math.abs(rounded) >= 1_000_000_000) {
			return formatK(rounded);
		}
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Below `$0.005` shows `<$0.01`; otherwise two decimal places. */
export function formatCost(n: number): string {
	if (n > 0 && n < 0.005) {
		return "<$0.01";
	}
	return `$${n.toFixed(2)}`;
}

/** Formats `duration` (seconds) as `h m`. `null` shows as "—". */
export function formatDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
		return "—";
	}
	const totalMinutes = Math.round(seconds / 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	return `${h}h ${m}m`;
}

/** `MM-DD HH:MM` (local time). `null` shows as "—" (turns with no `ts`, e.g. one recorded before the session started). */
export function formatEpoch(ts: number | null): string {
	if (ts === null) {
		return "—";
	}
	const d = new Date(ts * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Range-selection state. `null` = whole. `end === null` = only the start row is picked, waiting for the end row. */
export interface TurnSelection {
	anchor: number;
	end: number | null;
}
export type Selection = TurnSelection | null;

/**
 * Applies one click on a turn-table row to the selection state.
 * - Clicking while "whole" or a confirmed range is active → that turn becomes the new start row.
 * - Clicking the same row while only the start row is selected → clears it (back to "whole").
 * - Clicking a different row while only the start row is selected → that row becomes the end row, confirming the range.
 */
export function nextSelection(cur: Selection, clickedIndex: number): Selection {
	if (cur === null || cur.end !== null) {
		return { anchor: clickedIndex, end: null };
	}
	if (clickedIndex === cur.anchor) {
		return null;
	}
	return { anchor: cur.anchor, end: clickedIndex };
}

/**
 * Turns the selection state into the actual range to apply to the turn table (while only the
 * start row is selected, that's a range of just that one row). "Whole" is computed from the
 * min/max of every turn's `index`, not from `turns`' array order (first/last element) — `{0, 0}`
 * if there are no turns (never `NaN`).
 */
export function effectiveRange(sel: Selection, turns: UsageTurn[]): { from: number; to: number; pending: boolean } {
	if (sel === null) {
		if (turns.length === 0) {
			return { from: 0, to: 0, pending: false };
		}
		let first = turns[0].index;
		let last = turns[0].index;
		for (const t of turns) {
			if (t.index < first) first = t.index;
			if (t.index > last) last = t.index;
		}
		return { from: first, to: last, pending: false };
	}
	if (sel.end === null) {
		return { from: sel.anchor, to: sel.anchor, pending: true };
	}
	return { from: Math.min(sel.anchor, sel.end), to: Math.max(sel.anchor, sel.end), pending: false };
}

/** Collapses newlines/whitespace and escapes `|` so it doesn't break the Markdown table. */
function escapeCell(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/**
 * The prompt text to show for a turn. `before_first` marks the pseudo-turn that stands in for
 * everything before the first real prompt (its `prompt` is empty), so that gets a dedicated
 * placeholder instead of falling through to "(empty)".
 */
export function promptOrBeforeFirst(turn: UsageTurn): string {
	return turn.before_first ? t("usage.beforeFirstPrompt") : turn.prompt;
}

/**
 * Formats the card values (cost, tokens, turn count, duration) and the selected range's turn
 * table as Markdown, for copying. "Input" is uncached + cache read + cache create, same
 * definition as the card.
 */
export function toMarkdown(turns: UsageTurn[], from: number, to: number, total: UsageTotal): string {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	const rows = [...turns].filter((t) => t.index >= lo && t.index <= hi).sort((a, b) => a.index - b.index);
	const inputTotal = total.input + total.cache_read + total.cache_create;

	const lines: string[] = [];
	lines.push(t("usage.md.title", { lo, hi }));
	lines.push("");
	lines.push(
		t("usage.md.cost", { cost: formatCost(total.cost), estimated: total.estimated ? t("usage.md.estimatedSuffix") : "" })
	);
	lines.push(t("usage.md.tokens", { input: formatK(inputTotal), output: formatK(total.output) }));
	lines.push(t("usage.md.turns", { count: rows.length }));
	lines.push(t("usage.md.duration", { duration: formatDuration(total.duration) }));
	lines.push("");
	lines.push(t("usage.md.tableHeader"));
	lines.push("|---|---|---|---|---|---|");
	for (const t of rows) {
		const input = t.input + t.cache_read + t.cache_create;
		lines.push(
			`| ${t.index} | ${formatEpoch(t.ts)} | ${escapeCell(promptOrBeforeFirst(t))} | ${formatK(input)} | ` +
				`${formatK(t.output)} | ${formatCost(t.cost)} |`
		);
	}
	return lines.join("\n");
}
