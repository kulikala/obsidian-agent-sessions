import { describe, expect, it } from "vitest";
import { isCloseTabKey } from "../../src/terminal/keys";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
	key: k,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...mods,
});

describe("isCloseTabKey", () => {
	it("is Cmd+W on macOS", () => {
		expect(isCloseTabKey(key("w", { metaKey: true }), true)).toBe(true);
		expect(isCloseTabKey(key("W", { metaKey: true }), true)).toBe(true);
		expect(isCloseTabKey(key("w", { ctrlKey: true }), true)).toBe(false);
	});

	it("is Ctrl+W elsewhere", () => {
		expect(isCloseTabKey(key("w", { ctrlKey: true }), false)).toBe(true);
		expect(isCloseTabKey(key("w", { metaKey: true }), false)).toBe(false);
	});

	it("ignores other modifiers and keys", () => {
		expect(isCloseTabKey(key("w", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
		expect(isCloseTabKey(key("w", { metaKey: true, altKey: true }), true)).toBe(false);
		expect(isCloseTabKey(key("q", { metaKey: true }), true)).toBe(false);
		expect(isCloseTabKey(key("w"), true)).toBe(false);
	});
});
