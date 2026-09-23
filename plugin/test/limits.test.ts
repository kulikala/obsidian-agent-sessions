import { describe, expect, it } from "vitest";
import {
	FIVE_HOUR_SECONDS,
	SEVEN_DAY_SECONDS,
	formatCountdown,
	pickLatestLimits,
	rollForwardWindow,
	type RawLimitsFile,
} from "../src/views/limits";

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

describe("rollForwardWindow（T-74 追補）", () => {
	it("resetsAt が now より未来ならそのまま", () => {
		const w = { usedPercentage: 42, resetsAt: 2000 };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, 1000)).toEqual(w);
	});

	it("resetsAt がちょうど now でも先送りしない", () => {
		const w = { usedPercentage: 42, resetsAt: 1000 };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, 1000)).toEqual(w);
	});

	it("resetsAt が過去なら 1 期分先へ送り、usedPercentage は null にする", () => {
		const resetsAt = 1_700_000_000;
		const now = resetsAt + 60; // 1 分前にリセットを過ぎている
		const w = { usedPercentage: 88, resetsAt };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, now)).toEqual({
			usedPercentage: null,
			resetsAt: resetsAt + FIVE_HOUR_SECONDS,
		});
	});

	it("2 期分以上ずれていても必要な回数だけ先へ送る", () => {
		const resetsAt = 1_700_000_000;
		const now = resetsAt + 2 * SEVEN_DAY_SECONDS + 100;
		const w = { usedPercentage: 50, resetsAt };
		expect(rollForwardWindow(w, SEVEN_DAY_SECONDS, now)).toEqual({
			usedPercentage: null,
			resetsAt: resetsAt + 3 * SEVEN_DAY_SECONDS,
		});
	});

	it("resetsAt が無ければそのまま（先送りできない）", () => {
		const w = { usedPercentage: 10, resetsAt: null };
		expect(rollForwardWindow(w, FIVE_HOUR_SECONDS, 1_700_000_000)).toEqual(w);
	});

	it("w が null ならそのまま null", () => {
		expect(rollForwardWindow(null, FIVE_HOUR_SECONDS, 1_700_000_000)).toBeNull();
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

	it("24 時間以上は秒を落として「N 日 h:mm」にする（D-54）", () => {
		// 2 日と 3 時間 5 分 10 秒。
		expect(formatCountdown(2 * 86400 + 3 * 3600 + 5 * 60 + 10)).toBe("2 日 3:05");
	});
});
