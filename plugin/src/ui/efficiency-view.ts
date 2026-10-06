// The token efficiency dialog's pure part: its states, what each failure means, and which findings
// a pane shows. The whole dialog goes `stats` (reading the records) -> `ready` (or `failed`); after
// that each pane (one per analysed agent) goes `idle` -> `working` -> `result` or `failed`, and a
// failed or cancelled analysis returns to the statistics' own findings, never to nothing.

import { HeadlessError } from "../backend/headless";
import { getLang, t } from "../i18n";
import { formatDateTimeShort } from "../i18n/datetime";
import { parseEvents } from "../sessions/organize-agent";

export type OverallState = "stats" | "ready" | "failed";
export type PaneState = "idle" | "working" | "result" | "failed";

export interface DialogState {
	overall: OverallState;
	panes: Record<string, PaneState>;
}

export type DialogEvent =
	| { type: "statsDone"; agents: string[] }
	| { type: "statsFailed" }
	| { type: "start"; agent: string }
	| { type: "succeeded"; agent: string }
	| { type: "failed"; agent: string }
	| { type: "cancelled"; agent: string }
	| { type: "restart" };

export function initialState(): DialogState {
	return { overall: "stats", panes: {} };
}

/** The next state. Events that don't apply to the current state leave it unchanged. */
export function transition(state: DialogState, event: DialogEvent): DialogState {
	switch (event.type) {
		case "restart":
			return initialState();
		case "statsDone":
			if (state.overall !== "stats") {
				return state;
			}
			return { overall: "ready", panes: Object.fromEntries(event.agents.map((a) => [a, "idle" as PaneState])) };
		case "statsFailed":
			return state.overall === "stats" ? { overall: "failed", panes: {} } : state;
	}
	const pane = state.panes[event.agent];
	if (state.overall !== "ready" || pane === undefined) {
		return state;
	}
	let next: PaneState = pane;
	if (event.type === "start" && pane !== "working") {
		next = "working";
	} else if (pane === "working") {
		next = event.type === "succeeded" ? "result" : event.type === "failed" ? "failed" : event.type === "cancelled" ? "idle" : pane;
	}
	return next === pane ? state : { ...state, panes: { ...state.panes, [event.agent]: next } };
}

/** Which findings a pane shows: the model's after a successful analysis, the statistics' own
 * otherwise (before, during, and after a failed or cancelled one). */
export function shownFindings(pane: PaneState): "llm" | "stats" {
	return pane === "result" ? "llm" : "stats";
}

// ---- Failures (D-11) -------------------------------------------------------------------------

export type StatsFailure = "noProgram" | "outdated" | "stats";

/** What went wrong reading the statistics: the program isn't installed, it predates `json
 * efficiency` (it ends with "unknown json subcommand"), or anything else (including a time-out). */
export function classifyStatsFailure(err: unknown, programExists: boolean): StatsFailure {
	if (!programExists) {
		return "noProgram";
	}
	const message = err instanceof Error ? err.message : String(err);
	return /unknown json subcommand/i.test(message) ? "outdated" : "stats";
}

export type AnalysisFailure =
	| { kind: "cancelled" }
	| { kind: "agentUnavailable"; detail: string }
	| { kind: "rateLimit"; resetsAt: number | null }
	| { kind: "timeout" }
	| { kind: "llm"; detail: string };

/** The reset time (epoch seconds) of a usage limit Claude Code reported in its stream, or
 * `undefined` when the run did not stop on one. Reads a `rate_limit_event` whose status is
 * `rejected` (its `resetsAt`), or an error `result` saying a limit was hit. */
export function rateLimitOf(stdout: string): number | null | undefined {
	let hit = false;
	let resetsAt: number | null = null;
	for (const e of parseEvents(stdout)) {
		if (e.type === "rate_limit_event") {
			const info = (e.rate_limit_info ?? {}) as Record<string, unknown>;
			if (info.status === "rejected") {
				hit = true;
				if (typeof info.resetsAt === "number") {
					resetsAt = info.resetsAt > 1e12 ? Math.round(info.resetsAt / 1000) : info.resetsAt;
				}
			}
		} else if (e.type === "result" && e.is_error === true && typeof e.result === "string" && /hit your .*limit/i.test(e.result)) {
			hit = true;
		}
	}
	return hit ? resetsAt : undefined;
}

/** What went wrong with one analysis. `aborted` is whether the user cancelled it. */
export function classifyAnalysisFailure(err: unknown, aborted: boolean): AnalysisFailure {
	if (aborted) {
		return { kind: "cancelled" };
	}
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT" || /ENOENT|not found/i.test(message)) {
		return { kind: "agentUnavailable", detail: message };
	}
	if (err instanceof HeadlessError) {
		const resetsAt = rateLimitOf(err.stdout);
		if (resetsAt !== undefined) {
			return { kind: "rateLimit", resetsAt };
		}
	}
	if (message === "timed out") {
		return { kind: "timeout" };
	}
	return { kind: "llm", detail: message };
}

/** The message for a statistics failure. */
export function statsFailureMessage(kind: StatsFailure, error: string): string {
	return kind === "noProgram"
		? t("efficiency.error.noProgram")
		: kind === "outdated"
			? t("efficiency.error.outdated")
			: t("efficiency.error.stats", { error });
}

/** Whether an agent's block has anything in its range (otherwise "no records in this range"). */
export function hasData(block: { totals: { calls: number } }): boolean {
	return block.totals.calls > 0;
}

/** The message for a failed analysis; every one of them says the statistics' findings stay. */
export function analysisFailureMessage(failure: AnalysisFailure, agent: string): string {
	switch (failure.kind) {
		case "cancelled":
			return t("efficiency.error.cancelled");
		case "agentUnavailable":
			return t("efficiency.error.agentUnavailable", { agent, detail: failure.detail });
		case "rateLimit":
			return failure.resetsAt
				? t("efficiency.error.rateLimit", { time: formatDateTimeShort(failure.resetsAt, getLang()) })
				: t("efficiency.error.rateLimitUnknown");
		case "timeout":
			return t("efficiency.error.timeout");
		case "llm":
			return t("efficiency.error.llm", { error: failure.detail });
	}
}
