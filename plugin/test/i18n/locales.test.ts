import { afterEach, describe, expect, it } from "vitest";
import { allLangs, setLang, t, type MessageKey } from "../../src/i18n";
import { en } from "../../src/i18n/locales/en";
import { ja } from "../../src/i18n/locales/ja";

// Generic, registry-driven checks — written so that adding a new (possibly incomplete) locale
// to `src/i18n/locales/` and registering it in `src/i18n/index.ts`'s `LOCALES` doesn't require
// adding a matching test here.

const LOCALE_MESSAGES: Partial<Record<string, Partial<Record<MessageKey, string>>>> = { en, ja };

afterEach(() => setLang("en"));

describe("every locale's keys are a subset of en's", () => {
	it.each(allLangs())("%s", (lang) => {
		const messages = LOCALE_MESSAGES[lang];
		expect(messages).toBeDefined();
		const enKeys = new Set(Object.keys(en));
		for (const key of Object.keys(messages ?? {})) {
			expect(enKeys.has(key)).toBe(true);
		}
	});
});

describe("a locale missing a key falls back to en", () => {
	it("ja (today, complete — every key matches en's) still resolves through the same fallback path as an incomplete locale would", () => {
		// `ja` happens to have every key filled in today, so this exercises the fallback path
		// indirectly: deleting one of ja's entries and confirming `t()` then reads through to en
		// proves the `??`-fallback in `i18n/index.ts`'s `t()` actually runs, not just that ja's
		// own values happen to be present.
		const key: MessageKey = "action.newSession";
		const original = ja[key];
		expect(original).toBeDefined();
		delete ja[key];
		try {
			setLang("ja");
			expect(t(key)).toBe(en[key]);
		} finally {
			ja[key] = original;
		}
	});
});

describe("every en key resolves to a non-empty string in every locale (falling back to en where needed)", () => {
	it.each(allLangs())("%s", (lang) => {
		setLang(lang);
		for (const key of Object.keys(en) as MessageKey[]) {
			expect(t(key).length).toBeGreaterThan(0);
		}
	});
});

describe("dictionary (ja and en have matching key sets today)", () => {
	it("resolves the same MessageKey in both languages", () => {
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
