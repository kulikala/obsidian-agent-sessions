import { describe, expect, it } from "vitest";
import {
	effectiveRange,
	formatCost,
	formatDuration,
	formatEpoch,
	formatK,
	nextSelection,
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
		prompt: "（開始前）",
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
		prompt: "こんにちは",
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
		prompt: "続き",
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

describe("sumRange（§D-45）", () => {
	it("全区間を合計する（cost・tools・duration・context_last を含む）", () => {
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

	it("部分区間だけ合計する", () => {
		const total = sumRange(TURNS, 1, 2);
		expect(total.cost).toBeCloseTo(0.13, 6);
		expect(total.tools).toEqual({ Read: 3, Bash: 1 });
		expect(total.first_ts).toBe(1700000100);
		expect(total.last_ts).toBe(1700000260);
		expect(total.duration).toBe(160);
		expect(total.context_last).toBe(300);
	});

	it("1 ターンだけの区間", () => {
		const total = sumRange(TURNS, 1, 1);
		expect(total.cost).toBeCloseTo(0.05, 6);
		expect(total.tools).toEqual({ Read: 1, Bash: 1 });
		expect(total.duration).toBe(50);
		expect(total.context_last).toBe(170);
	});

	it("from と to が逆でも同じ結果になる", () => {
		expect(sumRange(TURNS, 2, 1)).toEqual(sumRange(TURNS, 1, 2));
	});

	it("範囲外なら 0 埋め・空で返し、duration は null になる", () => {
		const total = sumRange(TURNS, 10, 20);
		expect(total.calls).toBe(0);
		expect(total.cost).toBe(0);
		expect(total.tools).toEqual({});
		expect(total.first_ts).toBeNull();
		expect(total.last_ts).toBeNull();
		expect(total.duration).toBeNull();
	});

	it("ターンが無くても壊れない", () => {
		const total = sumRange([], 0, 0);
		expect(total.calls).toBe(0);
		expect(total.tools).toEqual({});
		expect(total.duration).toBeNull();
	});

	it("区間内のいずれかのターンが estimated なら真になる", () => {
		const turns = [TURNS[0], turn({ ...TURNS[1], estimated: true }), TURNS[2]];
		expect(sumRange(turns, 0, 1).estimated).toBe(true);
		expect(sumRange(turns, 2, 2).estimated).toBe(false);
	});
});

describe("formatK（§D-45 k／M 表記）", () => {
	it("1000 未満はそのまま", () => {
		expect(formatK(999)).toBe("999");
		expect(formatK(0)).toBe("0");
	});

	it("千は k、小数 1 桁", () => {
		expect(formatK(1234)).toBe("1.2k");
	});

	it("百万は M、小数 1 桁", () => {
		expect(formatK(1234567)).toBe("1.2M");
	});

	it("丸めで k から M へ繰り上がる場合は M 側を出す", () => {
		expect(formatK(999950)).toBe("1.0M");
	});
});

describe("formatCost（§D-45 コスト表記）", () => {
	it("$0.005 未満は <$0.01", () => {
		expect(formatCost(0.001)).toBe("<$0.01");
		expect(formatCost(0.0049)).toBe("<$0.01");
	});

	it("それ以外は小数 2 桁", () => {
		expect(formatCost(0.0051)).toBe("$0.01");
		expect(formatCost(12.3)).toBe("$12.30");
		expect(formatCost(0)).toBe("$0.00");
	});
});

describe("formatDuration（§D-45 h m 表記）", () => {
	it("秒を h m にする", () => {
		expect(formatDuration(300)).toBe("0h 5m");
		expect(formatDuration(448920)).toBe("124h 42m");
		expect(formatDuration(0)).toBe("0h 0m");
	});

	it("null や負の値は「—」", () => {
		expect(formatDuration(null)).toBe("—");
		expect(formatDuration(-1)).toBe("—");
	});
});

describe("formatEpoch（§D-45 MM-DD HH:MM）", () => {
	it("epoch 秒をローカルの MM-DD HH:MM にする", () => {
		const ts = Math.floor(new Date(2024, 2, 5, 9, 7, 30).getTime() / 1000);
		expect(formatEpoch(ts)).toBe("03-05 09:07");
	});

	it("1 桁の月日時分を 0 埋めする", () => {
		const ts = Math.floor(new Date(2024, 0, 1, 1, 2, 0).getTime() / 1000);
		expect(formatEpoch(ts)).toBe("01-01 01:02");
	});

	it("null は「—」（ts の無い（開始前）ターンなど）", () => {
		expect(formatEpoch(null)).toBe("—");
	});
});

describe("nextSelection（§D-45 行クリックの区間選択）", () => {
	it("全体からクリック → 開始行だけの選択になる", () => {
		expect(nextSelection(null, 5)).toEqual({ anchor: 5, end: null });
	});

	it("開始行だけの選択中に同じ行をクリック → 解除（全体）", () => {
		expect(nextSelection({ anchor: 5, end: null }, 5)).toBeNull();
	});

	it("開始行だけの選択中に別の行をクリック → 終了行が決まり確定する", () => {
		expect(nextSelection({ anchor: 5, end: null }, 8)).toEqual({ anchor: 5, end: 8 });
	});

	it("確定済みの区間の最中にクリック → その行を新しい開始行にする", () => {
		expect(nextSelection({ anchor: 5, end: 8 }, 2)).toEqual({ anchor: 2, end: null });
	});
});

describe("effectiveRange（§D-45 選択状態 → 実際の区間）", () => {
	it("全体は先頭〜末尾のターンになる", () => {
		expect(effectiveRange(null, TURNS)).toEqual({ from: 0, to: 2, pending: false });
	});

	it("開始行だけの選択は、その 1 行だけの区間になる", () => {
		expect(effectiveRange({ anchor: 1, end: null }, TURNS)).toEqual({ from: 1, to: 1, pending: true });
	});

	it("確定済みの区間は順不同でも from ≦ to になる", () => {
		expect(effectiveRange({ anchor: 8, end: 3 }, TURNS)).toEqual({ from: 3, to: 8, pending: false });
		expect(effectiveRange({ anchor: 3, end: 8 }, TURNS)).toEqual({ from: 3, to: 8, pending: false });
	});
});

describe("toMarkdown（§D-45 コピー用）", () => {
	it("表は選んだ区間のターンだけを出し、カードの値を見出しに付ける", () => {
		const total = sumRange(TURNS, 1, 2);
		const md = toMarkdown(TURNS, 1, 2, total);

		expect(md).toContain("# セッション解析結果（#1〜#2）");
		expect(md).toContain(`- コスト: ${formatCost(total.cost)}`);
		expect(md).toContain(`- 期間: ${formatDuration(total.duration)}`);
		expect(md).toContain("| # | 時刻 | 指示 | 入力 | 出力 | コスト |");
		expect(md).not.toMatch(/^\| 0 \|/m);
		expect(md).toMatch(/^\| 1 \|/m);
		expect(md).toMatch(/^\| 2 \|/m);
		expect(md).not.toContain("（開始前）");
	});

	it("概算のときは「（概算）」を付ける", () => {
		const turns = [turn({ ...TURNS[1], estimated: true })];
		const total = sumRange(turns, 1, 1);
		const md = toMarkdown(turns, 1, 1, total);
		expect(md).toContain("（概算）");
	});

	it("入力は非キャッシュ＋cache 読出＋cache 作成の合計を k／M で出す", () => {
		const big: UsageTurn[] = [
			turn({ index: 0, ts: 1700000000, prompt: "x", input: 1000000, cache_read: 234567, output: 89012 }),
		];
		const total = sumRange(big, 0, 0);
		const md = toMarkdown(big, 0, 0, total);
		expect(md).toContain(formatK(1000000 + 234567));
		expect(md).toContain(formatK(89012));
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
