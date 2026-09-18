import { describe, expect, it } from "vitest";
import { formatCost, totalTokens } from "../src/views/detail";

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
