import { describe, expect, it } from "vitest";
import { isPromptEmpty } from "../src/prompt-line";

describe("isPromptEmpty（D-42 入力行の判定）", () => {
	it("最後の ❯ の行の後ろが空白だけなら true", () => {
		expect(isPromptEmpty(["● 応答の本文", "", "❯ ", "  ? for shortcuts"])).toBe(true);
		expect(isPromptEmpty(["❯"])).toBe(true);
	});

	it("最後の ❯ の行に文字があれば false", () => {
		expect(isPromptEmpty(["❯ 途中まで打った", ""])).toBe(false);
		expect(isPromptEmpty(["❯ a"])).toBe(false);
	});

	it("履歴の ❯ ではなく最後の ❯ の行を見る", () => {
		expect(isPromptEmpty(["❯ 前の指示", "● 応答", "❯ "])).toBe(true);
		expect(isPromptEmpty(["❯ ", "● 応答", "❯ 入力中"])).toBe(false);
	});

	it("❯ の行が無ければ false（空と断定しない）", () => {
		expect(isPromptEmpty([])).toBe(false);
		expect(isPromptEmpty(["セッションは終了しました", ""])).toBe(false);
	});

	it("❯ の前に飾りがあっても後ろだけを見る", () => {
		expect(isPromptEmpty(["│ ❯   │"])).toBe(false);
		expect(isPromptEmpty(["│ ❯ ", "│ 続き"])).toBe(true);
	});
});
