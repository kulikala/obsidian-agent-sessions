import { describe, expect, it } from "vitest";
import { assignCategoryColor, ensureCategoryColors, PALETTE_SIZE, paletteHueDeg } from "../src/category";

describe("paletteHueDeg", () => {
	it("maps 0-11 to 0-330 in steps of 30", () => {
		expect(paletteHueDeg(0)).toBe(0);
		expect(paletteHueDeg(1)).toBe(30);
		expect(paletteHueDeg(11)).toBe(330);
	});

	it("wraps out-of-range indices", () => {
		expect(paletteHueDeg(12)).toBe(0);
		expect(paletteHueDeg(-1)).toBe(330);
	});
});

describe("assignCategoryColor", () => {
	it("assigns a new category the smallest unused index", () => {
		const colors: Record<string, number> = { a: 0, b: 2 };
		expect(assignCategoryColor(colors, "c")).toBe(1);
		expect(colors.c).toBe(1);
	});

	it("leaves an existing category's index unchanged", () => {
		const colors: Record<string, number> = { a: 5 };
		expect(assignCategoryColor(colors, "a")).toBe(5);
		expect(assignCategoryColor(colors, "a")).toBe(5);
		expect(colors).toEqual({ a: 5 });
	});

	it("picks the least-used index (ties broken by the smaller index) once all 12 are taken", () => {
		const colors: Record<string, number> = {};
		for (let i = 0; i < PALETTE_SIZE; i++) {
			colors[`cat${i}`] = i;
		}
		// Make index 0 used twice.
		colors.extra = 0;

		expect(assignCategoryColor(colors, "new")).toBe(1);
	});

	it("assigns 0, 1, 2, ... in order when starting from empty", () => {
		const colors: Record<string, number> = {};
		const assigned = ["a", "b", "c"].map((name) => assignCategoryColor(colors, name));
		expect(assigned).toEqual([0, 1, 2]);
	});
});

describe("ensureCategoryColors", () => {
	it("assigns only the missing categories and returns true when it changed anything", () => {
		const colors: Record<string, number> = { a: 0 };
		expect(ensureCategoryColors(colors, ["a", "b"])).toBe(true);
		expect(colors.a).toBe(0);
		expect(colors.b).toBe(1);
	});

	it("does nothing and returns false when everything is already assigned", () => {
		const colors: Record<string, number> = { a: 0, b: 1 };
		expect(ensureCategoryColors(colors, ["a", "b"])).toBe(false);
		expect(colors).toEqual({ a: 0, b: 1 });
	});
});
