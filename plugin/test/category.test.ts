import { describe, expect, it } from "vitest";
import { categoryHue, categoryHueDeg } from "../src/category";

describe("categoryHue（D-65）", () => {
	it("同じ名前は同じ色相", () => {
		expect(categoryHue("スキル開発")).toBe(categoryHue("スキル開発"));
		expect(categoryHue("RIM")).toBe(categoryHue("RIM"));
	});

	it("0〜11 の範囲に収まる", () => {
		const names = ["RIM", "スキル開発", "ZEROGRAVITY", "a", "", "単独", "その他", "段7"];
		for (const name of names) {
			const hue = categoryHue(name);
			expect(hue).toBeGreaterThanOrEqual(0);
			expect(hue).toBeLessThanOrEqual(11);
			expect(Number.isInteger(hue)).toBe(true);
		}
	});

	it("異なる名前は（多くの場合）異なる色相になりうる", () => {
		// 衝突を許容しつつ、定数（常に同じ値）ではないことだけ確かめる。
		const values = new Set(["RIM", "スキル開発", "ZEROGRAVITY", "段7", "Agent Sessions"].map((n) => categoryHue(n)));
		expect(values.size).toBeGreaterThan(1);
	});
});

describe("categoryHueDeg（D-65）", () => {
	it("categoryHue の 30 倍（0〜330、30 刻み）", () => {
		const name = "RIM";
		expect(categoryHueDeg(name)).toBe(categoryHue(name) * 30);
		expect(categoryHueDeg(name) % 30).toBe(0);
	});
});
