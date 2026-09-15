import { describe, expect, it } from "vitest";
import { formatEpoch, formatNumber, sumRange, toMarkdown } from "../src/usage";
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
		models: {},
		...overrides,
	};
}

const TURNS: UsageTurn[] = [
	turn({ index: 0, ts: 1700000000, prompt: "（開始前）", calls: 1, input: 10, cache_create: 0, cache_read: 0, output: 5 }),
	turn({ index: 1, ts: 1700000100, prompt: "こんにちは", calls: 2, input: 100, cache_create: 50, cache_read: 20, output: 30, thinking: 5 }),
	turn({ index: 2, ts: 1700000200, prompt: "続き", calls: 3, input: 200, cache_create: 0, cache_read: 100, output: 60, thinking: 10 }),
];

describe("sumRange（§D-31）", () => {
	it("全区間を合計する", () => {
		expect(sumRange(TURNS, 0, 2)).toEqual({
			calls: 6,
			input: 310,
			cache_create: 50,
			cache_read: 120,
			output: 95,
			thinking: 15,
		});
	});

	it("部分区間だけ合計する", () => {
		expect(sumRange(TURNS, 1, 2)).toEqual({
			calls: 5,
			input: 300,
			cache_create: 50,
			cache_read: 120,
			output: 90,
			thinking: 15,
		});
	});

	it("1 ターンだけの区間", () => {
		expect(sumRange(TURNS, 1, 1)).toEqual({
			calls: 2,
			input: 100,
			cache_create: 50,
			cache_read: 20,
			output: 30,
			thinking: 5,
		});
	});

	it("from と to が逆でも同じ結果になる", () => {
		expect(sumRange(TURNS, 2, 1)).toEqual(sumRange(TURNS, 1, 2));
	});

	it("範囲外なら 0 埋めで返す", () => {
		expect(sumRange(TURNS, 10, 20)).toEqual({
			calls: 0,
			input: 0,
			cache_create: 0,
			cache_read: 0,
			output: 0,
			thinking: 0,
		});
	});

	it("ターンが無くても壊れない", () => {
		expect(sumRange([], 0, 0)).toEqual({
			calls: 0,
			input: 0,
			cache_create: 0,
			cache_read: 0,
			output: 0,
			thinking: 0,
		});
	});
});

describe("formatNumber（§D-31 3 桁区切り）", () => {
	it("3 桁ごとにカンマを入れる", () => {
		expect(formatNumber(1234567)).toBe("1,234,567");
	});

	it("1000 未満はそのまま", () => {
		expect(formatNumber(42)).toBe("42");
	});

	it("0 も出す", () => {
		expect(formatNumber(0)).toBe("0");
	});
});

describe("formatEpoch（§D-31 MM-DD HH:MM）", () => {
	it("epoch 秒をローカルの MM-DD HH:MM にする", () => {
		const ts = Math.floor(new Date(2024, 2, 5, 9, 7, 30).getTime() / 1000);
		expect(formatEpoch(ts)).toBe("03-05 09:07");
	});

	it("1 桁の月日時分を 0 埋めする", () => {
		const ts = Math.floor(new Date(2024, 0, 1, 1, 2, 0).getTime() / 1000);
		expect(formatEpoch(ts)).toBe("01-01 01:02");
	});
});

describe("toMarkdown（§D-31 コピー用）", () => {
	it("表は選んだ区間のターンだけを出し、合計は区間のものを見出しに付ける", () => {
		const total = sumRange(TURNS, 1, 2);
		const md = toMarkdown(TURNS, 1, 2, total);

		expect(md).toContain("| # | 時刻 | 指示 | 入力 | 出力 | cache 作成 | cache 読出 |");
		expect(md).not.toContain("| 0 |");
		expect(md).toContain("| 1 |");
		expect(md).toContain("| 2 |");
		expect(md).not.toContain("（開始前）");
		expect(md).toContain(`合計（#1〜#2）：呼出 ${formatNumber(5)}・入力 ${formatNumber(300)}`);
	});

	it("数値を 3 桁区切りで出す", () => {
		const big: UsageTurn[] = [turn({ index: 0, ts: 1700000000, prompt: "x", input: 1234567, output: 89012 })];
		const total = sumRange(big, 0, 0);
		const md = toMarkdown(big, 0, 0, total);
		expect(md).toContain("1,234,567");
		expect(md).toContain("89,012");
	});

	it("指示中の改行と `|` を潰す・逃がす", () => {
		const withPipe: UsageTurn[] = [turn({ index: 0, ts: 1700000000, prompt: "a\n|b|  c" })];
		const total = sumRange(withPipe, 0, 0);
		const md = toMarkdown(withPipe, 0, 0, total);
		expect(md).toContain("a \\|b\\| c");
	});

	it("from と to が逆でも同じ表になる", () => {
		const total = sumRange(TURNS, 0, 1);
		expect(toMarkdown(TURNS, 0, 1, total)).toBe(toMarkdown(TURNS, 1, 0, total));
	});
});
