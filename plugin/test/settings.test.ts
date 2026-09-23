import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";

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
			pythonPath: "",
			scrollback: 5000,
			editorHeight: 40,
			submitKey: "enter",
			sideDetailHeight: 220,
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
