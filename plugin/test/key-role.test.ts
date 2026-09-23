import { describe, expect, it } from "vitest";
import { classifyEnter, resolveEnterAction, sendSequence, SUBMIT_KEY_SYMBOLS, type KeyLike } from "../src/keys";
import { SUBMIT_KEYS, type SubmitKey } from "../src/settings";

function key(overrides: Partial<KeyLike> = {}): KeyLike {
	return {
		key: "Enter",
		shiftKey: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		...overrides,
	};
}

/** 5 つの押下（送信キーと同じ名前）。 */
const PRESSES: Record<SubmitKey, KeyLike> = {
	enter: key(),
	"shift+enter": key({ shiftKey: true }),
	"ctrl+enter": key({ ctrlKey: true }),
	"alt+enter": key({ altKey: true }),
	"cmd+enter": key({ metaKey: true }),
};

describe("classifyEnter", () => {
	it("Enter 以外は passthrough", () => {
		expect(classifyEnter(key({ key: "a" }))).toBe("passthrough");
		expect(classifyEnter(key({ key: "a", metaKey: true }))).toBe("passthrough");
	});

	it("IME 変換中（isComposing）の Enter は passthrough", () => {
		expect(classifyEnter(key({ isComposing: true }))).toBe("passthrough");
		expect(classifyEnter(key({ isComposing: true, metaKey: true }))).toBe("passthrough");
	});

	it("keyCode 229 の Enter は passthrough", () => {
		expect(classifyEnter(key({ keyCode: 229 }))).toBe("passthrough");
	});

	it("5 つの押下をそれぞれの名前に分類する", () => {
		for (const name of SUBMIT_KEYS) {
			expect(classifyEnter(PRESSES[name])).toBe(name);
		}
	});

	it("複数の修飾は shift → ctrl → alt → cmd の優先順", () => {
		expect(classifyEnter(key({ shiftKey: true, altKey: true }))).toBe("shift+enter");
		expect(classifyEnter(key({ ctrlKey: true, altKey: true }))).toBe("ctrl+enter");
		expect(classifyEnter(key({ altKey: true, metaKey: true }))).toBe("alt+enter");
	});
});

describe("resolveEnterAction × sendSequence（5 つの送信キー × 5 つの押下）", () => {
	for (const submitKey of SUBMIT_KEYS) {
		for (const press of SUBMIT_KEYS) {
			const expected = press === submitKey ? "submit" : "newline";
			const seq =
				submitKey === "enter" ? (expected === "submit" ? "\r" : "\x1b\r") : expected === "submit" ? "\x1b\r" : "\r";
			it(`送信キー ${submitKey} で ${press} → ${expected}（${JSON.stringify(seq)}）`, () => {
				const action = resolveEnterAction(classifyEnter(PRESSES[press]), submitKey);
				expect(action).toBe(expected);
				expect(sendSequence(action as "submit" | "newline", submitKey)).toBe(seq);
			});
		}
	}

	it("IME 中・Enter 以外はどの送信キーでも passthrough", () => {
		for (const submitKey of SUBMIT_KEYS) {
			expect(resolveEnterAction(classifyEnter(key({ isComposing: true })), submitKey)).toBe("passthrough");
			expect(resolveEnterAction(classifyEnter(key({ keyCode: 229, metaKey: true })), submitKey)).toBe("passthrough");
			expect(resolveEnterAction(classifyEnter(key({ key: "a" })), submitKey)).toBe("passthrough");
		}
	});
});

describe("SUBMIT_KEY_SYMBOLS", () => {
	it("「送る」の表記", () => {
		expect(SUBMIT_KEY_SYMBOLS).toEqual({
			enter: "⏎",
			"shift+enter": "⇧⏎",
			"ctrl+enter": "⌃⏎",
			"alt+enter": "⌥⏎",
			"cmd+enter": "⌘⏎",
		});
	});
});
