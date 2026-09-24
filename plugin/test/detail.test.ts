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
		waitingFor: null,
		compacted: false,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

describe("totalTokens", () => {
	it("sums input + output + cache read + cache write", () => {
		expect(totalTokens({ input: 100, output: 30, cache_read: 20, cache_create: 5 })).toBe(155);
	});

	it("returns 0 when everything is 0", () => {
		expect(totalTokens({ input: 0, output: 0, cache_read: 0, cache_create: 0 })).toBe(0);
	});
});

describe("formatCost", () => {
	it("rounds to $x.xx", () => {
		expect(formatCost(1.049)).toBe("$1.05");
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(12.3)).toBe("$12.30");
	});
});

describe("categoryAndLabel (splits the detail panel's name into category and label)", () => {
	it("splits a name that has a category", () => {
		// Japanese fixture: exercises splitting a real Japanese category/label pair.
		expect(categoryAndLabel(row({ id: "1", name: "スキル開発: セッション管理" }))).toEqual({
			category: "スキル開発",
			label: "セッション管理",
		});
	});

	it("a name without a category returns category null and the name unchanged", () => {
		expect(categoryAndLabel(row({ id: "1", name: "Name without category" }))).toEqual({
			category: null,
			label: "Name without category",
		});
	});

	it("with no name, category is null and label falls back to the display name (label, then Untitled)", () => {
		expect(categoryAndLabel(row({ id: "1", name: null, label: "Heading" }))).toEqual({
			category: null,
			label: "Heading",
		});
		expect(categoryAndLabel(row({ id: "12345678", name: null, label: null }))).toEqual({
			category: null,
			label: "無題 12345678",
		});
	});
});
