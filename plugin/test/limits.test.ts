import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../src/i18n";
import {
	FIVE_HOUR_SECONDS,
	SEVEN_DAY_SECONDS,
	formatCountdown,
	pickLatestLimits,
	rollForwardWindow,
	type RawLimitsFile,
} from "../src/views/limits";

describe("pickLatestLimits", () => {
	it("takes five_hour and seven_day from the file with the latest mtime that has rate_limits", () => {
		const files: RawLimitsFile[] = [
			{ mtimeMs: 100, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1000 } } },
			{
				mtimeMs: 300,
				rate_limits: {
					five_hour: { used_percentage: 39, resets_at: 2000 },
					seven_day: { used_percentage: 7, resets_at: 3000 },
				},
			},
			{ mtimeMs: 200, rate_limits: { five_hour: { used_percentage: 20, resets_at: 1500 } } },
		];
		expect(pickLatestLimits(files)).toEqual({
			fiveHour: { usedPercentage: 39, resetsAt: 2000 },
			sevenDay: { usedPercentage: 7, resetsAt: 3000 },
		});
	});

	it("ignores files without rate_limits", () => {
		const files: RawLimitsFile[] = [
			{ mtimeMs: 500 },
			{ mtimeMs: 100, rate_limits: { five_hour: { used_percentage: 5, resets_at: 10 } } },
		];
		expect(pickLatestLimits(files)).toEqual({
			fiveHour: { usedPercentage: 5, resetsAt: 10 },
			sevenDay: null,
		});
	});

	it("is null when resets_at is missing", () => {
		const files: RawLimitsFile[] = [{ mtimeMs: 1, rate_limits: { five_hour: { used_percentage: 5 } } }];
		expect(pickLatestLimits(files)).toEqual({
			fiveHour: { usedPercentage: 5, resetsAt: null },
			sevenDay: null,
		});
	});

	it("is null when there is no matching file", () => {
		expect(pickLatestLimits([])).toBeNull();
		expect(pickLatestLimits([{ mtimeMs: 1 }])).toBeNull();
	});
});

describe("rollForwardWindow", () => {
	it("leaves the window unchanged when resetsAt is still in the future relative to now", () => {
		const w = { usedPercentage: 42, resetsAt: 2000 };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, 1000)).toEqual(w);
	});

	it("does not roll forward when resetsAt equals now exactly", () => {
		const w = { usedPercentage: 42, resetsAt: 1000 };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, 1000)).toEqual(w);
	});

	it("rolls forward by one period and nulls out usedPercentage when resetsAt is in the past", () => {
		const resetsAt = 1_700_000_000;
		const now = resetsAt + 60; // the reset time passed one minute ago
		const w = { usedPercentage: 88, resetsAt };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, now)).toEqual({
			usedPercentage: null,
			resetsAt: resetsAt + FIVE_HOUR_SECONDS,
		});
	});

	it("rolls forward as many periods as needed when more than one period has elapsed", () => {
		const resetsAt = 1_700_000_000;
		const now = resetsAt + 2 * SEVEN_DAY_SECONDS + 100;
		const w = { usedPercentage: 50, resetsAt };
		expect(rollForwardWindow(w, SEVEN_DAY_SECONDS, now)).toEqual({
			usedPercentage: null,
			resetsAt: resetsAt + 3 * SEVEN_DAY_SECONDS,
		});
	});

	it("leaves the window unchanged when resetsAt is missing (nothing to roll forward)", () => {
		const w = { usedPercentage: 10, resetsAt: null };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, 1_700_000_000)).toEqual(w);
	});

	it("stays null when the window itself is null", () => {
		expect(rollForwardWindow(null, FIVE_HOUR_SECONDS, 1_700_000_000)).toBeNull();
	});
});

describe("formatCountdown", () => {
	afterEach(() => setLang("en"));

	it("formats as h:mm:ss", () => {
		expect(formatCountdown(3725)).toBe("1:02:05");
	});

	it("uses a single 0 digit for the hour when under an hour", () => {
		expect(formatCountdown(65)).toBe("0:01:05");
	});

	it("clamps negative values to 0", () => {
		expect(formatCountdown(-10)).toBe("0:00:00");
	});

	it("rounds fractional seconds", () => {
		expect(formatCountdown(59.6)).toBe("0:01:00");
	});

	it("drops the seconds and formats as 'N 日 h:mm' (ja) / 'Nd h:mm' (en) at 24 hours or more", () => {
		// 2 days, 3 hours, 5 minutes, 10 seconds. Goes through t("limits.countdownDays"), so pin the language for each assertion.
		const seconds = 2 * 86400 + 3 * 3600 + 5 * 60 + 10;
		setLang("ja");
		expect(formatCountdown(seconds)).toBe("2 日 3:05");
		setLang("en");
		expect(formatCountdown(seconds)).toBe("2d 3:05");
	});
});
