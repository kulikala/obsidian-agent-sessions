import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import { categoryAndLabel, formatCost, totalTokens } from "../src/views/detail";

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
	return {
		agent: "claude",
		name: null,
		group: null,
		label: null,
		cwd: "/v",
		folder: "v",
		last_activity: 0,
		child: false,
		transcript: null,
		status: null,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

describe("totalTokens（D-43）", () => {
	it("入力＋出力＋cache 読出＋cache 作成", () => {
		expect(totalTokens({ input: 100, output: 30, cache_read: 20, cache_create: 5 })).toBe(155);
	});

	it("全て 0 なら 0", () => {
		expect(totalTokens({ input: 0, output: 0, cache_read: 0, cache_create: 0 })).toBe(0);
	});
});

describe("formatCost（D-43）", () => {
	it("$x.xx に丸める", () => {
		expect(formatCost(1.049)).toBe("$1.05");
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(12.3)).toBe("$12.30");
	});
});

describe("categoryAndLabel（T-70 追補：詳細パネルの名前をカテゴリと分ける）", () => {
	it("カテゴリ有りの名前は分けて返す", () => {
		expect(categoryAndLabel(row({ id: "1", name: "スキル開発: セッション管理" }))).toEqual({
			category: "スキル開発",
			label: "セッション管理",
		});
	});

	it("カテゴリ無しの名前はカテゴリ null・名前そのまま", () => {
		expect(categoryAndLabel(row({ id: "1", name: "カテゴリなしの名前" }))).toEqual({
			category: null,
			label: "カテゴリなしの名前",
		});
	});

	it("名前が無ければカテゴリ null・label は表示名（label／無題）", () => {
		expect(categoryAndLabel(row({ id: "1", name: null, label: "見出し" }))).toEqual({
			category: null,
			label: "見出し",
		});
		expect(categoryAndLabel(row({ id: "12345678", name: null, label: null }))).toEqual({
			category: null,
			label: "無題 12345678",
		});
	});
});
