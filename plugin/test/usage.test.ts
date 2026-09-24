import { describe, expect, it } from "vitest";
import {
	effectiveRange,
	formatCost,
	formatDuration,
	formatEpoch,
	formatK,
	nextSelection,
	promptOrBeforeFirst,
	sumRange,
	toMarkdown,
} from "../src/usage";
import type { UsageTurn } from "../src/types";

function turn(overrides: Partial<UsageTurn> & Pick<UsageTurn, "index">): UsageTurn {
	return {
		ts: 0,
		prompt: "",
		calls: 0,
		input: 0,
		cache_create: 0,
		cache_read: 0,
		output: 0,
		thinking: 0,
		cost: 0,
		tools: {},
		estimated: false,
		last_ts: null,
		context_last: 0,
		models: {},
		...overrides,
	};
}

const TURNS: UsageTurn[] = [
	turn({
		index: 0,
		ts: 1700000000,
		prompt: "(before start)",
		calls: 1,
		input: 10,
		output: 5,
		cost: 0.01,
		tools: { Bash: 1 },
		last_ts: 1700000005,
		context_last: 10,
	}),
	turn({
		index: 1,
		ts: 1700000100,
		prompt: "hello",
		calls: 2,
		input: 100,
		cache_create: 50,
		cache_read: 20,
		output: 30,
		thinking: 5,
		cost: 0.05,
		tools: { Read: 1, Bash: 1 },
		last_ts: 1700000150,
		context_last: 170,
	}),
	turn({
		index: 2,
		ts: 1700000200,
		prompt: "continued",
		calls: 3,
		input: 200,
		cache_read: 100,
		output: 60,
		thinking: 10,
		cost: 0.08,
		tools: { Read: 2 },
		last_ts: 1700000260,
		context_last: 300,
	}),
];

describe("sumRange", () => {
	it("sums the whole range (cost, tools, duration, context_last included)", () => {
		const total = sumRange(TURNS, 0, 2);
		expect(total.calls).toBe(6);
		expect(total.input).toBe(310);
		expect(total.cache_create).toBe(50);
		expect(total.cache_read).toBe(120);
		expect(total.output).toBe(95);
		expect(total.thinking).toBe(15);
		expect(total.cost).toBeCloseTo(0.14, 6);
		expect(total.tools).toEqual({ Bash: 2, Read: 3 });
		expect(total.estimated).toBe(false);
		expect(total.first_ts).toBe(1700000000);
		expect(total.last_ts).toBe(1700000260);
		expect(total.duration).toBe(260);
		expect(total.context_last).toBe(300);
	});

	it("sums only a partial range", () => {
		const total = sumRange(TURNS, 1, 2);
		expect(total.cost).toBeCloseTo(0.13, 6);
		expect(total.tools).toEqual({ Read: 3, Bash: 1 });
		expect(total.first_ts).toBe(1700000100);
		expect(total.last_ts).toBe(1700000260);
		expect(total.duration).toBe(160);
		expect(total.context_last).toBe(300);
	});

	it("a range of just one turn", () => {
		const total = sumRange(TURNS, 1, 1);
		expect(total.cost).toBeCloseTo(0.05, 6);
		expect(total.tools).toEqual({ Read: 1, Bash: 1 });
		expect(total.duration).toBe(50);
		expect(total.context_last).toBe(170);
	});

	it("gives the same result whether from/to are swapped or not", () => {
		expect(sumRange(TURNS, 2, 1)).toEqual(sumRange(TURNS, 1, 2));
	});

	it("returns zero-filled/empty values for an out-of-range selection, with duration null", () => {
		const total = sumRange(TURNS, 10, 20);
		expect(total.calls).toBe(0);
		expect(total.cost).toBe(0);
		expect(total.tools).toEqual({});
		expect(total.first_ts).toBeNull();
		expect(total.last_ts).toBeNull();
		expect(total.duration).toBeNull();
	});

	it("doesn't break when there are no turns", () => {
		const total = sumRange([], 0, 0);
		expect(total.calls).toBe(0);
		expect(total.tools).toEqual({});
		expect(total.duration).toBeNull();
	});

	it("is true when any turn in the range is estimated", () => {
		const turns = [TURNS[0], turn({ ...TURNS[1], estimated: true }), TURNS[2]];
		expect(sumRange(turns, 0, 1).estimated).toBe(true);
		expect(sumRange(turns, 2, 2).estimated).toBe(false);
	});
});

describe("formatK (k/M notation)", () => {
	it("leaves values under 1000 as-is", () => {
		expect(formatK(999)).toBe("999");
		expect(formatK(0)).toBe("0");
	});

	it("shows thousands as k, with one decimal place", () => {
		expect(formatK(1234)).toBe("1.2k");
	});

	it("shows millions as M, with one decimal place", () => {
		expect(formatK(1234567)).toBe("1.2M");
	});

	it("shows M when rounding carries a value from k up to M", () => {
		expect(formatK(999950)).toBe("1.0M");
	});

	it("shows billions as B, with one decimal place; shows B when rounding carries M up to B", () => {
		expect(formatK(1_234_000_000)).toBe("1.2B");
		expect(formatK(999_950_000)).toBe("1.0B");
	});
});

describe("formatCost (cost notation)", () => {
	it("shows <$0.01 for anything under $0.005", () => {
		expect(formatCost(0.001)).toBe("<$0.01");
		expect(formatCost(0.0049)).toBe("<$0.01");
	});

	it("otherwise shows two decimal places", () => {
		expect(formatCost(0.0051)).toBe("$0.01");
		expect(formatCost(12.3)).toBe("$12.30");
		expect(formatCost(0)).toBe("$0.00");
	});
});

describe("formatDuration (h m notation)", () => {
	it("converts seconds to h m", () => {
		expect(formatDuration(300)).toBe("0h 5m");
		expect(formatDuration(448920)).toBe("124h 42m");
		expect(formatDuration(0)).toBe("0h 0m");
	});

	it("shows the em dash for null or negative values", () => {
		expect(formatDuration(null)).toBe("—");
		expect(formatDuration(-1)).toBe("—");
	});
});

describe("formatEpoch (MM-DD HH:MM)", () => {
	it("converts an epoch second to local MM-DD HH:MM", () => {
		const ts = Math.floor(new Date(2024, 2, 5, 9, 7, 30).getTime() / 1000);
		expect(formatEpoch(ts)).toBe("03-05 09:07");
	});

	it("zero-pads single-digit month/day/hour/minute", () => {
		const ts = Math.floor(new Date(2024, 0, 1, 1, 2, 0).getTime() / 1000);
		expect(formatEpoch(ts)).toBe("01-01 01:02");
	});

	it("shows the em dash for null (e.g. a turn with no ts, like one before the session starts)", () => {
		expect(formatEpoch(null)).toBe("—");
	});
});

describe("nextSelection (range selection via row clicks)", () => {
	it("clicking while nothing is selected selects just the start row", () => {
		expect(nextSelection(null, 5)).toEqual({ anchor: 5, end: null });
	});

	it("clicking the same row again while only the start row is selected clears the selection", () => {
		expect(nextSelection({ anchor: 5, end: null }, 5)).toBeNull();
	});

	it("clicking a different row while only the start row is selected fixes the end row and confirms the range", () => {
		expect(nextSelection({ anchor: 5, end: null }, 8)).toEqual({ anchor: 5, end: 8 });
	});

	it("clicking while a range is already confirmed makes the clicked row the new start row", () => {
		expect(nextSelection({ anchor: 5, end: 8 }, 2)).toEqual({ anchor: 2, end: null });
	});
});

describe("effectiveRange (selection state to actual range)", () => {
	it("no selection spans the first turn through the last", () => {
		expect(effectiveRange(null, TURNS)).toEqual({ from: 0, to: 2, pending: false });
	});

	it("a start-row-only selection becomes a range of just that one row", () => {
		expect(effectiveRange({ anchor: 1, end: null }, TURNS)).toEqual({ from: 1, to: 1, pending: true });
	});

	it("a confirmed range always has from <= to, regardless of click order", () => {
		expect(effectiveRange({ anchor: 8, end: 3 }, TURNS)).toEqual({ from: 3, to: 8, pending: false });
		expect(effectiveRange({ anchor: 3, end: 8 }, TURNS)).toEqual({ from: 3, to: 8, pending: false });
	});
});

describe("card totals for the whole (unselected) range (same steps the modal's renderSelection uses)", () => {
	// When selection is null, the modal builds the "whole range" card by going
	// effectiveRange(null, turns) -> sumRange -> count filter. These tests pin
	// down that the result is never #NaN and never a 0-turn count.
	function selectAll(turns: UsageTurn[]) {
		const { from, to, pending } = effectiveRange(null, turns);
		const total = sumRange(turns, from, to);
		const count = turns.filter((t) => t.index >= from && t.index <= to).length;
		return { from, to, pending, total, count };
	}

	it("with 3 turns, the whole range is #0-#2, 3 turns (never NaN)", () => {
		const { from, to, pending, total, count } = selectAll(TURNS);
		expect(from).toBe(0);
		expect(to).toBe(2);
		expect(pending).toBe(false);
		expect(count).toBe(3);
		expect(Number.isNaN(from)).toBe(false);
		expect(Number.isNaN(to)).toBe(false);
		expect(total.cost).toBeCloseTo(0.14, 6);
	});

	it("even with many turns, the whole-range count matches the total turn count", () => {
		const many: UsageTurn[] = Array.from({ length: 40 }, (_, i) =>
			turn({ index: i, ts: 1700000000 + i * 100, prompt: `#${i}`, input: i, output: i, cost: 0.001 * i, last_ts: 1700000050 + i * 100 })
		);
		const { from, to, count } = selectAll(many);
		expect(from).toBe(0);
		expect(to).toBe(39);
		expect(count).toBe(40);
	});

	it("doesn't break for a session with only one turn", () => {
		const single = [TURNS[0]];
		const { from, to, count } = selectAll(single);
		expect(from).toBe(0);
		expect(to).toBe(0);
		expect(count).toBe(1);
	});
});

// test/setup.ts defaults the test locale to "ja", so toMarkdown's rendered
// text below is the current Japanese UI copy from src/i18n.ts; these
// assertions are checking that actual rendered output, not incidental filler.
describe("toMarkdown (for copying)", () => {
	it("the table lists only turns in the selected range, with the card values in the header", () => {
		const total = sumRange(TURNS, 1, 2);
		const md = toMarkdown(TURNS, 1, 2, total);

		expect(md).toContain("# セッション解析結果（#1〜#2）");
		expect(md).toContain(`- コスト: ${formatCost(total.cost)}`);
		expect(md).toContain(`- 期間: ${formatDuration(total.duration)}`);
		expect(md).toContain("| # | 時刻 | 指示 | 入力 | 出力 | コスト |");
		expect(md).not.toMatch(/^\| 0 \|/m);
		expect(md).toMatch(/^\| 1 \|/m);
		expect(md).toMatch(/^\| 2 \|/m);
		expect(md).not.toContain("(before start)");
	});

	it("marks estimated totals with the estimated suffix", () => {
		const turns = [turn({ ...TURNS[1], estimated: true })];
		const total = sumRange(turns, 1, 1);
		const md = toMarkdown(turns, 1, 1, total);
		expect(md).toContain("（概算）");
	});

	it("shows input as k/M-formatted non-cache + cache-read + cache-create total", () => {
		const big: UsageTurn[] = [
			turn({ index: 0, ts: 1700000000, prompt: "x", input: 1000000, cache_read: 234567, output: 89012 }),
		];
		const total = sumRange(big, 0, 0);
		const md = toMarkdown(big, 0, 0, total);
		expect(md).toContain(formatK(1000000 + 234567));
		expect(md).toContain(formatK(89012));
	});

	it("collapses newlines and escapes `|` in the prompt text", () => {
		const withPipe: UsageTurn[] = [turn({ index: 0, ts: 1700000000, prompt: "a\n|b|  c" })];
		const total = sumRange(withPipe, 0, 0);
		const md = toMarkdown(withPipe, 0, 0, total);
		expect(md).toContain("a \\|b\\| c");
	});

	it("produces the same table whether from/to are swapped or not", () => {
		const total = sumRange(TURNS, 0, 1);
		expect(toMarkdown(TURNS, 0, 1, total)).toBe(toMarkdown(TURNS, 1, 0, total));
	});

	it("shows the before-first-prompt placeholder for a before_first turn instead of its (empty) prompt", () => {
		const turns: UsageTurn[] = [turn({ index: 0, ts: 1700000000, prompt: "", before_first: true })];
		const total = sumRange(turns, 0, 0);
		const md = toMarkdown(turns, 0, 0, total);
		expect(md).toContain("（開始前）");
	});
});

describe("promptOrBeforeFirst", () => {
	it("shows the turn's own prompt when before_first is unset", () => {
		expect(promptOrBeforeFirst(turn({ index: 0, prompt: "hello" }))).toBe("hello");
	});

	it("shows the before-first-prompt placeholder when before_first is true, ignoring the (empty) prompt", () => {
		expect(promptOrBeforeFirst(turn({ index: 0, prompt: "", before_first: true }))).toBe("（開始前）");
	});
});
