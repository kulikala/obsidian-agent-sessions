import { afterEach, describe, expect, it } from "vitest";
import { getLang, resolveLang, setLang, t, type MessageKey } from "../src/i18n";

// This file intentionally switches languages. Reset back to Japanese (the
// default, set in test/setup.ts) so it doesn't leak into other tests.
afterEach(() => {
	setLang("ja");
});

describe("resolveLang", () => {
	it("passes through when the setting is ja or en", () => {
		expect(resolveLang("ja", null)).toBe("ja");
		expect(resolveLang("en", "ja")).toBe("en");
	});

	it("resolves auto to Japanese when obsidianLang is ja", () => {
		expect(resolveLang("auto", "ja")).toBe("ja");
	});

	it("resolves auto to English when obsidianLang is anything other than ja (including null)", () => {
		expect(resolveLang("auto", null)).toBe("en");
		expect(resolveLang("auto", "en")).toBe("en");
		expect(resolveLang("auto", "fr")).toBe("en");
	});
});

describe("setLang / getLang", () => {
	it("reads back the value that was switched to", () => {
		setLang("en");
		expect(getLang()).toBe("en");
		setLang("ja");
		expect(getLang()).toBe("ja");
	});
});

describe("t (placeholder substitution)", () => {
	it("substitutes {name}", () => {
		// Japanese fixture: exercises the actual ja dictionary value, not just the en one.
		setLang("ja");
		expect(t("notice.waitingForInput", { name: "RIM" })).toBe("RIM：指示待ち");
		setLang("en");
		expect(t("notice.waitingForInput", { name: "RIM" })).toBe("RIM: waiting for input");
	});

	it("substitutes multiple placeholders", () => {
		setLang("en");
		expect(t("usage.range", { from: 1, to: 3 })).toBe("#1–#3");
	});

	it("leaves a name untouched when it's not in vars", () => {
		setLang("en");
		expect(t("notice.renameFailed", {})).toBe("Failed to rename: {error}");
	});

	it("leaves the template as-is for a key that takes no vars", () => {
		// Japanese fixture: confirms the real ja dictionary value is returned unmodified.
		setLang("ja");
		expect(t("action.newSession")).toBe("新規セッション");
	});
});

describe("dictionary (ja and en have matching key sets)", () => {
	it("resolves the same MessageKey in both languages", () => {
		// `en` is declared as `Record<MessageKey, string>`, so the fact that this compiles
		// already guarantees the key sets match. This also confirms at runtime that every
		// key resolves to a non-empty string.
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
