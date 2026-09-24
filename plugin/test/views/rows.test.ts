import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import { formatRelativeTime } from "../../src/views/rows";

describe("formatRelativeTime", () => {
	afterEach(() => setLang("en"));

	const now = 1_700_000_000;

	it("shows 'just now' under a minute", () => {
		expect(formatRelativeTime(now - 30, now)).toBe("just now");
		expect(formatRelativeTime(now, now)).toBe("just now");
	});

	it("shows 'N min ago' under an hour", () => {
		expect(formatRelativeTime(now - 60, now)).toBe("1 min ago");
		expect(formatRelativeTime(now - 59 * 60, now)).toBe("59 min ago");
	});

	it("shows 'N h ago' under a day", () => {
		expect(formatRelativeTime(now - 3600, now)).toBe("1 h ago");
		expect(formatRelativeTime(now - 23 * 3600, now)).toBe("23 h ago");
	});

	it("shows 'yesterday' under two days", () => {
		expect(formatRelativeTime(now - 86400, now)).toBe("yesterday");
		expect(formatRelativeTime(now - 2 * 86400 + 1, now)).toBe("yesterday");
	});

	it("shows 'N d ago' under a week", () => {
		expect(formatRelativeTime(now - 2 * 86400, now)).toBe("2 d ago");
		expect(formatRelativeTime(now - 6 * 86400, now)).toBe("6 d ago");
	});

	it("falls back to 'MM-DD' (no time of day) at a week or more", () => {
		const d = new Date((now - 7 * 86400) * 1000);
		const pad = (n: number) => String(n).padStart(2, "0");
		const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		expect(formatRelativeTime(now - 7 * 86400, now)).toBe(expected);
	});

	it("clamps a future timestamp to 'just now' rather than a negative duration", () => {
		expect(formatRelativeTime(now + 1000, now)).toBe("just now");
	});

	it("returns an empty string for a falsy epoch (no last_activity yet)", () => {
		expect(formatRelativeTime(0, now)).toBe("");
	});

	it("renders in Japanese when the language is ja", () => {
		setLang("ja");
		expect(formatRelativeTime(now - 30, now)).toBe("たった今");
		expect(formatRelativeTime(now - 5 * 60, now)).toBe("5 分前");
		expect(formatRelativeTime(now - 5 * 3600, now)).toBe("5 時間前");
		expect(formatRelativeTime(now - 86400, now)).toBe("昨日");
		expect(formatRelativeTime(now - 3 * 86400, now)).toBe("3 日前");
	});

	it("defaults `now` to the current time when omitted", () => {
		expect(formatRelativeTime(Date.now() / 1000)).toBe("just now");
	});
});
