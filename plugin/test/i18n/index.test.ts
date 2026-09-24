import { afterEach, describe, expect, it } from "vitest";
import { allLangs, getLang, languageOptions, resolveLang, setLang, t } from "../../src/i18n";

// This file intentionally switches languages. Reset back to English (the
// default, set in test/setup.ts) so it doesn't leak into other tests.
afterEach(() => {
	setLang("en");
});

describe("resolveLang", () => {
	it("passes through when the setting is a specific language", () => {
		expect(resolveLang("ja", null)).toBe("ja");
		expect(resolveLang("en", "ja")).toBe("en");
	});

	it("resolves auto to Japanese when obsidianLang is ja", () => {
		expect(resolveLang("auto", "ja")).toBe("ja");
	});

	it("resolves auto by prefix-matching a longer Obsidian language string (e.g. ja-JP)", () => {
		expect(resolveLang("auto", "ja-JP")).toBe("ja");
	});

	it("resolves auto to English when obsidianLang is anything other than a registered locale's prefix (including null)", () => {
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

describe("allLangs / languageOptions", () => {
	it("lists every registered locale's code", () => {
		expect(allLangs()).toEqual(["en", "ja"]);
	});

	it("shows each locale's own autonym, regardless of the current display language", () => {
		setLang("ja");
		const options = languageOptions();
		expect(options.en).toBe("English");
		expect(options.ja).toBe("日本語");
		// "auto" isn't a language of its own, so it's translated like any other UI string.
		expect(options.auto).toBe("自動");

		setLang("en");
		// The autonyms don't change when the display language does...
		expect(languageOptions().en).toBe("English");
		expect(languageOptions().ja).toBe("日本語");
		// ...but "auto"'s label does.
		expect(languageOptions().auto).toBe("Auto");
	});
});
