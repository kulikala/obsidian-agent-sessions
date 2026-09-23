import { describe, expect, it } from "vitest";
import { assignCategoryColor, ensureCategoryColors, PALETTE_SIZE, paletteHueDeg } from "../src/category";

describe("paletteHueDeg（T-70）", () => {
	it("0〜11 を 0〜330（30 刻み）にする", () => {
		expect(paletteHueDeg(0)).toBe(0);
		expect(paletteHueDeg(1)).toBe(30);
		expect(paletteHueDeg(11)).toBe(330);
	});

	it("範囲外は畳み込む", () => {
		expect(paletteHueDeg(12)).toBe(0);
		expect(paletteHueDeg(-1)).toBe(330);
	});
});

describe("assignCategoryColor（T-70）", () => {
	it("新規カテゴリには、まだ使われていない番号のうち最小のものを割り当てる", () => {
		const colors: Record<string, number> = { a: 0, b: 2 };
		expect(assignCategoryColor(colors, "c")).toBe(1);
		expect(colors.c).toBe(1);
	});

	it("既存カテゴリの番号は不変", () => {
		const colors: Record<string, number> = { a: 5 };
		expect(assignCategoryColor(colors, "a")).toBe(5);
		expect(assignCategoryColor(colors, "a")).toBe(5);
		expect(colors).toEqual({ a: 5 });
	});

	it("12 個すべて使われていたら、最も使用回数の少ない番号（同数なら小さいほう）を選ぶ", () => {
		const colors: Record<string, number> = {};
		for (let i = 0; i < PALETTE_SIZE; i++) {
			colors[`cat${i}`] = i;
		}
		// ここで番号 0 が 2 回使われた状態にしておく。
		colors.extra = 0;

		expect(assignCategoryColor(colors, "new")).toBe(1);
	});

	it("空にした状態から順番に割り当てると 0, 1, 2, … の順になる", () => {
		const colors: Record<string, number> = {};
		const assigned = ["a", "b", "c"].map((name) => assignCategoryColor(colors, name));
		expect(assigned).toEqual([0, 1, 2]);
	});
});

describe("ensureCategoryColors（T-70）", () => {
	it("無いカテゴリだけ割り当て、変更が有れば真を返す", () => {
		const colors: Record<string, number> = { a: 0 };
		expect(ensureCategoryColors(colors, ["a", "b"])).toBe(true);
		expect(colors.a).toBe(0);
		expect(colors.b).toBe(1);
	});

	it("すべて既に割当済みなら何もせず偽を返す", () => {
		const colors: Record<string, number> = { a: 0, b: 1 };
		expect(ensureCategoryColors(colors, ["a", "b"])).toBe(false);
		expect(colors).toEqual({ a: 0, b: 1 });
	});
});
