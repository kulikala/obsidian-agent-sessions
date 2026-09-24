import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultFontFamily, mergeSettings, SUBMIT_KEYS_NON_MAC } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
	it("§6.9 の既定値を持つ", () => {
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

describe("mergeSettings（D-50）", () => {
	it("廃止した newlineKey と、今の型に無い旧 submitKey は捨てる", () => {
		const merged = mergeSettings({ newlineKey: "enter", submitKey: "super+enter", fontSize: 15 });
		expect(merged).not.toHaveProperty("newlineKey");
		expect(merged.submitKey).toBe("enter");
		expect(merged.fontSize).toBe(15);
	});

	it("今の型の submitKey は保つ", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }).submitKey).toBe("cmd+enter");
	});

	it("保存データが無ければ既定値", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});
});

describe("mergeSettings（非macOS対応）", () => {
	it("非 macOS の新規インストール（保存データ無し）は非 macOS の既定フォント", () => {
		expect(mergeSettings(null, false).fontFamily).toBe(defaultFontFamily(false));
	});

	it("非 macOS でも fontFamily が既に保存されていれば変えない（macOS で保存した値のまま）", () => {
		const merged = mergeSettings({ fontFamily: 'Menlo, "Hiragino Sans", monospace' }, false);
		expect(merged.fontFamily).toBe('Menlo, "Hiragino Sans", monospace');
	});

	it("非 macOS では cmd+enter を捨てて既定（enter）に戻す", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }, false).submitKey).toBe("enter");
	});

	it("macOS（既定の呼び出し）では cmd+enter を保つ", () => {
		expect(mergeSettings({ submitKey: "cmd+enter" }).submitKey).toBe("cmd+enter");
	});
});

describe("defaultFontFamily（非macOS対応。Menlo は Linux に無い）", () => {
	it("macOS は Menlo", () => {
		expect(defaultFontFamily(true)).toBe('Menlo, "Hiragino Sans", monospace');
	});

	it("非 macOS は CJK 幅の揃うフォント", () => {
		expect(defaultFontFamily(false)).toBe('"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace');
	});
});

describe("SUBMIT_KEYS_NON_MAC", () => {
	it("cmd+enter を含まない", () => {
		expect(SUBMIT_KEYS_NON_MAC).toEqual(["enter", "shift+enter", "ctrl+enter", "alt+enter"]);
	});
});
