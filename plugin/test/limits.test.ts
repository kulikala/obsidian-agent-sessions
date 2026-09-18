import { describe, expect, it } from "vitest";
import { formatCountdown, pickLatestLimits, type RawLimitsFile } from "../src/views/limits";

describe("pickLatestLimits（D-43）", () => {
	it("rate_limits を持つ最新 mtime のファイルから five_hour・seven_day を取る", () => {
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

	it("rate_limits の無いファイルは無視する", () => {
		const files: RawLimitsFile[] = [
			{ mtimeMs: 500 },
			{ mtimeMs: 100, rate_limits: { five_hour: { used_percentage: 5, resets_at: 10 } } },
		];
		expect(pickLatestLimits(files)).toEqual({
			fiveHour: { usedPercentage: 5, resetsAt: 10 },
			sevenDay: null,
		});
	});

	it("resets_at が無ければ null", () => {
		const files: RawLimitsFile[] = [{ mtimeMs: 1, rate_limits: { five_hour: { used_percentage: 5 } } }];
		expect(pickLatestLimits(files)).toEqual({
			fiveHour: { usedPercentage: 5, resetsAt: null },
			sevenDay: null,
		});
	});

	it("該当ファイルが無ければ null", () => {
		expect(pickLatestLimits([])).toBeNull();
		expect(pickLatestLimits([{ mtimeMs: 1 }])).toBeNull();
	});
});

describe("formatCountdown（D-43）", () => {
	it("h:mm:ss にする", () => {
		expect(formatCountdown(3725)).toBe("1:02:05");
	});

	it("1 時間未満は 0 時間台", () => {
		expect(formatCountdown(65)).toBe("0:01:05");
	});

	it("負数は 0 に丸める", () => {
		expect(formatCountdown(-10)).toBe("0:00:00");
	});

	it("端数は丸める", () => {
		expect(formatCountdown(59.6)).toBe("0:01:00");
	});
});
