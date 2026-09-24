// Display language. Doesn't depend on `obsidian` (same reason as `settings.ts`: importing
// only plain data and functions means tests that don't run inside Obsidian can still resolve
// it). Default is "auto" — when the setting's `language` is `auto`, it follows Obsidian's own
// language (`window.localStorage.getItem("language")`); anything not covered by a registered
// locale falls back to English. `t()` is a pure function that just reads the current value held
// in this module.
//
// To add a language: add `locales/<code>.ts` (see `locales/ja.ts` for the shape — a
// `Partial<Record<MessageKey, string>>` plus a `<CODE>_SELF_NAME` autonym, so a locale can start
// out incomplete and fill in one key at a time; a missing key falls back to English), then add
// one line to `LOCALES` below. `Lang` and the settings tab's language dropdown are both derived
// from `LOCALES`, so that's the only other place that needs to know.

import { en, EN_SELF_NAME, type MessageKey } from "./locales/en";
import { ja, JA_SELF_NAME } from "./locales/ja";

export type { MessageKey };

interface LocaleEntry {
	code: string;
	/** The language's own name for itself (an autonym) — shown in the language-setting dropdown
	 * regardless of the current display language, so it's always legible to a reader of that
	 * language even if they can't read the current one. */
	selfName: string;
	messages: Partial<Record<MessageKey, string>>;
}

// `as const` freezes each `code` to its literal type, which is what lets `Lang` below be derived
// from this table automatically instead of being maintained separately.
const LOCALES = [
	{ code: "en", selfName: EN_SELF_NAME, messages: en },
	{ code: "ja", selfName: JA_SELF_NAME, messages: ja },
] as const satisfies readonly LocaleEntry[];

export type Lang = (typeof LOCALES)[number]["code"];
export type LanguageSetting = "auto" | Lang;

const DEFAULT_LANG: Lang = "en";

const messagesByLang = new Map<Lang, Partial<Record<MessageKey, string>>>(LOCALES.map((l) => [l.code, l.messages]));

let currentLang: Lang = DEFAULT_LANG;

/** Switches the display language. Called from `main.ts`'s `onload` (first thing) and whenever the language setting changes. */
export function setLang(lang: Lang): void {
	currentLang = lang;
}

/** The current display language (read by tests, `views/limits.ts`'s pure functions, etc). */
export function getLang(): Lang {
	return currentLang;
}

/**
 * Derives the actual display language from the setting's `language` and Obsidian's own
 * language. `auto` matches Obsidian's language code against `LOCALES` by prefix (longest code
 * first, so a future more specific locale like "zh-TW" would win over a shorter "zh" that's also
 * a prefix match for the same Obsidian string) — `en` if nothing matches, including `null`.
 */
export function resolveLang(setting: LanguageSetting, obsidianLang: string | null): Lang {
	if (setting !== "auto") {
		return setting;
	}
	if (!obsidianLang) {
		return DEFAULT_LANG;
	}
	const matched = [...LOCALES].sort((a, b) => b.code.length - a.code.length).find((l) => obsidianLang.startsWith(l.code));
	return matched?.code ?? DEFAULT_LANG;
}

/**
 * Obsidian's language setting. `null` in environments without `window.localStorage`, or where
 * it can't be read (tests, etc). This is what gets passed to `resolveLang` (`resolveLang`
 * itself is a pure function that only looks at the values it's given).
 */
export function readObsidianLang(): string | null {
	try {
		return window.localStorage.getItem("language");
	} catch {
		return null;
	}
}

/** The string for `key`. If `vars` is given, replaces `{name}` placeholders (names not in `vars` are left as-is). */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	const template = messagesByLang.get(currentLang)?.[key] ?? en[key];
	if (!vars) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The settings tab's language dropdown: "Auto" (translated, since "auto" isn't itself a
 * language) plus each registered locale's autonym, in `LOCALES`' order. */
export function languageOptions(): Record<LanguageSetting, string> {
	const options = { auto: t("settings.language.optionAuto") } as Record<LanguageSetting, string>;
	for (const locale of LOCALES) {
		options[locale.code] = locale.selfName;
	}
	return options;
}

/** Every registered language code, in `LOCALES`' order (for tests that need to iterate all locales). */
export function allLangs(): readonly Lang[] {
	return LOCALES.map((l) => l.code);
}
