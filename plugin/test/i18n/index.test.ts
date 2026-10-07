import { afterEach, describe, expect, it } from "vitest";
import { allLangs, getLang, languageOptions, resolveLang, setLang, t, type MessageKey } from "../../src/i18n";
import { en } from "../../src/i18n/locales/en";

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

describe("t (plural forms)", () => {
	it("chooses the singular form for 1 and the plural otherwise", () => {
		setLang("en");
		expect(t("organize.logRead", { count: 1 })).toBe("Read 1 session");
		expect(t("organize.logRead", { count: 0 })).toBe("Read 0 sessions");
		expect(t("organize.logRead", { count: 5 })).toBe("Read 5 sessions");
	});

	it("reads the count from a formatted string", () => {
		setLang("en");
		expect(t("efficiency.range.sessions", { count: "1" })).toBe("1 session");
		expect(t("efficiency.range.sessions", { count: "1,234" })).toBe("1,234 sessions");
	});

	it("agrees the verb and handles several counts in one string", () => {
		setLang("en");
		expect(t("usage.md.unpricedSuffix", { count: "1" })).toBe(" (excluding 1 reply without a price)");
		expect(t("usage.md.unpricedSuffix", { count: "3" })).toBe(" (excluding 3 replies without a price)");
		expect(t("cost.unpriced.some", { count: "1", calls: "5" })).toMatch(/^1 of 5 replies has no price/);
		expect(t("cost.unpriced.some", { count: "2", calls: "5" })).toMatch(/^2 of 5 replies have no price/);
		expect(t("efficiency.detector.E16.cause", { corrections: 1, calls: 1, ratio: "2.0" })).toBe(
			"This task had 1 rework turn and 1 call, about 2.0 times your usual per turn."
		);
	});

	it("leaves the form untouched when the name is missing or isn't a count", () => {
		setLang("en");
		expect(t("organize.logRead", {})).toBe("Read {count} {count|session|sessions}");
		expect(t("organize.logRead", { count: "many" })).toBe("Read many sessions");
	});

	it("doesn't affect Japanese, which has no plural forms", () => {
		setLang("ja");
		expect(t("organize.logRead", { count: 1 })).not.toMatch(/\{\w+\|/);
	});

	it("keeps every word form well-formed in every locale", () => {
		for (const lang of allLangs()) {
			setLang(lang);
			for (const key of Object.keys(en) as MessageKey[]) {
				const out = t(key, new Proxy({}, { has: () => true, get: () => 1 }) as Record<string, number>);
				expect(out).not.toMatch(/\{\w+\|/);
			}
		}
	});
});
