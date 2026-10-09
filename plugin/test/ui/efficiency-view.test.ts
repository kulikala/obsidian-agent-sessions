import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { HeadlessError } from "../../src/backend/headless";
import { setLang, t } from "../../src/i18n";
import type { Finding } from "../../src/sessions/efficiency";
import {
	analysisFailureMessage,
	checkDesc,
	checkName,
	classifyAnalysisFailure,
	classifyStatsFailure,
	doneCount,
	elapsedText,
	hasData,
	idleRows,
	initialState,
	metaLine,
	modelUnavailable,
	rateLimitOf,
	resultHeading,
	rowsToSave,
	savedRows,
	setRow,
	spanLabel,
	stateLabel,
	statsFailureMessage,
	summarize,
	summaryText,
	targetLine,
	transition,
	waitingRows,
	type DialogState,
} from "../../src/ui/efficiency-view";

const CLAUDE_RESULT = readFileSync(join(__dirname, "../fixtures/headless/claude-result.jsonl"), "utf8");

afterEach(() => setLang("en"));

function ready(withResult: string[] = []): DialogState {
	return transition(initialState(), { type: "statsDone", agents: ["claude", "codex-openai"], withResult });
}

function finding(check: string, savingW: number): Finding {
	return {
		check,
		hits: ["h-1"],
		title: "T",
		observed: "O",
		cause: "habit",
		fix: "F",
		quotes: [],
		action: "none",
		change: null,
		targets: [],
		draft: "",
		sources: [],
		impactW: savingW * 2,
		impactUsd: null,
		savingW,
		fromStats: false,
	};
}

describe("dialog states", () => {
	it("stats -> ready: a pane with a saved result opens on it, the others empty; or failed", () => {
		expect(initialState()).toEqual({ overall: "stats", panes: {} });
		expect(ready()).toEqual({ overall: "ready", panes: { claude: "empty", "codex-openai": "empty" } });
		expect(ready(["claude"]).panes).toEqual({ claude: "result", "codex-openai": "empty" });
		expect(transition(initialState(), { type: "statsFailed" }).overall).toBe("failed");
	});

	it("empty or result -> analyzing -> result; stopping goes back to the saved result, else to empty", () => {
		const analyzing = transition(ready(), { type: "start", agent: "claude" });
		expect(analyzing.panes).toEqual({ claude: "analyzing", "codex-openai": "empty" });
		expect(transition(analyzing, { type: "finished", agent: "claude" }).panes.claude).toBe("result");
		expect(transition(analyzing, { type: "stopped", agent: "claude", hasResult: false }).panes.claude).toBe("empty");
		expect(transition(analyzing, { type: "stopped", agent: "claude", hasResult: true }).panes.claude).toBe("result");
		const again = transition(ready(["claude"]), { type: "start", agent: "claude" });
		expect(again.panes.claude).toBe("analyzing");
	});

	it("ignores events that don't apply", () => {
		const state = ready();
		expect(transition(state, { type: "finished", agent: "claude" })).toBe(state);
		expect(transition(state, { type: "stopped", agent: "claude", hasResult: true })).toBe(state);
		expect(transition(state, { type: "start", agent: "nobody" })).toBe(state);
		expect(transition(initialState(), { type: "start", agent: "claude" }).overall).toBe("stats");
		const analyzing = transition(state, { type: "start", agent: "claude" });
		expect(transition(analyzing, { type: "start", agent: "claude" })).toBe(analyzing);
		expect(transition(analyzing, { type: "statsDone", agents: [], withResult: [] })).toBe(analyzing);
		expect(transition(analyzing, { type: "restart" })).toEqual(initialState());
	});
});

describe("the eight rows", () => {
	it("start not analysed, wait in turn, and settle one by one", () => {
		expect(idleRows().map((r) => r.state)).toEqual(Array(8).fill("idle"));
		let rows = waitingRows();
		rows = setRow(rows, 0, "issue", finding("rework", 450_000));
		rows = setRow(rows, 1, "ok");
		rows = setRow(rows, 2, "na");
		rows = setRow(rows, 3, "running");
		expect(rows.map((r) => r.state)).toEqual(["issue", "ok", "na", "running", "waiting", "waiting", "waiting", "waiting"]);
		expect(doneCount(rows)).toBe(3);
		expect(setRow(rows, 1, "ok", finding("x", 1))[1].finding).toBeNull();
	});

	it("add up the issues and their savings", () => {
		let rows = waitingRows();
		rows = setRow(rows, 0, "issue", finding("rework", 450_000));
		rows = setRow(rows, 4, "issue", finding("largeOutput", 400_000));
		rows = setRow(rows, 5, "issue", finding("cacheRebuild", 350_000));
		expect(summarize(rows)).toEqual({ issues: 3, savingW: 1_200_000 });
		expect(summaryText(rows)).toBe("Found waste in 3 of 8 areas. Fixing it could save up to about 1.2M tokens.");
		expect(summaryText(setRow(waitingRows(), 0, "issue", finding("rework", 1000)))).toBe(
			"Found waste in 1 of 8 areas. Fixing it could save up to about 1.0k tokens."
		);
		expect(summaryText(waitingRows().map((r) => ({ ...r, state: "ok" })))).toBe(t("efficiency.result.none"));
		setLang("ja");
		expect(summaryText(rows)).toBe("3 つの観点で無駄が見つかりました。直すと、最大で約 1.2M トークン減らせる見込みです。");
	});

	it("round-trip through a saved result, in the checks' order", () => {
		let rows = waitingRows();
		rows = setRow(rows, 0, "issue", finding("rework", 10));
		rows = rows.map((r, i) => (i === 0 ? r : { ...r, state: i === 7 ? "na" : "ok" }));
		const saved = rowsToSave(rows);
		expect(saved.map((c) => c.state)).toEqual(["issue", "ok", "ok", "ok", "ok", "ok", "ok", "na"]);
		expect(savedRows([...saved].reverse())).toEqual(rows);
		// A check the saved result doesn't have, and an issue without its finding.
		const partial = savedRows([{ check: "rework", state: "issue", finding: null }]);
		expect(partial.map((r) => r.state)).toEqual(["ok", "na", "na", "na", "na", "na", "na", "na"]);
	});
});

describe("words", () => {
	it("each check's name and description, and each state, in both languages", () => {
		expect(checkName("rework")).toBe("Redoing the same fix");
		expect(checkDesc("startupSize")).toBe("Do instruction files or unused skills make every start large?");
		expect(["idle", "waiting", "running", "ok", "issue", "na"].map((s) => stateLabel(s as "ok"))).toEqual([
			"Not analyzed",
			"Queued",
			"Analyzing",
			"No issues",
			"Issue found",
			"Not applicable",
		]);
		setLang("ja");
		expect(checkName("mixedTasks")).toBe("1 つの会話に複数の作業");
		expect(stateLabel("na")).toBe("対象外");
	});

	it("the range covered, the elapsed time and the meta line", () => {
		const week = { start: 0, end: 7 * 86400 };
		expect(spanLabel(week)).toBe("last 7 days");
		expect(spanLabel({ start: 0, end: 5 * 3600 })).toBe("last 5 hours");
		expect(spanLabel({ start: 0, end: 30 * 3600 })).toBe("last 30 hours");
		expect(spanLabel(week, true)).toBe("Last 7 days");
		expect(spanLabel({ start: 0, end: 600 })).toBe("last 1 hour");
		expect(targetLine(week, 42, 28_600_000)).toBe("Covers 42 sessions from the last 7 days (28.6M tokens).");
		expect(elapsedText(72)).toBe("1 min 12 s elapsed (about 1–3 min)");
		expect(elapsedText(9)).toBe("9 s elapsed (about 1–3 min)");
		expect(metaLine(["a", null, "b"])).toBe("a · b");
		expect(resultHeading(1_790_000_000, 1_790_000_000)).toMatch(/^Analysis from .+/);
		setLang("ja");
		expect(targetLine(week, 42, 28_600_000)).toBe("直近 7 日の 42 セッション（計 28.6M トークン）を調べます。");
		expect(elapsedText(72)).toBe("経過 1 分 12 秒（目安 1〜3 分）");
		expect(metaLine([spanLabel(week, true), "42 セッション"])).toBe("直近 7 日・42 セッション");
		expect(resultHeading(1_790_000_000, 1_790_000_000)).toMatch(/ の解析結果$/);
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
		expect(analysisFailureMessage({ kind: "cancelled" }, "Claude Code")).toBeNull();
		expect(analysisFailureMessage({ kind: "agentUnavailable", detail: "ENOENT" }, "Claude Code")).toContain("Claude Code");
		expect(analysisFailureMessage({ kind: "rateLimit", resetsAt: 1_790_003_600 }, "x")).toMatch(/resets .+\)/);
	});
});
