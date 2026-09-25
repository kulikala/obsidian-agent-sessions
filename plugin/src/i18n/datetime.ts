// Locale-aware date/time formatting shared by every place in the plugin that shows an absolute
// date or time (T-115) — the side panel/manager row tooltip and the relative-time fallback
// (`views/rows.ts`), the turn table (`usage/usage.ts`), and the pace-judgment line
// (`views/manager-model.ts`). No dependency on `obsidian` (tested in test/i18n/datetime.test.ts).
//
// Countdown text ("5d 2:07") and the relative-time cascade ("3 h ago") stay hand-written i18n
// text rather than routing through here — `Intl.RelativeTimeFormat` doesn't reproduce either
// exactly (its abbreviated English units differ from this app's own, and `numeric: "auto"`
// introduces ja-only special-case words like "一昨日" for two days ago that this app doesn't use
// anywhere else), so switching would visibly change the output. See plan/reports/T-115.md.

import type { Lang } from "./index";

const LOCALE_TAG: Record<Lang, string> = { ja: "ja-JP", en: "en-US" };

// Every formatter below is built once per locale rather than on each call (same pattern as the
// weekday-only formatter this replaces) — with only two `Lang` values, a fixed per-locale table
// already is "cached, rebuilt when the language changes": a language switch just changes which
// entry `getLang()`'s caller reads, nothing here needs to be recomputed.

/** Date only, no year — e.g. ja "9/25", en "9/25". */
const DATE_SHORT_NO_YEAR: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat(LOCALE_TAG.ja, { month: "numeric", day: "numeric" }),
	en: new Intl.DateTimeFormat(LOCALE_TAG.en, { month: "numeric", day: "numeric" }),
};

/** Date only, locale-native short style (year included) — ja "2025/09/18", en "9/18/25". */
const DATE_SHORT_WITH_YEAR: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat(LOCALE_TAG.ja, { dateStyle: "short" }),
	en: new Intl.DateTimeFormat(LOCALE_TAG.en, { dateStyle: "short" }),
};

/** Date + time, no year — ja "9/25 14:05", en "9/25, 2:05 PM". */
const DATETIME_SHORT_NO_YEAR: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat(LOCALE_TAG.ja, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }),
	en: new Intl.DateTimeFormat(LOCALE_TAG.en, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }),
};

/** Date + time, locale-native short style (year included) — ja "2026/09/25 14:05", en "9/25/26, 2:05 PM". */
const DATETIME_SHORT_WITH_YEAR: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat(LOCALE_TAG.ja, { dateStyle: "short", timeStyle: "short" }),
	en: new Intl.DateTimeFormat(LOCALE_TAG.en, { dateStyle: "short", timeStyle: "short" }),
};

/** Weekday only — ja "土", en "Sat". */
const WEEKDAY_ONLY: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat(LOCALE_TAG.ja, { weekday: "short" }),
	en: new Intl.DateTimeFormat(LOCALE_TAG.en, { weekday: "short" }),
};

/** Time only, locale hour cycle (ja 24h, en 12h + AM/PM) — ja "21:11", en "9:11 PM". */
const TIME_SHORT: Record<Lang, Intl.DateTimeFormat> = {
	ja: new Intl.DateTimeFormat(LOCALE_TAG.ja, { hour: "numeric", minute: "2-digit" }),
	en: new Intl.DateTimeFormat(LOCALE_TAG.en, { hour: "numeric", minute: "2-digit" }),
};

function isCurrentYear(epochSeconds: number, now: number): boolean {
	return new Date(epochSeconds * 1000).getFullYear() === new Date(now * 1000).getFullYear();
}

/**
 * Date only, locale-short style, year omitted when `epochSeconds` falls in the same calendar
 * year as `now` (ja/en "9/25"); otherwise the locale's native short date (ja "2025/09/18", en
 * "9/18/25"). Replaces the old hand-written "MM-DD" fallback in `views/rows.ts`'s
 * `formatRelativeTime`. `now` defaults to the current time; pass it explicitly in tests.
 */
export function formatDateShort(epochSeconds: number, lang: Lang, now: number = Date.now() / 1000): string {
	const d = new Date(epochSeconds * 1000);
	const table = isCurrentYear(epochSeconds, now) ? DATE_SHORT_NO_YEAR : DATE_SHORT_WITH_YEAR;
	return table[lang].format(d);
}

/**
 * Date + time, locale-short style, year omitted the same way `formatDateShort` omits it — by
 * combining month/day/hour/minute directly rather than `dateStyle` (which has no "no year"
 * variant) — otherwise `dateStyle: "short"` + `timeStyle: "short"` (ja "2026/09/25 14:05", en
 * "9/25/26, 2:05 PM"). Replaces the old hand-written "MM-DD HH:MM" (`views/rows.ts`'s
 * `formatTime`, `usage/usage.ts`'s `formatEpoch`). `now` defaults to the current time; pass it
 * explicitly in tests.
 */
export function formatDateTimeShort(epochSeconds: number, lang: Lang, now: number = Date.now() / 1000): string {
	const d = new Date(epochSeconds * 1000);
	const table = isCurrentYear(epochSeconds, now) ? DATETIME_SHORT_NO_YEAR : DATETIME_SHORT_WITH_YEAR;
	return table[lang].format(d);
}

/**
 * "<weekday> <time>" (e.g. ja "土 21:11", en "Sat 9:11 PM") — the pace-judgment display
 * (`views/manager-model.ts`'s `formatWeekdayTime`). Weekday and time are formatted separately
 * and joined with a space rather than through one combined `Intl.DateTimeFormat` call, because
 * ja's own combined weekday+time order puts the weekday in parentheses after the time
 * ("21:11 (土)"), which doesn't match this app's weekday-first display in either language.
 */
export function formatWeekdayTimeShort(epochSeconds: number, lang: Lang): string {
	const d = new Date(epochSeconds * 1000);
	return `${WEEKDAY_ONLY[lang].format(d)} ${TIME_SHORT[lang].format(d)}`;
}
