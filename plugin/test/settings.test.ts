import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultFontFamily, mergeSettings, SUBMIT_KEYS_NON_MAC } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
	it("has the expected default values", () => {
		expect(DEFAULT_SETTINGS).toEqual({
			fontFamily: 'Menlo, "Hiragino Sans", monospace',
			fontSize: 13,
			padding: "comfortable",
			recentCount: 10,
			notifyOnIdle: true,
			claudePath: "",
			agentSessionsPath: "",
			scrollback: 5000,
			editorHeight: 40,
			submitKey: "enter",
			sideDetailHeight: 220,
			language: "auto",
			managerAnalysisHeight: 240,
			managerAnalysisCollapsed: false,
		});
	});
});

describe("mergeSettings", () => {
	it("drops the removed newlineKey and an old submitKey value no longer in the current type", () => {
		const merged = mergeSettings({ newlineKey: "enter", submitKey: "super+enter", fontSize: 15 });
		expect(merged).not.toHaveProperty("newlineKey");
		expect(merged.submitKey).toBe("enter");
		expect(merged.fontSize).toBe(15);
	});

	it("keeps a submitKey value that's in the current type", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }).submitKey).toBe("cmd+enter");
	});

	it("falls back to defaults when there's no saved data", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
});

describe("mergeSettings (non-macOS support)", () => {
	it("uses the non-macOS default font on a fresh non-macOS install (no saved data)", () => {
		expect(mergeSettings(null, false).fontFamily).toBe(defaultFontFamily(false));
	});

	it("does not change fontFamily on non-macOS when one is already saved (keeps the value saved on macOS)", () => {
		const merged = mergeSettings({ fontFamily: 'Menlo, "Hiragino Sans", monospace' }, false);
		expect(merged.fontFamily).toBe('Menlo, "Hiragino Sans", monospace');
	});

	it("drops cmd+enter on non-macOS and falls back to the default (enter)", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }, false).submitKey).toBe("enter");
	});

	it("keeps cmd+enter on macOS (the default call)", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }).submitKey).toBe("cmd+enter");
	});
});

describe("defaultFontFamily (non-macOS support; Menlo isn't available on Linux)", () => {
	it("is Menlo on macOS", () => {
		expect(defaultFontFamily(true)).toBe('Menlo, "Hiragino Sans", monospace');
	});

	it("is a font with matching CJK widths on non-macOS", () => {
		expect(defaultFontFamily(false)).toBe('"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace');
	});
});

describe("SUBMIT_KEYS_NON_MAC", () => {
	it("does not include cmd+enter", () => {
		expect(SUBMIT_KEYS_NON_MAC).toEqual(["enter", "shift+enter", "ctrl+enter", "alt+enter"]);
	});
});
