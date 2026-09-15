import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatStatus, StatusLine } from "../src/statusline";

describe("StatusLine.get", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-status-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("ファイルが無ければ null", () => {
		const status = new StatusLine(dir);
		expect(status.get("missing")).toBeNull();
	});

	it("壊れた JSON は null", () => {
		writeFileSync(join(dir, "a.json"), "{not json", "utf8");
		const status = new StatusLine(dir);
		expect(status.get("a")).toBeNull();
	});

	it("statusLine の JSON をそのまま読む", () => {
		writeFileSync(
			join(dir, "a.json"),
			JSON.stringify({
				model: { display_name: "Opus 5" },
				context_window: { used_percentage: 42.4 },
				rate_limits: { five_hour: { used_percentage: 37 }, seven_day: { used_percentage: 12 } },
				effort: "high",
			}),
			"utf8"
		);
		const status = new StatusLine(dir);
		expect(status.get("a")).toEqual({
			model: "Opus 5",
			effort: "high",
			ctxPercent: 42.4,
			fiveHour: 37,
			sevenDay: 12,
		});
	});

	it("一部のキーが無ければ null で埋める", () => {
		writeFileSync(join(dir, "a.json"), JSON.stringify({ model: { display_name: "Sonnet 5" } }), "utf8");
		const status = new StatusLine(dir);
		expect(status.get("a")).toEqual({
			model: "Sonnet 5",
			effort: null,
			ctxPercent: null,
			fiveHour: null,
			sevenDay: null,
		});
	});
});

describe("formatStatus", () => {
	it("揃っているとき", () => {
		expect(
			formatStatus({ model: "Opus 5", effort: "high", ctxPercent: 42, fiveHour: 37, sevenDay: 12 }, true)
		).toBe("Opus 5 · high · ctx 42% · rc ● · 5h 37% · 7d 12%");
	});

	it("rc が偽なら ○", () => {
		expect(
			formatStatus({ model: "Opus 5", effort: "high", ctxPercent: 42, fiveHour: 37, sevenDay: 12 }, false)
		).toContain("rc ○");
	});

	it("モデル・エフォートが無ければデフォルト、他が無ければ —", () => {
		expect(formatStatus(null, null)).toBe("デフォルト · デフォルト · ctx — · rc — · 5h — · 7d —");
	});

	it("info はあるが一部だけ欠ける", () => {
		expect(formatStatus({ model: "Sonnet 5", effort: null, ctxPercent: 10, fiveHour: null, sevenDay: null }, true)).toBe(
			"Sonnet 5 · デフォルト · ctx 10% · rc ● · 5h — · 7d —"
		);
	});
});
