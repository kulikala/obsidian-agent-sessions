import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { HeadlessError } from "../../src/backend/headless";
import { getLang, setLang, t } from "../../src/i18n";
import { formatDateTimeShort } from "../../src/i18n/datetime";
import {
	analysisFailureMessage,
	band,
	hasData,
	listHeading,
	listSource,
	retryHelps,
	steps,
	statsFailureMessage,
	classifyAnalysisFailure,
	classifyStatsFailure,
	initialState,
	modelUnavailable,
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

	it("tells a model this account can't use from other failures", () => {
		const refused = JSON.stringify({ type: "error", message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." });
		expect(modelUnavailable(new HeadlessError("codex reported an error", refused))).toBe(true);
		expect(modelUnavailable(new HeadlessError("x", "", "Error: model_not_found"))).toBe(true);
		const failed = JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
		expect(modelUnavailable(new HeadlessError("x", failed))).toBe(false);
		expect(modelUnavailable(new Error("timed out"))).toBe(false);
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
	it("say what happened for each kind", () => {
		expect(statsFailureMessage("noProgram", "")).toBe(t("efficiency.error.noProgram"));
		expect(statsFailureMessage("outdated", "")).toBe(t("efficiency.error.outdated"));
		expect(statsFailureMessage("stats", "timed out")).toContain("timed out");
		expect(hasData({ totals: { calls: 0 } })).toBe(false);
		expect(t("efficiency.error.noData")).toBe("There are no records in this range.");
		expect(analysisFailureMessage({ kind: "llm", detail: "exit 1" }, "Claude Code")).toContain("exit 1");
		expect(analysisFailureMessage({ kind: "cancelled" }, "Claude Code")).toBe(t("efficiency.error.cancelled"));
		expect(analysisFailureMessage({ kind: "agentUnavailable", detail: "ENOENT" }, "Claude Code")).toContain("Claude Code");
		expect(analysisFailureMessage({ kind: "rateLimit", resetsAt: 1_790_003_600 }, "x")).toMatch(/resets .+\)/);
	});
});

describe("what the pane says", () => {
	const SAVED = 1_790_000_000;
	const date = (at: number): string => formatDateTimeShort(at, getLang());

	it("the list's source: the analysis after a success, else a saved result, else the statistics", () => {
		expect(listSource("idle", false)).toBe("stats");
		expect(listSource("idle", true)).toBe("previous");
		expect(listSource("failed", true)).toBe("previous");
		expect(listSource("working", true)).toBe("stats");
		expect(listSource("result", true)).toBe("llm");
	});

	it("the list's heading always names its source, and marks the statistics while analysing", () => {
		setLang("en");
		expect(listHeading("idle", null, null)).toEqual({ source: "stats", text: t("efficiency.list.stats"), busy: false });
		expect(listHeading("working", { savedAt: SAVED }, null)).toEqual({ source: "stats", text: t("efficiency.list.statsWorking"), busy: true });
		expect(listHeading("idle", { savedAt: SAVED }, null).text).toBe(t("efficiency.list.previous", { date: date(SAVED) }));
		const result = listHeading("result", { savedAt: SAVED }, { at: SAVED + 60, model: "sonnet" });
		expect(result.source).toBe("llm");
		expect(result.text).toBe(t("efficiency.list.result", { date: date(SAVED + 60), model: "sonnet" }));
		expect(result.text).toContain("sonnet");
	});

	it("the band: reading, then what the statistics found and to press Analyze", () => {
		setLang("en");
		expect(band({ overall: "stats", seconds: 3 })).toEqual({ text: "Reading the records… 3 s", tone: "busy", cancel: false });
		const found = band({ overall: "ready", pane: "idle", statCount: 2, hasData: true, analysable: true });
		expect(found).toEqual({ text: t("efficiency.band.stats", { count: 2 }), tone: "info", cancel: false });
		expect(found.text).toContain("2 findings");
		expect(band({ overall: "ready", pane: "idle", statCount: 0 }).text).toBe(t("efficiency.band.statsNone"));
		expect(band({ overall: "ready", pane: "idle", analysable: false }).text).toBe(t("efficiency.band.nothing"));
		expect(band({ overall: "ready", pane: "idle", hasData: false }).text).toBe(t("efficiency.error.noData"));
	});

	it("the band: a previous result, an analysis running (with Cancel), a finished one", () => {
		setLang("en");
		expect(band({ overall: "ready", pane: "idle", previousAt: SAVED, statCount: 3 }).text).toBe(t("efficiency.band.previous", { date: date(SAVED) }));
		const working = band({ overall: "ready", pane: "working", agent: "Codex", seconds: 42, previousAt: SAVED });
		expect(working).toEqual({ text: t("efficiency.band.working", { agent: "Codex", seconds: 42 }), tone: "busy", cancel: true });
		expect(working.text).toContain("Codex is analysing… 42 s");
		expect(band({ overall: "ready", pane: "working", agent: "Codex", seconds: 5, chars: 120 }).text).toContain("120 characters received");
		expect(band({ overall: "ready", pane: "result", resultCount: 4 })).toEqual({ text: t("efficiency.band.done", { count: 4 }), tone: "done", cancel: false });
		expect(band({ overall: "ready", pane: "result", resultCount: 0 }).text).toBe(t("efficiency.band.doneNone"));
	});

	it("the band: failures, a cancel and tools used are errors, with the next step", () => {
		setLang("en");
		const failed = band({ overall: "ready", pane: "failed", error: { text: "It failed.", retry: true } });
		expect(failed).toEqual({ text: "It failed. The statistics' findings stay below. To try again, press Analyze.", tone: "error", cancel: false });
		// A cancelled analysis returns the pane to idle; its message stays until the next run.
		const cancelled = band({ overall: "ready", pane: "idle", previousAt: SAVED, error: { text: "Cancelled.", retry: true } });
		expect(cancelled.tone).toBe("error");
		expect(cancelled.text).toBe("Cancelled. The previous analysis stays below. To try again, press Analyze again.");
		expect(band({ overall: "ready", pane: "failed", error: { text: "Not found.", retry: false } }).text).toBe("Not found. The statistics' findings stay below.");
		const tools = band({ overall: "ready", pane: "result", resultCount: 1, toolUsed: true });
		expect(tools.tone).toBe("error");
		expect(tools.text).toBe(`${t("efficiency.toolUsed")} ${t("efficiency.band.done", { count: 1 })}`);
		// The statistics' failure is the band alone; nothing stays below it.
		expect(band({ overall: "failed", error: { text: "No program.", retry: false } }).text).toBe("No program.");
		expect(band({ overall: "failed", error: { text: "No program.", retry: false } })).toEqual({ text: "No program.", tone: "error", cancel: false });
	});

	it("the band in Japanese", () => {
		setLang("ja");
		expect(band({ overall: "stats", seconds: 3 }).text).toBe("記録を集計しています… 3 秒");
		expect(band({ overall: "ready", pane: "idle", statCount: 2 }).text).toBe(
			"集計しました。統計から 2 件見つかりました。原因と直し方を詳しく調べるには［解析する］を押してください。"
		);
		expect(band({ overall: "ready", pane: "working", agent: "Claude Code", seconds: 7 }).text).toBe(
			"Claude Code が解析しています… 7 秒（ふつう 1〜3 分）。待つあいだ閉じると中止します。"
		);
		expect(band({ overall: "ready", pane: "result", resultCount: 5 }).text).toBe("解析が終わりました。5 件の指摘を、影響の大きい順に並べています。");
		expect(band({ overall: "ready", pane: "failed", error: { text: t("efficiency.error.timeout"), retry: true } }).text).toBe(
			"解析に時間がかかりすぎたため止めました。統計による指摘は下に残しています。もう一度試すには［解析する］を押してください。"
		);
		setLang("en");
	});

	it("the steps: reading, waiting for Analyze, analysing, results", () => {
		expect(steps("stats", undefined, "stats")).toEqual(["busy", "todo", "todo"]);
		expect(steps("failed", undefined, "stats")).toEqual(["current", "todo", "todo"]);
		expect(steps("ready", "idle", "stats")).toEqual(["done", "current", "todo"]);
		expect(steps("ready", "failed", "stats")).toEqual(["done", "current", "todo"]);
		expect(steps("ready", "working", "stats")).toEqual(["done", "busy", "todo"]);
		expect(steps("ready", "result", "llm")).toEqual(["done", "done", "current"]);
		expect(steps("ready", "idle", "previous")).toEqual(["done", "done", "current"]);
	});

	it("pressing Analyze again helps with every failure but an agent that can't be started", () => {
		expect(retryHelps({ kind: "agentUnavailable", detail: "x" })).toBe(false);
		expect(retryHelps({ kind: "timeout" })).toBe(true);
		expect(retryHelps({ kind: "cancelled" })).toBe(true);
	});
});
