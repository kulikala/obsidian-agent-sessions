import { describe, expect, it } from "vitest";
import { classifyCtrlKeyNonMac } from "../../src/terminal/keys";

describe("classifyCtrlKeyNonMac on Windows", () => {
	const key = (k: string, shift = false) => ({ key: k, ctrlKey: true, shiftKey: shift, metaKey: false, altKey: false, isComposing: false });
	it("pastes on Ctrl+V and copies on Ctrl+C only with a selection", () => {
		expect(classifyCtrlKeyNonMac(key("v"), { windows: true })).toBe("paste");
		expect(classifyCtrlKeyNonMac(key("c"), { windows: true, hasSelection: true })).toBe("copy");
		expect(classifyCtrlKeyNonMac(key("c"), { windows: true, hasSelection: false })).toBe("terminal");
	});
	it("leaves Linux as it was", () => {
		expect(classifyCtrlKeyNonMac(key("v"))).toBe("terminal");
		expect(classifyCtrlKeyNonMac(key("c"), { hasSelection: true })).toBe("terminal");
		expect(classifyCtrlKeyNonMac(key("V", true))).toBe("paste");
	});
});
