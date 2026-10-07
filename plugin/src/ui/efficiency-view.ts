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

const LIMIT_RE = /usage limit|hit your .*limit/i;

function errorText(e: Record<string, unknown>): string {
	const err = (e.error ?? {}) as Record<string, unknown>;
	return [e.message, err.message].filter((x): x is string => typeof x === "string").join(" ");
}

/** The reset time (epoch seconds) of a usage limit the run reported in its stream, or `undefined`
 * when the run did not stop on one. Claude Code: a `rate_limit_event` whose status is `rejected`
 * (its `resetsAt`), or an error `result` saying a limit was hit. Codex: an `error` or
 * `turn.failed` event with its usage-limit message (no reset time). */
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
		} else if ((e.type === "error" || e.type === "turn.failed") && LIMIT_RE.test(errorText(e))) {
			// Codex `exec --json`: its own usage-limit message on an error or a failed turn.
			hit = true;
		}
	}
	return hit ? resetsAt : undefined;
}

const MODEL_UNAVAILABLE_RE =
	/model_not_found|unsupported model|\bmodel\b[^\n]{0,120}?\b(not supported|not found|does not exist|not available|unavailable|no access|not have access|not allowed)/i;

/** Whether a failed run says its model isn't available to this account (Codex's own error text,
 * on an `error` / `turn.failed` event or stderr): the analysis then tries the next model. */
export function modelUnavailable(err: unknown): boolean {
	const parts = [err instanceof Error ? err.message : String(err)];
	if (err instanceof HeadlessError) {
		parts.push(err.stderr);
		for (const e of parseEvents(err.stdout)) {
			if (e.type === "error" || e.type === "turn.failed") {
				parts.push(errorText(e));
			}
		}
	}
	return parts.some((p) => MODEL_UNAVAILABLE_RE.test(p));
}

/** What went wrong with one analysis. `aborted` is whether the user cancelled it. */
export function classifyAnalysisFailure(err: unknown, aborted: boolean): AnalysisFailure {
	if (aborted) {
		return { kind: "cancelled" };
	}
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT" || /\bspawn\b.*\bENOENT\b/.test(message)) {
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

/** Whether pressing Analyze again may get past a failure (not when the agent can't be started). */
export function retryHelps(failure: AnalysisFailure): boolean {
	return failure.kind !== "agentUnavailable";
}

/** The message for a failed analysis: what went wrong (the band adds what stays shown). */
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

// ---- What the pane says (the status band, the steps, the list's heading) -----------------------

/** Where the findings a pane shows come from: the statistics alone, the analysis just made, or the
 * saved result of an earlier one. */
export type ListSource = "stats" | "llm" | "previous";

/** The source of a pane's list: the analysis after a successful one; the previous result (when
 * there is one) while idle or after a failure; the statistics otherwise, including while
 * analysing. */
export function listSource(pane: PaneState, hasPrevious: boolean): ListSource {
	if (shownFindings(pane) === "llm") {
		return "llm";
	}
	return pane !== "working" && hasPrevious ? "previous" : "stats";
}

export interface ListHeading {
	source: ListSource;
	text: string;
	/** The list is the statistics' while an analysis runs: dimmed and not clickable. */
	busy: boolean;
}

/** The heading over a pane's list, which always says where the findings come from. */
export function listHeading(
	pane: PaneState,
	previous: { savedAt: number } | null,
	result: { at: number; model: string } | null
): ListHeading {
	const source = listSource(pane, previous !== null);
	const date = (at: number): string => formatDateTimeShort(at, getLang());
	if (source === "llm") {
		return {
			source,
			text: result ? t("efficiency.list.result", { date: date(result.at), model: result.model }) : t("efficiency.list.resultUndated"),
			busy: false,
		};
	}
	if (source === "previous" && previous) {
		return { source, text: t("efficiency.list.previous", { date: date(previous.savedAt) }), busy: false };
	}
	return { source: "stats", text: t(pane === "working" ? "efficiency.list.statsWorking" : "efficiency.list.stats"), busy: pane === "working" };
}

export type BandTone = "busy" | "info" | "done" | "error";

export interface Band {
	text: string;
	tone: BandTone;
	/** Show the Cancel button (an analysis is running). */
	cancel: boolean;
}

export interface BandInput {
	overall: OverallState;
	/** The pane's state; absent while the statistics are read or when they failed. */
	pane?: PaneState;
	/** The analysing agent's name, as on the tab. */
	agent?: string;
	/** Seconds since reading or analysing started. */
	seconds?: number;
	/** Characters of the reply received so far. */
	chars?: number;
	/** The range has records. */
	hasData?: boolean;
	/** There is something to send (excerpts or hits). */
	analysable?: boolean;
	/** Findings the statistics found on their own. */
	statCount?: number;
	/** Findings in the analysis just made. */
	resultCount?: number;
	/** When the previous result shown was saved (seconds), or null when none is shown. */
	previousAt?: number | null;
	/** The analysing agent used tools. */
	toolUsed?: boolean;
	/** Why the last analysis (or the statistics) failed, and whether pressing Analyze may help. */
	error?: { text: string; retry: boolean } | null;
}

/** Sentences joined as the language joins them (a space in English, nothing in Japanese). */
function sentences(parts: string[]): string {
	return parts.reduce((first, next) => t("efficiency.band.then", { first, next }));
}

/** The one line at the top of a pane: what is going on now and what to do next. */
export function band(input: BandInput): Band {
	const seconds = input.seconds ?? 0;
	const plain = (text: string, tone: BandTone): Band => ({ text, tone, cancel: false });
	if (input.overall === "stats") {
		return { text: t("efficiency.band.reading", { seconds }), tone: "busy", cancel: false };
	}
	if (input.overall === "failed") {
		return plain(input.error?.text ?? "", "error");
	}
	if (input.hasData === false) {
		return plain(t("efficiency.error.noData"), "info");
	}
	const pane = input.pane ?? "idle";
	const agent = input.agent ?? "";
	if (pane === "working") {
		const params = { agent, seconds, chars: input.chars ?? 0 };
		return { text: t(params.chars > 0 ? "efficiency.band.workingChars" : "efficiency.band.working", params), tone: "busy", cancel: true };
	}
	if (input.error) {
		// What stays below: a saved result when there is one (the button then reads "Analyze
		// again"), the statistics' own findings otherwise.
		const previous = typeof input.previousAt === "number";
		const parts = [input.error.text, t(previous ? "efficiency.band.keptPrevious" : "efficiency.band.keptStats")];
		if (input.error.retry) {
			parts.push(t("efficiency.band.retry", { button: t(previous ? "efficiency.consent.again" : "efficiency.consent.send") }));
		}
		return plain(sentences(parts), "error");
	}
	if (pane === "result") {
		const count = input.resultCount ?? 0;
		const done = count > 0 ? t("efficiency.band.done", { count }) : t("efficiency.band.doneNone");
		return input.toolUsed ? plain(sentences([t("efficiency.toolUsed"), done]), "error") : plain(done, "done");
	}
	if (typeof input.previousAt === "number") {
		return plain(t("efficiency.band.previous", { date: formatDateTimeShort(input.previousAt, getLang()) }), "info");
	}
	if (input.analysable === false) {
		return plain(t("efficiency.band.nothing"), "info");
	}
	const count = input.statCount ?? 0;
	return plain(count > 0 ? t("efficiency.band.stats", { count }) : t("efficiency.band.statsNone"), "info");
}

/** A step's mark: finished, running now, waiting for the user, or not reached yet. */
export type StepState = "done" | "busy" | "current" | "todo";

/** The three steps -- read the records, analyse in detail, results and next steps -- and where
 * the pane is among them. */
export function steps(overall: OverallState, pane: PaneState | undefined, source: ListSource): [StepState, StepState, StepState] {
	if (overall === "stats") {
		return ["busy", "todo", "todo"];
	}
	if (overall === "failed") {
		return ["current", "todo", "todo"];
	}
	if (pane === "working") {
		return ["done", "busy", "todo"];
	}
	if (source !== "stats") {
		return ["done", "done", "current"];
	}
	return ["done", "current", "todo"];
}
