import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import {
	FIVE_HOUR_SECONDS,
	SEVEN_DAY_SECONDS,
	formatCountdown,
	fromStatsWindow,
	isGroupStartRow,
	pickLatestLimits,
	realWindows,
	rollForwardWindow,
	type RawLimitsFile,
} from "../../src/views/limits";
import type { StatsWindow } from "../../src/types";

function statsWindow(overrides: Partial<StatsWindow> = {}): StatsWindow {
	return {
		start: 0,
		end: 100,
		used_percentage: null,
		total: { calls: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, cost: 0, unknown_cost: false },
		sessions: {},
		minutes: 300,
		label_key: "window.5h",
		...overrides,
	};
}

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

describe("fromStatsWindow (T-103/T-104: a json stats StatsWindow, e.g. agents.codex.windows, converted to the same shape as the file-based path)", () => {
	it("is null when the window itself is", () => {
		expect(fromStatsWindow(null)).toBeNull();
	});

	it("maps used_percentage as-is and end to resetsAt", () => {
		const w = statsWindow({ end: 12345, used_percentage: 42 });
		expect(fromStatsWindow(w)).toEqual({ usedPercentage: 42, resetsAt: 12345 });
	});

	it("carries a null used_percentage through as-is (a real case: some Codex accounts track no 5h/7d quota at all) rather than dropping the whole window", () => {
		const w = statsWindow({ end: 12345, used_percentage: null });
		expect(fromStatsWindow(w)).toEqual({ usedPercentage: null, resetsAt: 12345 });
	});
});

describe("realWindows (T-104 addendum, re-verified against the exact reported fixture)", () => {
	it("keeps only the real 30-day window when a free-plan Codex account tracks no 5h/7d quota at all", () => {
		// The exact scenario from the crossed-message re-check: an account with `five_hour` and
		// `seven_day` both present-but-unavailable (used_percentage: null), plus a real
		// window_43200m (30-day) entry — the side panel should show one row, not three, and not zero.
		const fiveHour = statsWindow({ minutes: 300, used_percentage: null });
		const sevenDay = statsWindow({ minutes: 10080, used_percentage: null });
		const thirtyDay = statsWindow({ minutes: 43200, used_percentage: 8, label_key: "window.30d" });
		const windows = { five_hour: fiveHour, seven_day: sevenDay, window_43200m: thirtyDay };
		expect(realWindows(windows)).toEqual([thirtyDay]);
	});

	it("keeps the usual 5h/7d pair when both are tracked (unchanged from before the addendum)", () => {
		const fiveHour = statsWindow({ minutes: 300, used_percentage: 10 });
		const sevenDay = statsWindow({ minutes: 10080, used_percentage: 20 });
		expect(realWindows({ five_hour: fiveHour, seven_day: sevenDay })).toEqual([fiveHour, sevenDay]);
	});

	it("keeps every real window when there are more than two (5h/7d plus an extra)", () => {
		const fiveHour = statsWindow({ minutes: 300, used_percentage: 10 });
		const sevenDay = statsWindow({ minutes: 10080, used_percentage: 20 });
		const thirtyDay = statsWindow({ minutes: 43200, used_percentage: 8 });
		const windows = { seven_day: sevenDay, window_43200m: thirtyDay, five_hour: fiveHour };
		expect(realWindows(windows)).toEqual([fiveHour, sevenDay, thirtyDay]);
	});

	it("is empty when nothing is tracked yet (both fixed windows null, no extra)", () => {
		const windows = { five_hour: statsWindow({ used_percentage: null }), seven_day: statsWindow({ used_percentage: null }) };
		expect(realWindows(windows)).toEqual([]);
	});

	it("is empty when windows itself is null (not fetched yet)", () => {
		expect(realWindows(null)).toEqual([]);
	});
});

describe("isGroupStartRow (T-111: which row gets the inter-agent-group spacing)", () => {
	it("is false for the first agent's rows, however many there are", () => {
		expect(isGroupStartRow(0, 0)).toBe(false);
		expect(isGroupStartRow(0, 1)).toBe(false);
		expect(isGroupStartRow(0, 2)).toBe(false);
	});

	it("is true only for the very first row of a second-or-later agent", () => {
		expect(isGroupStartRow(1, 0)).toBe(true);
		expect(isGroupStartRow(2, 0)).toBe(true);
	});

	it("is false for a later agent's later rows", () => {
		expect(isGroupStartRow(1, 1)).toBe(false);
		expect(isGroupStartRow(1, 2)).toBe(false);
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
