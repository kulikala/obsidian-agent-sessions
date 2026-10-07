import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { HeadlessError } from "../../src/backend/headless";
import { t } from "../../src/i18n";
import {
	analysisFailureMessage,
	hasData,
	statsFailureMessage,
	classifyAnalysisFailure,
	classifyStatsFailure,
	initialState,
	rateLimitOf,
	shownFindings,
	transition,
	type DialogState,
} from "../../src/ui/efficiency-view";

const CLAUDE_RESULT = readFileSync(join(__dirname, "../fixtures/headless/claude-result.jsonl"), "utf8");

function ready(): DialogState {
	return transition(initialState(), { type: "statsDone", agents: ["claude"] });
}

describe("dialog states", () => {
	it("stats -> ready with an idle pane per agent, or failed", () => {
		expect(initialState()).toEqual({ overall: "stats", panes: {} });
		expect(ready()).toEqual({ overall: "ready", panes: { claude: "idle" } });
		expect(transition(initialState(), { type: "statsFailed" }).overall).toBe("failed");
	});

	it("a pane goes idle -> working -> result or failed; cancel returns it to idle", () => {
		const working = transition(ready(), { type: "start", agent: "claude" });
		expect(working.panes.claude).toBe("working");
		expect(transition(working, { type: "succeeded", agent: "claude" }).panes.claude).toBe("result");
		expect(transition(working, { type: "failed", agent: "claude" }).panes.claude).toBe("failed");
		expect(transition(working, { type: "cancelled", agent: "claude" }).panes.claude).toBe("idle");
		const again = transition(transition(working, { type: "succeeded", agent: "claude" }), { type: "start", agent: "claude" });
		expect(again.panes.claude).toBe("working");
	});

	it("ignores events that don't apply", () => {
		const r = ready();
		expect(transition(r, { type: "succeeded", agent: "claude" })).toBe(r);
		expect(transition(r, { type: "start", agent: "codex" })).toBe(r);
		expect(transition(initialState(), { type: "start", agent: "claude" })).toEqual(initialState());
		expect(transition(r, { type: "statsDone", agents: [] })).toBe(r);
	});

	it("the statistics' findings stay unless an analysis succeeded", () => {
		expect(shownFindings("idle")).toBe("stats");
		expect(shownFindings("working")).toBe("stats");
		expect(shownFindings("failed")).toBe("stats");
		expect(shownFindings("result")).toBe("llm");
	});
});

describe("failures", () => {
	it("statistics: not installed, too old, anything else", () => {
		expect(classifyStatsFailure(new Error("spawn ENOENT"), false)).toBe("noProgram");
		expect(classifyStatsFailure(new Error("unknown json subcommand: efficiency"), true)).toBe("outdated");
		expect(classifyStatsFailure(new Error("Command failed: timed out"), true)).toBe("stats");
	});

	it("analysis: cancelled, CLI missing, time-out, other", () => {
		expect(classifyAnalysisFailure(new HeadlessError("aborted"), true)).toEqual({ kind: "cancelled" });
		const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
		expect(classifyAnalysisFailure(missing, false).kind).toBe("agentUnavailable");
		expect(classifyAnalysisFailure(new HeadlessError("timed out"), false)).toEqual({ kind: "timeout" });
		expect(classifyAnalysisFailure(new HeadlessError("model not found"), false)).toEqual({ kind: "llm", detail: "model not found" });
		expect(classifyAnalysisFailure(new Error("spawn /x/claude ENOENT"), false).kind).toBe("agentUnavailable");
		expect(classifyAnalysisFailure(new HeadlessError("boom", CLAUDE_RESULT), false)).toEqual({ kind: "llm", detail: "boom" });
	});

	it("analysis: a usage limit, with its reset time when the stream gives one", () => {
		const rejected = [
			JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_790_003_600, rateLimitType: "five_hour" } }),
			JSON.stringify({ type: "result", is_error: true, result: "You've hit your session limit · resets 3pm" }),
		].join("\n");
		expect(rateLimitOf(rejected)).toBe(1_790_003_600);
		expect(classifyAnalysisFailure(new HeadlessError("You've hit your session limit", rejected), false)).toEqual({
			kind: "rateLimit",
			resetsAt: 1_790_003_600,
		});
		const textOnly = JSON.stringify({ type: "result", is_error: true, result: "You've hit your weekly limit" });
		expect(classifyAnalysisFailure(new HeadlessError("x", textOnly), false)).toEqual({ kind: "rateLimit", resetsAt: null });
		expect(rateLimitOf(CLAUDE_RESULT)).toBeUndefined();
	});

	it("reads Codex's usage-limit failure", () => {
		const failed = [
			JSON.stringify({ type: "thread.started", thread_id: "x" }),
			JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again later." }),
			JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }),
		].join("\n");
		expect(rateLimitOf(failed)).toBeNull();
		expect(classifyAnalysisFailure(new HeadlessError("x", failed), false)).toEqual({ kind: "rateLimit", resetsAt: null });
		const other = JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } });
		expect(rateLimitOf(other)).toBeUndefined();
	});
});

describe("failure messages", () => {
	it("say what happened for each kind, and analysis failures keep the statistics' findings", () => {
		expect(statsFailureMessage("noProgram", "")).toBe(t("efficiency.error.noProgram"));
		expect(statsFailureMessage("outdated", "")).toBe(t("efficiency.error.outdated"));
		expect(statsFailureMessage("stats", "timed out")).toContain("timed out");
		expect(hasData({ totals: { calls: 0 } })).toBe(false);
		expect(t("efficiency.error.noData")).toBe("There are no records in this range.");
		const kept = "The statistics' findings stay below.";
		for (const failure of [
			{ kind: "cancelled" as const },
			{ kind: "timeout" as const },
			{ kind: "llm" as const, detail: "exit 1" },
			{ kind: "rateLimit" as const, resetsAt: 1_790_003_600 },
			{ kind: "rateLimit" as const, resetsAt: null },
		]) {
			expect(analysisFailureMessage(failure, "Claude Code")).toContain(kept);
		}
		expect(analysisFailureMessage({ kind: "agentUnavailable", detail: "ENOENT" }, "Claude Code")).toContain("Claude Code");
		expect(analysisFailureMessage({ kind: "rateLimit", resetsAt: 1_790_003_600 }, "x")).toMatch(/resets .+\)/);
	});
});
