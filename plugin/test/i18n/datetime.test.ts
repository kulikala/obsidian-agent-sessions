import { describe, expect, it } from "vitest";
import { formatDateShort, formatDateTimeShort, formatWeekdayTimeShort } from "../../src/i18n/datetime";

// All fixtures are built with local-time `Date` constructors (matching the app's own use of
// `new Date(epochSeconds * 1000)`), then converted to epoch seconds, so results don't depend on
// the machine's timezone the way a hardcoded UTC epoch would.
function epoch(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): number {
	return Math.floor(new Date(year, month, day, hours, minutes, seconds).getTime() / 1000);
}

describe("formatDateShort", () => {
	const now = epoch(2026, 5, 1); // 2026-06-01, used as "today" throughout

	it("omits the year when the date is in the same year as `now` (ja and en render identically)", () => {
		const ts = epoch(2026, 8, 25); // 2026-09-25
		expect(formatDateShort(ts, "en", now)).toBe("9/25");
		expect(formatDateShort(ts, "ja", now)).toBe("9/25");
	});

	it("includes the year, locale short-date style, when the date is a different year than `now`", () => {
		const ts = epoch(2025, 8, 18); // 2025-09-18
		expect(formatDateShort(ts, "en", now)).toBe("9/18/25");
		expect(formatDateShort(ts, "ja", now)).toBe("2025/09/18");
	});

	it("defaults `now` to the current time when omitted", () => {
		const ts = Math.floor(Date.now() / 1000);
		expect(formatDateShort(ts, "en")).toBe(formatDateShort(ts, "en", ts));
	});
});

describe("formatDateTimeShort", () => {
	const now = epoch(2026, 5, 1); // 2026-06-01, used as "today" throughout

	it("omits the year when in the current year, using each locale's own hour cycle (en 12h, ja 24h)", () => {
		const ts = epoch(2026, 8, 25, 14, 5, 0); // 2026-09-25 14:05
		expect(formatDateTimeShort(ts, "en", now)).toBe("9/25, 2:05 PM");
		expect(formatDateTimeShort(ts, "ja", now)).toBe("9/25 14:05");
	});

	it("includes the year, locale short style, when the date is a different year than `now`", () => {
		const ts = epoch(2025, 8, 18, 14, 5, 0); // 2025-09-18 14:05
		expect(formatDateTimeShort(ts, "en", now)).toBe("9/18/25, 2:05 PM");
		expect(formatDateTimeShort(ts, "ja", now)).toBe("2025/09/18 14:05");
	});

	it("renders a morning hour with AM in English and unaffected in Japanese", () => {
		const ts = epoch(2026, 8, 25, 9, 11, 0); // 2026-09-25 09:11
		expect(formatDateTimeShort(ts, "en", now)).toBe("9/25, 9:11 AM");
		expect(formatDateTimeShort(ts, "ja", now)).toBe("9/25 9:11");
	});

	it("defaults `now` to the current time when omitted", () => {
		const ts = Math.floor(Date.now() / 1000);
		expect(formatDateTimeShort(ts, "en")).toBe(formatDateTimeShort(ts, "en", ts));
	});
});

describe("formatWeekdayTimeShort", () => {
	it("formats '<weekday> <time>' with each locale's own hour cycle (ja 24h, en 12h + AM/PM)", () => {
		const ts = epoch(2026, 8, 26, 21, 11, 0); // 2026-09-26 is a Saturday, 21:11
		expect(formatWeekdayTimeShort(ts, "ja")).toBe("土 21:11");
		expect(formatWeekdayTimeShort(ts, "en")).toBe("Sat 9:11 PM");
	});

	it("doesn't zero-pad a single-digit hour in Japanese (matches its own locale convention)", () => {
		const ts = epoch(2026, 8, 26, 9, 11, 0); // same Saturday, 09:11
		expect(formatWeekdayTimeShort(ts, "ja")).toBe("土 9:11");
		expect(formatWeekdayTimeShort(ts, "en")).toBe("Sat 9:11 AM");
	});
});
