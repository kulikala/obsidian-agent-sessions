import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectorMetrics, loadPrevious, loadResult, overlaps, saveResult, type SavedResult } from "../../src/sessions/efficiency-store";

function result(savedAt: number): SavedResult {
	return {
		version: 3,
		agent: "claude",
		savedAt,
		model: "sonnet",
		range: { rule: "budget", start: 100, end: 200, used_percentage: null, exhausted: false },
		totals: { w: 10 } as SavedResult["totals"],
		sessions: 1,
		sessionIds: ["s1"],
		checks: [
			{ check: "rework", state: "ok", findings: [] },
			{ check: "firstRequest", state: "na", findings: [] },
		],
		hits: [],
		taskSessions: {},
		selfCost: { input: 1, output: 2, usd: 0.01 },
		sent: { tokens: 4000, sessions: 2, requests: 1 },
		metrics: {},
	};
}

describe("saved results", () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "efficiency-store-"))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes last-<agent>.json and moves the earlier one to prev-", () => {
		expect(loadResult(dir, "claude")).toBeNull();
		saveResult(dir, result(1));
		saveResult(dir, result(2));
		expect(loadResult(dir, "claude")?.savedAt).toBe(2);
		expect(loadPrevious(dir, "claude")?.savedAt).toBe(1);
		expect(readdirSync(dir).sort()).toEqual(["last-claude.json", "prev-claude.json"]);
	});

	it("ignores a broken or foreign file", () => {
		writeFileSync(join(dir, "last-claude.json"), "{not json");
		expect(loadResult(dir, "claude")).toBeNull();
		writeFileSync(join(dir, "last-claude.json"), JSON.stringify({ ...result(1), version: 99 }));
		expect(loadResult(dir, "claude")).toBeNull();
		writeFileSync(join(dir, "last-claude.json"), JSON.stringify({ ...result(1), agent: "codex" }));
		expect(loadResult(dir, "claude")).toBeNull();
		writeFileSync(join(dir, "last-claude.json"), JSON.stringify({ ...result(1), checks: [{ check: "rework", state: "maybe" }] }));
		expect(loadResult(dir, "claude")).toBeNull();
	});

	it("treats a result saved in an earlier format as no result", () => {
		const v2 = { ...result(1), version: 2, checks: [{ check: "rework", state: "ok", finding: null }] };
		writeFileSync(join(dir, "last-claude.json"), JSON.stringify(v2));
		expect(loadResult(dir, "claude")).toBeNull();
	});

	it("treats a result saved in the first format (findings, no checks) as no result", () => {
		const old = { ...result(1), version: 1, findings: [], dismissed: [], payloadHash: "x" } as Partial<SavedResult>;
		delete old.checks;
		writeFileSync(join(dir, "last-claude.json"), JSON.stringify(old));
		expect(loadResult(dir, "claude")).toBeNull();
	});

	it("shows a previous result only when the ranges overlap", () => {
		expect(overlaps(result(1), { start: 150, end: 300 })).toBe(true);
		expect(overlaps(result(1), { start: 201, end: 300 })).toBe(false);
	});

	it("keeps per-detector numbers", () => {
		const hits = [
			{ detector: "E01", impact_w: 5 },
			{ detector: "E01", impact_w: 7 },
			{ detector: "E04", impact_w: 1 },
		] as SavedResult["hits"];
		expect(detectorMetrics(hits)).toEqual({ E01: { hits: 2, impact_w: 12 }, E04: { hits: 1, impact_w: 1 } });
	});
});
