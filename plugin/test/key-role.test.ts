import { describe, expect, it } from "vitest";
import {
	classifyCtrlKeyNonMac,
	classifyEnter,
	resolveEnterAction,
	sendSequence,
	submitKeyButtonLabel,
	submitKeyStatuslineSymbol,
	SUBMIT_KEY_SYMBOLS,
	type KeyLike,
} from "../src/keys";
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

describe("submitKeyButtonLabel／submitKeyStatuslineSymbol（非macOS対応）", () => {
	it("macOS は SUBMIT_KEY_SYMBOLS のまま", () => {
		for (const k of SUBMIT_KEYS) {
			expect(submitKeyButtonLabel(k, true)).toBe(SUBMIT_KEY_SYMBOLS[k]);
			expect(submitKeyStatuslineSymbol(k, true)).toBe(SUBMIT_KEY_SYMBOLS[k]);
		}
	});

	it("非 macOS の「送る」ボタンは文字表記", () => {
		expect(submitKeyButtonLabel("enter", false)).toBe("Enter");
		expect(submitKeyButtonLabel("shift+enter", false)).toBe("Shift+Enter");
		expect(submitKeyButtonLabel("ctrl+enter", false)).toBe("Ctrl+Enter");
		expect(submitKeyButtonLabel("alt+enter", false)).toBe("Alt+Enter");
	});

	it("非 macOS の statusLine は短い文字表記", () => {
		expect(submitKeyStatuslineSymbol("enter", false)).toBe("⏎");
		expect(submitKeyStatuslineSymbol("shift+enter", false)).toBe("S-⏎");
		expect(submitKeyStatuslineSymbol("ctrl+enter", false)).toBe("C-⏎");
		expect(submitKeyStatuslineSymbol("alt+enter", false)).toBe("A-⏎");
	});

	it("非 macOS でも cmd+enter は macOS の記号にフォールバックする（選択肢には出ないが安全策）", () => {
		expect(submitKeyButtonLabel("cmd+enter", false)).toBe("⌘⏎");
		expect(submitKeyStatuslineSymbol("cmd+enter", false)).toBe("⌘⏎");
	});
});

describe("classifyCtrlKeyNonMac（§7.2.1 非macOS対応）", () => {
	it("Ctrl が無い・metaKey・altKey が立っていれば passthrough", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: false }))).toBe("passthrough");
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: true, metaKey: true }))).toBe("passthrough");
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: true, altKey: true }))).toBe("passthrough");
	});

	it("Ctrl+Shift+C／V はコピー・貼り付け", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: true, shiftKey: true }))).toBe("copy");
		expect(classifyCtrlKeyNonMac(key({ key: "C", ctrlKey: true, shiftKey: true }))).toBe("copy");
		expect(classifyCtrlKeyNonMac(key({ key: "v", ctrlKey: true, shiftKey: true }))).toBe("paste");
		expect(classifyCtrlKeyNonMac(key({ key: "V", ctrlKey: true, shiftKey: true }))).toBe("paste");
	});

	it("Ctrl+Shift+=／−／0 はフォントサイズ（Shift 込みの実際の key も見る）", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "=", ctrlKey: true, shiftKey: true }))).toBe("zoom-in");
		expect(classifyCtrlKeyNonMac(key({ key: "+", ctrlKey: true, shiftKey: true }))).toBe("zoom-in");
		expect(classifyCtrlKeyNonMac(key({ key: "-", ctrlKey: true, shiftKey: true }))).toBe("zoom-out");
		expect(classifyCtrlKeyNonMac(key({ key: "_", ctrlKey: true, shiftKey: true }))).toBe("zoom-out");
		expect(classifyCtrlKeyNonMac(key({ key: "0", ctrlKey: true, shiftKey: true }))).toBe("zoom-reset");
		expect(classifyCtrlKeyNonMac(key({ key: ")", ctrlKey: true, shiftKey: true }))).toBe("zoom-reset");
	});

	it("Ctrl+Shift+W／P はタブを閉じる・コマンドパレット（素の Ctrl+W／P と衝突しないよう別扱い）", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "w", ctrlKey: true, shiftKey: true }))).toBe("close-tab");
		expect(classifyCtrlKeyNonMac(key({ key: "W", ctrlKey: true, shiftKey: true }))).toBe("close-tab");
		expect(classifyCtrlKeyNonMac(key({ key: "p", ctrlKey: true, shiftKey: true }))).toBe("command-palette");
		expect(classifyCtrlKeyNonMac(key({ key: "P", ctrlKey: true, shiftKey: true }))).toBe("command-palette");
	});

	it("それ以外の Ctrl+Shift+<key> は Obsidian へ", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "x", ctrlKey: true, shiftKey: true }))).toBe("obsidian");
	});

	it("Ctrl+Tab・Ctrl+, は Obsidian へ", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "Tab", ctrlKey: true }))).toBe("obsidian");
		expect(classifyCtrlKeyNonMac(key({ key: ",", ctrlKey: true }))).toBe("obsidian");
	});

	it("claude が使う Ctrl+C／D／G／R／O／S／L／T・Ctrl+W／P（素の押下）はターミナルへ（既定）", () => {
		for (const k of ["c", "d", "g", "r", "o", "s", "l", "t", "w", "p"]) {
			expect(classifyCtrlKeyNonMac(key({ key: k, ctrlKey: true }))).toBe("terminal");
		}
	});
});
