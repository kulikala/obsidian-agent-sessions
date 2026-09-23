import { afterEach, describe, expect, it } from "vitest";
import { getLang, resolveLang, setLang, t, type MessageKey } from "../src/i18n";

// このファイルは意図的に言語を切り替える。他のテストへ漏れないよう、日本語（既定。test/setup.ts）に戻す。
afterEach(() => {
	setLang("ja");
});

describe("resolveLang（D-56）", () => {
	it("設定が ja／en ならそのまま", () => {
		expect(resolveLang("ja", null)).toBe("ja");
		expect(resolveLang("en", "ja")).toBe("en");
	});

	it("auto は obsidianLang が ja なら日本語", () => {
		expect(resolveLang("auto", "ja")).toBe("ja");
	});

	it("auto は obsidianLang が ja 以外（null を含む）なら英語", () => {
		expect(resolveLang("auto", null)).toBe("en");
		expect(resolveLang("auto", "en")).toBe("en");
		expect(resolveLang("auto", "fr")).toBe("en");
	});
});

describe("setLang／getLang", () => {
	it("切り替えた値を読める", () => {
		setLang("en");
		expect(getLang()).toBe("en");
		setLang("ja");
		expect(getLang()).toBe("ja");
	});
});

describe("t（プレースホルダの置換）", () => {
	it("{name} を置換する", () => {
		setLang("ja");
		expect(t("notice.waitingForInput", { name: "RIM" })).toBe("RIM：指示待ち");
		setLang("en");
		expect(t("notice.waitingForInput", { name: "RIM" })).toBe("RIM: waiting for input");
	});

	it("複数のプレースホルダを置換する", () => {
		setLang("en");
		expect(t("usage.range", { from: 1, to: 3 })).toBe("#1–#3");
	});

	it("vars に無い名前はそのまま残す", () => {
		setLang("en");
		expect(t("notice.renameFailed", {})).toBe("Failed to rename: {error}");
	});

	it("vars を渡さないキーはテンプレートのまま", () => {
		setLang("ja");
		expect(t("action.newSession")).toBe("新規セッション");
	});
});

describe("辞書（ja・en のキー集合が一致すること）", () => {
	it("同じ MessageKey で両方引ける", () => {
		// `en` は `Record<MessageKey, string>` で宣言してあるので、コンパイルが通ること自体が
		// キー集合の一致を保証する。ここでは実行時にも全キーが空文字列でないことを確かめる。
		const sampleKeys: MessageKey[] = [
			"action.newSession",
			"common.untitled",
			"error.claudeMissing",
			"usage.md.title",
			"settings.language.name",
		];
		for (const key of sampleKeys) {
			setLang("ja");
			expect(t(key).length).toBeGreaterThan(0);
			setLang("en");
			expect(t(key).length).toBeGreaterThan(0);
		}
	});
});
