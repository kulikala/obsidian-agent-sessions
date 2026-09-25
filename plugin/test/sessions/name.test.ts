import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import {
	applyChipEditResult,
	categorizableLabel,
	composeName,
	filterCategories,
	listCategories,
	sessionDisplayName,
	tokenizeNameInput,
} from "../../src/sessions/name";
import { splitName } from "../../src/sessions/tree";

describe("applyChipEditResult (T-112: editing a category chip in place never discards the name)", () => {
	it("replaces the category with the confirmed result, trimmed, leaving name untouched", () => {
		expect(applyChipEditResult({ category: "old", name: "セッション管理" }, "  new  ")).toEqual({
			category: "new",
			name: "セッション管理",
		});
	});

	it("removes the category when the result is an empty string, still leaving name untouched", () => {
		expect(applyChipEditResult({ category: "old", name: "セッション管理" }, "")).toEqual({
			category: "",
			name: "セッション管理",
		});
		expect(applyChipEditResult({ category: "old", name: "セッション管理" }, "   ")).toEqual({
			category: "",
			name: "セッション管理",
		});
	});

	it("a canceled edit (result: null) returns the state completely unchanged, not even re-trimmed", () => {
		const state = { category: "old", name: "セッション管理" };
		expect(applyChipEditResult(state, null)).toBe(state);
	});

	it("never touches name even when name is empty (the New Session dialog's typical starting state)", () => {
		expect(applyChipEditResult({ category: "old", name: "" }, "new")).toEqual({ category: "new", name: "" });
	});

	it("regression pin for the reported bug: name is never replaced by the category text, whatever it is", () => {
		// Before the fix, clicking the chip set the shared input's value to the category's own
		// text directly, discarding a real session name like this one.
		const before = { category: "Skill dev", name: "Session management" };
		const after = applyChipEditResult(before, "Different category");
		expect(after.name).toBe("Session management");
		expect(after.name).not.toBe("Different category");
	});
});

describe("composeName", () => {
	it("joins category and name with ': '", () => {
		// Japanese fixture: category/name text as it actually appears in the product.
		expect(composeName("スキル開発", "セッション管理")).toBe("スキル開発: セッション管理");
	});

	it("returns just the name when category is empty", () => {
		expect(composeName("", "セッション管理")).toBe("セッション管理");
	});

	it("returns just the name when category is whitespace only", () => {
		expect(composeName("   ", "セッション管理")).toBe("セッション管理");
	});

	it("returns empty string when name is empty, even with a category", () => {
		expect(composeName("スキル開発", "")).toBe("");
		expect(composeName("スキル開発", "   ")).toBe("");
	});

	it("trims leading/trailing whitespace", () => {
		expect(composeName(" スキル開発 ", " セッション管理 ")).toBe("スキル開発: セッション管理");
	});

	it("returns empty string when both are empty", () => {
		expect(composeName("", "")).toBe("");
	});
});

describe("composeName and splitName round-trip", () => {
	it("with a category", () => {
		// Japanese fixture: realistic category/name pair used elsewhere in the suite.
		const composed = composeName("RIM", "議事メモ作成");
		expect(splitName(composed)).toEqual(["RIM", "議事メモ作成"]);
	});

	it("without a category", () => {
		const composed = composeName("", "酔い酒鮨庵");
		expect(splitName(composed)).toEqual([null, "酔い酒鮨庵"]);
	});
});

describe("listCategories", () => {
	it("collects categories from names, de-duplicated and sorted", () => {
		expect(
			listCategories(["RIM: 議事メモ作成", "RIM: 更新", "ZERO: 提案", "単独のセッション", null, "", "ZERO: 続き"])
		).toEqual(["RIM", "ZERO"]);
	});

	it("returns an empty array when there are no categories", () => {
		expect(listCategories(["単独", null, undefined, ""])).toEqual([]);
	});

	it("sorts in Japanese gojūon (kana) order", () => {
		// Japanese fixture: verifies gojūon ordering, not plain code-point order.
		expect(listCategories(["う: a", "あ: b", "い: c"])).toEqual(["あ", "い", "う"]);
	});
});

describe("tokenizeNameInput (single input field of the naming dialog)", () => {
	it("a half-width `:` splits immediately (no trailing space required)", () => {
		expect(tokenizeNameInput("カテゴリ:名前")).toEqual({ category: "カテゴリ", rest: "名前" });
	});

	it("a half-width `:` still splits with a trailing space (the space is dropped)", () => {
		expect(tokenizeNameInput("カテゴリ: 名前")).toEqual({ category: "カテゴリ", rest: "名前" });
		expect(tokenizeNameInput("カテゴリ: ")).toEqual({ category: "カテゴリ", rest: "" });
	});

	it("a full-width `：` only splits once a space follows it", () => {
		expect(tokenizeNameInput("カテゴリ： 名前")).toEqual({ category: "カテゴリ", rest: "名前" });
	});

	it("a full-width `：` with no following space does not split yet (null)", () => {
		expect(tokenizeNameInput("カテゴリ：名前")).toBeNull();
	});

	it("no colon at all means null (still typing the category)", () => {
		expect(tokenizeNameInput("カテゴリ")).toBeNull();
		expect(tokenizeNameInput("")).toBeNull();
	});

	it("trims leading/trailing whitespace from the category side", () => {
		expect(tokenizeNameInput(" カテゴリ :名前")).toEqual({ category: "カテゴリ", rest: "名前" });
	});

	it("once a separator is recognized, neither the category text nor the separator character " +
		"remains in `rest` (fixes a bug where the typed characters were left behind; pasting the " +
		"whole string at once follows the same rule)", () => {
		const half = tokenizeNameInput("スキル開発: 資料の見直し");
		expect(half).toEqual({ category: "スキル開発", rest: "資料の見直し" });
		expect(half?.rest.includes("スキル開発")).toBe(false);
		expect(half?.rest.includes(":")).toBe(false);

		const full = tokenizeNameInput("スキル開発： 資料の見直し");
		expect(full).toEqual({ category: "スキル開発", rest: "資料の見直し" });
		expect(full?.rest.includes("スキル開発")).toBe(false);
		expect(full?.rest.includes("：")).toBe(false);
	});
});

describe("filterCategories", () => {
	it("filters by case-insensitive substring match", () => {
		expect(filterCategories(["RIM", "ZERO", "rim2"], "rim")).toEqual(["RIM", "rim2"]);
	});

	it("an empty query returns everything unchanged", () => {
		expect(filterCategories(["RIM", "ZERO"], "")).toEqual(["RIM", "ZERO"]);
		expect(filterCategories(["RIM", "ZERO"], "   ")).toEqual(["RIM", "ZERO"]);
	});

	it("returns an empty array when nothing matches", () => {
		expect(filterCategories(["RIM", "ZERO"], "no-match")).toEqual([]);
	});

	it("ranks a prefix match ahead of a substring-only match", () => {
		// "Timing" starts with "tim"; "Optimize" only contains it.
		expect(filterCategories(["Optimize", "Timing"], "tim")).toEqual(["Timing", "Optimize"]);
	});

	it("keeps each group's own relative order otherwise", () => {
		expect(filterCategories(["b-tim", "a-tim", "Timing2", "Timing1"], "tim")).toEqual(["Timing2", "Timing1", "b-tim", "a-tim"]);
	});
});

describe("categorizableLabel", () => {
	it("uses the name's own label (after the category) when the session has been named", () => {
		expect(categorizableLabel({ name: "スキル開発: セッション管理", label: "ignored" })).toBe("セッション管理");
	});

	it("uses the name as-is when it has no category prefix", () => {
		expect(categorizableLabel({ name: "セッション管理", label: "ignored" })).toBe("セッション管理");
	});

	it("falls back to the row's auto-derived label when there's no name yet", () => {
		expect(categorizableLabel({ name: null, label: "最初のプロンプトの冒頭" })).toBe("最初のプロンプトの冒頭");
	});

	it("is empty when there's neither a name nor a label (nothing to categorize)", () => {
		expect(categorizableLabel({ name: null, label: null })).toBe("");
		expect(categorizableLabel({ name: "", label: "" })).toBe("");
	});
});

describe("sessionDisplayName (T-106: name → label → agent-name fallback, never the id)", () => {
	afterEach(() => setLang("en"));

	it("returns the name as-is when present", () => {
		// Japanese fixture: category/name text as it actually appears in the product.
		expect(sessionDisplayName({ name: "スキル開発: セッション管理", label: "ignored", agent: "claude", id: "x" })).toBe(
			"スキル開発: セッション管理"
		);
	});

	it("falls back to the label when there's no name", () => {
		expect(sessionDisplayName({ name: null, label: "現在利用可能なツールを教えて。", agent: "codex", id: "x" })).toBe(
			"現在利用可能なツールを教えて。"
		);
		expect(sessionDisplayName({ name: "", label: "First prompt", agent: "claude", id: "x" })).toBe("First prompt");
	});

	it("falls back to the agent's 'New ... session' text when there's neither a name nor a label", () => {
		expect(sessionDisplayName({ name: null, label: null, agent: "claude", id: "x" })).toBe("New Claude Code session");
		expect(sessionDisplayName({ name: null, label: undefined, agent: "codex", id: "x" })).toBe("New Codex session");
	});

	it("in Japanese, the agent fallback is localized", () => {
		setLang("ja");
		expect(sessionDisplayName({ name: null, label: null, agent: "claude", id: "x" })).toBe("新規 Claude Code セッション");
		expect(sessionDisplayName({ name: null, label: null, agent: "codex", id: "x" })).toBe("新規 Codex セッション");
	});

	it("an unrecognized agent id falls back to Claude's text (asAgentId's own default)", () => {
		expect(sessionDisplayName({ name: null, label: null, agent: "something-else", id: "x" })).toBe("New Claude Code session");
	});

	it("treats a label equal to the id as absent (Python couldn't extract anything real) — never shows the id itself", () => {
		const id = "01234567-89ab-cdef-0123-456789abcdef";
		expect(sessionDisplayName({ name: null, label: id, agent: "codex", id })).toBe("New Codex session");
	});

	it("a real label that merely starts with the id-like text is still used as-is", () => {
		const id = "01234567-89ab-cdef-0123-456789abcdef";
		expect(sessionDisplayName({ name: null, label: `${id} was mentioned`, agent: "claude", id })).toBe(
			`${id} was mentioned`
		);
	});
});
