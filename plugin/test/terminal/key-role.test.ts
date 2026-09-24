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
} from "../../src/terminal/keys";
import { SUBMIT_KEYS, type SubmitKey } from "../../src/settings";

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

/** Five keypresses, named the same as the submit keys they correspond to. */
const PRESSES: Record<SubmitKey, KeyLike> = {
	enter: key(),
	"shift+enter": key({ shiftKey: true }),
	"ctrl+enter": key({ ctrlKey: true }),
	"alt+enter": key({ altKey: true }),
	"cmd+enter": key({ metaKey: true }),
};

describe("classifyEnter", () => {
	it("anything other than Enter is passthrough", () => {
		expect(classifyEnter(key({ key: "a" }))).toBe("passthrough");
		expect(classifyEnter(key({ key: "a", metaKey: true }))).toBe("passthrough");
	});

	it("Enter during IME composition (isComposing) is passthrough", () => {
		expect(classifyEnter(key({ isComposing: true }))).toBe("passthrough");
		expect(classifyEnter(key({ isComposing: true, metaKey: true }))).toBe("passthrough");
	});

	it("Enter with keyCode 229 is passthrough", () => {
		expect(classifyEnter(key({ keyCode: 229 }))).toBe("passthrough");
	});

	it("classifies each of the five keypresses to its own name", () => {
		for (const name of SUBMIT_KEYS) {
			expect(classifyEnter(PRESSES[name])).toBe(name);
		}
	});

	it("with multiple modifiers, priority is shift → ctrl → alt → cmd", () => {
		expect(classifyEnter(key({ shiftKey: true, altKey: true }))).toBe("shift+enter");
		expect(classifyEnter(key({ ctrlKey: true, altKey: true }))).toBe("ctrl+enter");
		expect(classifyEnter(key({ altKey: true, metaKey: true }))).toBe("alt+enter");
	});
});

describe("resolveEnterAction × sendSequence (5 submit keys × 5 keypresses)", () => {
	for (const submitKey of SUBMIT_KEYS) {
		for (const press of SUBMIT_KEYS) {
			const expected = press === submitKey ? "submit" : "newline";
			const seq =
				submitKey === "enter" ? (expected === "submit" ? "\r" : "\x1b\r") : expected === "submit" ? "\x1b\r" : "\r";
			it(`submit key ${submitKey}, press ${press} → ${expected} (${JSON.stringify(seq)})`, () => {
				const action = resolveEnterAction(classifyEnter(PRESSES[press]), submitKey);
				expect(action).toBe(expected);
				expect(sendSequence(action as "submit" | "newline", submitKey)).toBe(seq);
			});
		}
	}

	it("during IME composition, or for anything other than Enter, every submit key is passthrough", () => {
		for (const submitKey of SUBMIT_KEYS) {
			expect(resolveEnterAction(classifyEnter(key({ isComposing: true })), submitKey)).toBe("passthrough");
			expect(resolveEnterAction(classifyEnter(key({ keyCode: 229, metaKey: true })), submitKey)).toBe("passthrough");
			expect(resolveEnterAction(classifyEnter(key({ key: "a" })), submitKey)).toBe("passthrough");
		}
	});
});

describe("SUBMIT_KEY_SYMBOLS", () => {
	it("the symbol shown for \"send\"", () => {
		expect(SUBMIT_KEY_SYMBOLS).toEqual({
			enter: "⏎",
			"shift+enter": "⇧⏎",
			"ctrl+enter": "⌃⏎",
			"alt+enter": "⌥⏎",
			"cmd+enter": "⌘⏎",
		});
	});
});

describe("submitKeyButtonLabel / submitKeyStatuslineSymbol (non-macOS support)", () => {
	it("on macOS, stays as SUBMIT_KEY_SYMBOLS", () => {
		for (const k of SUBMIT_KEYS) {
			expect(submitKeyButtonLabel(k, true)).toBe(SUBMIT_KEY_SYMBOLS[k]);
			expect(submitKeyStatuslineSymbol(k, true)).toBe(SUBMIT_KEY_SYMBOLS[k]);
		}
	});

	it("on non-macOS, the \"send\" button shows a spelled-out label", () => {
		expect(submitKeyButtonLabel("enter", false)).toBe("Enter");
		expect(submitKeyButtonLabel("shift+enter", false)).toBe("Shift+Enter");
		expect(submitKeyButtonLabel("ctrl+enter", false)).toBe("Ctrl+Enter");
		expect(submitKeyButtonLabel("alt+enter", false)).toBe("Alt+Enter");
	});

	it("on non-macOS, the statusLine shows a short spelled-out label", () => {
		expect(submitKeyStatuslineSymbol("enter", false)).toBe("⏎");
		expect(submitKeyStatuslineSymbol("shift+enter", false)).toBe("S-⏎");
		expect(submitKeyStatuslineSymbol("ctrl+enter", false)).toBe("C-⏎");
		expect(submitKeyStatuslineSymbol("alt+enter", false)).toBe("A-⏎");
	});

	it("even on non-macOS, cmd+enter falls back to the macOS symbol (not offered as a choice, but a safety net)", () => {
		expect(submitKeyButtonLabel("cmd+enter", false)).toBe("⌘⏎");
		expect(submitKeyStatuslineSymbol("cmd+enter", false)).toBe("⌘⏎");
	});
});

describe("classifyCtrlKeyNonMac (non-macOS Ctrl-key shortcuts)", () => {
	it("passthrough when Ctrl is absent, or metaKey/altKey is set", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: false }))).toBe("passthrough");
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: true, metaKey: true }))).toBe("passthrough");
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: true, altKey: true }))).toBe("passthrough");
	});

	it("Ctrl+Shift+C/V are copy/paste", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "c", ctrlKey: true, shiftKey: true }))).toBe("copy");
		expect(classifyCtrlKeyNonMac(key({ key: "C", ctrlKey: true, shiftKey: true }))).toBe("copy");
		expect(classifyCtrlKeyNonMac(key({ key: "v", ctrlKey: true, shiftKey: true }))).toBe("paste");
		expect(classifyCtrlKeyNonMac(key({ key: "V", ctrlKey: true, shiftKey: true }))).toBe("paste");
	});

	it("Ctrl+Shift+=/-/0 are font size (also checks the actual key with Shift applied)", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "=", ctrlKey: true, shiftKey: true }))).toBe("zoom-in");
		expect(classifyCtrlKeyNonMac(key({ key: "+", ctrlKey: true, shiftKey: true }))).toBe("zoom-in");
		expect(classifyCtrlKeyNonMac(key({ key: "-", ctrlKey: true, shiftKey: true }))).toBe("zoom-out");
		expect(classifyCtrlKeyNonMac(key({ key: "_", ctrlKey: true, shiftKey: true }))).toBe("zoom-out");
		expect(classifyCtrlKeyNonMac(key({ key: "0", ctrlKey: true, shiftKey: true }))).toBe("zoom-reset");
		expect(classifyCtrlKeyNonMac(key({ key: ")", ctrlKey: true, shiftKey: true }))).toBe("zoom-reset");
	});

	it("Ctrl+Shift+W/P are close-tab/command-palette (handled separately so they don't collide with plain Ctrl+W/P)", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "w", ctrlKey: true, shiftKey: true }))).toBe("close-tab");
		expect(classifyCtrlKeyNonMac(key({ key: "W", ctrlKey: true, shiftKey: true }))).toBe("close-tab");
		expect(classifyCtrlKeyNonMac(key({ key: "p", ctrlKey: true, shiftKey: true }))).toBe("command-palette");
		expect(classifyCtrlKeyNonMac(key({ key: "P", ctrlKey: true, shiftKey: true }))).toBe("command-palette");
	});

	it("any other Ctrl+Shift+<key> goes to Obsidian", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "x", ctrlKey: true, shiftKey: true }))).toBe("obsidian");
	});

	it("Ctrl+Tab and Ctrl+, go to Obsidian", () => {
		expect(classifyCtrlKeyNonMac(key({ key: "Tab", ctrlKey: true }))).toBe("obsidian");
		expect(classifyCtrlKeyNonMac(key({ key: ",", ctrlKey: true }))).toBe("obsidian");
	});

	it("plain Ctrl+C/D/G/R/O/S/L/T and Ctrl+W/P, which claude itself uses, go to the terminal (default)", () => {
		for (const k of ["c", "d", "g", "r", "o", "s", "l", "t", "w", "p"]) {
			expect(classifyCtrlKeyNonMac(key({ key: k, ctrlKey: true }))).toBe("terminal");
		}
	});
});
