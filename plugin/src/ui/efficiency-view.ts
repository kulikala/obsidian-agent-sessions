// The token efficiency dialog's pure part: its states, the eight check rows, what each failure
// means, and the lines the screens show. The dialog reads the records first (`stats`, then
// `ready` or `failed`); after that each pane shows one of three screens: `empty` (not analysed
// yet), `analyzing`, or `result` (the analysis just made, or the saved one -- the same screen).
// Stopping an analysis, or one that fails, goes back to the saved result when there is one and
// to `empty` otherwise; a stopped analysis keeps nothing of its own.

import { HeadlessError } from "../backend/headless";
import { getLang, t, type MessageKey } from "../i18n";
import { formatDateTimeShort } from "../i18n/datetime";
import type { EffRange, Finding } from "../sessions/efficiency";
import { CHECKS, type CheckId } from "../sessions/efficiency-checks";
import type { SavedCheck } from "../sessions/efficiency-store";
import { parseEvents } from "../sessions/organize-agent";

export type OverallState = "stats" | "ready" | "failed";
export type Screen = "empty" | "analyzing" | "result";

export interface DialogState {
	overall: OverallState;
	panes: Record<string, Screen>;
}

export type DialogEvent =
	/** The records are read: the panes, and which of them have a saved result. */
	| { type: "statsDone"; agents: string[]; withResult: string[] }
	| { type: "statsFailed" }
	| { type: "start"; agent: string }
	| { type: "finished"; agent: string }
	/** Stopped by the user or by a failure; `hasResult`: a saved result to go back to. */
	| { type: "stopped"; agent: string; hasResult: boolean }
	| { type: "restart" };

export function initialState(): DialogState {
	return { overall: "stats", panes: {} };
}

/** The next state. Events that don't apply to the current state leave it unchanged. */
export function transition(state: DialogState, event: DialogEvent): DialogState {
	switch (event.type) {
		case "restart":
			return initialState();
		case "statsDone": {
			if (state.overall !== "stats") {
				return state;
			}
			const withResult = new Set(event.withResult);
			return { overall: "ready", panes: Object.fromEntries(event.agents.map((a) => [a, withResult.has(a) ? "result" : "empty"])) };
		}
		case "statsFailed":
			return state.overall === "stats" ? { overall: "failed", panes: {} } : state;
	}
	const screen = state.panes[event.agent];
	if (state.overall !== "ready" || screen === undefined) {
		return state;
	}
	let next: Screen = screen;
	if (event.type === "start" && screen !== "analyzing") {
		next = "analyzing";
	} else if (screen === "analyzing") {
		next = event.type === "finished" ? "result" : event.type === "stopped" ? (event.hasResult ? "result" : "empty") : screen;
	}
	return next === screen ? state : { ...state, panes: { ...state.panes, [event.agent]: next } };
}

// ---- The eight rows ------------------------------------------------------------------------------

/** A row's state: not analysed, waiting for its turn, being analysed, no issues, an issue, or not
 * applicable. */
export type CheckState = "idle" | "waiting" | "running" | "ok" | "issue" | "na";

export interface Row {
	check: CheckId;
	state: CheckState;
	finding: Finding | null;
}

/** The rows before any analysis: every check not analysed. */
export function idleRows(): Row[] {
	return CHECKS.map((c) => ({ check: c.id, state: "idle", finding: null }));
}

/** The rows as an analysis starts: every check waiting its turn. */
export function waitingRows(): Row[] {
	return CHECKS.map((c) => ({ check: c.id, state: "waiting", finding: null }));
}

/** `rows` with row `index` replaced. */
export function setRow(rows: Row[], index: number, state: CheckState, finding: Finding | null = null): Row[] {
	return rows.map((r, i) => (i === index ? { ...r, state, finding: state === "issue" ? finding : null } : r));
}

/** Whether a row has its answer. */
export function isSettled(state: CheckState): boolean {
	return state === "ok" || state === "issue" || state === "na";
}

/** How many checks have their answer. */
export function doneCount(rows: Row[]): number {
	return rows.filter((r) => isSettled(r.state)).length;
}

/** The rows of a saved result, in the checks' order (a check it doesn't have: not applicable). */
export function savedRows(checks: SavedCheck[]): Row[] {
	return CHECKS.map((c) => {
		const saved = checks.find((x) => x.check === c.id);
		if (!saved) {
			return { check: c.id, state: "na" as CheckState, finding: null };
		}
		return { check: c.id, state: saved.state === "issue" && !saved.finding ? "ok" : saved.state, finding: saved.state === "issue" ? saved.finding : null };
	});
}

/** What a finished analysis saves of its rows. */
export function rowsToSave(rows: Row[]): SavedCheck[] {
	return rows.map((r) => ({ check: r.check, state: r.state === "issue" ? "issue" : r.state === "na" ? "na" : "ok", finding: r.finding }));
}

/** The issues, and the tokens fixing all of them could save at most. */
export function summarize(rows: Row[]): { issues: number; savingW: number } {
	let issues = 0;
	let savingW = 0;
	for (const r of rows) {
		if (r.state === "issue" && r.finding) {
			issues += 1;
			savingW += r.finding.savingW;
		}
	}
	return { issues, savingW };
}

// ---- Words -------------------------------------------------------------------------------------

export function checkName(id: CheckId): string {
	return t(`efficiency.check.${id}.name` as MessageKey);
}

export function checkDesc(id: CheckId): string {
	return t(`efficiency.check.${id}.desc` as MessageKey);
}

export function stateLabel(state: CheckState): string {
	return t(`efficiency.state.${state}` as MessageKey);
}

/** How far back the range reaches: "last 7 days", "last 30 hours" (in hours below two days);
 * `meta`: as the first part of a meta line ("Last 7 days"). */
export function spanLabel(range: Pick<EffRange, "start" | "end">, meta = false): string {
	const hours = Math.max(1, Math.round((range.end - range.start) / 3600));
	const days = hours >= 48 ? Math.round(hours / 24) : null;
	if (meta) {
		return days ? t("efficiency.meta.days", { count: days }) : t("efficiency.meta.hours", { count: hours });
	}
	return days ? t("efficiency.span.days", { count: days }) : t("efficiency.span.hours", { count: hours });
}

/** A number shown in this dialog, short, in the units the language counts in
 * (`efficiency.number.units`: Japanese 万 and 億, "45 万", "2,860 万"; English K, M and B,
 * "450K", "28.6M"), with at most one decimal and none when it is 0. Below the smallest unit the
 * number is written out ("8,500"). */
export function compactNumber(n: number): string {
	const lang = getLang();
	const group = (value: number, digits: number): string =>
		new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
	// "1e9:{n}B|1e6:{n}M|1e3:{n}K", largest first. A number just under a unit that would round up
	// to it in the next smaller one (999,950: "1,000K") takes the larger unit ("1M").
	const units = t("efficiency.number.units")
		.split("|")
		.map((entry) => [Number(entry.slice(0, entry.indexOf(":"))), entry.slice(entry.indexOf(":") + 1)] as const)
		.filter(([size]) => size > 0);
	const abs = Math.abs(n);
	for (const [i, [size, form]] of units.entries()) {
		const next = units[i + 1]?.[0];
		if (abs >= size || (next !== undefined && Math.round((abs / next) * 10) / 10 >= size / next)) {
			return form.replace("{n}", group(Math.round((n / size) * 10) / 10, 1));
		}
	}
	return group(Math.round(n), 0);
}

/** An amount of tokens as the dialog writes it: "120 万トークン", "8,500 トークン", "1.2M tokens". */
export function tokensText(n: number): string {
	const number = compactNumber(n);
	return t(/\d$/.test(number) ? "efficiency.tokens" : "efficiency.tokensUnit", { n: number, count: Math.round(n) });
}

/** "Covers 42 sessions from the last 7 days (28.6M tokens)." */
export function targetLine(range: Pick<EffRange, "start" | "end">, sessions: number, tokens: number): string {
	return t("efficiency.target", { span: spanLabel(range), sessions, tokens: tokensText(tokens) });
}

/** The summary under a result's heading. */
export function summaryText(rows: Row[]): string {
	const { issues, savingW } = summarize(rows);
	return issues > 0 ? t("efficiency.result.summary", { count: issues, tokens: tokensText(savingW) }) : t("efficiency.result.none");
}

export function resultHeading(at: number, now = Date.now() / 1000): string {
	return t("efficiency.result.heading", { date: formatDateTimeShort(at, getLang(), now) });
}

/** "1 min 12 s elapsed · about 1–3 min". */
export function elapsedText(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const time = s >= 60 ? t("efficiency.elapsed.minutes", { m: Math.floor(s / 60), s: s % 60 }) : t("efficiency.elapsed.seconds", { s });
	return t("efficiency.elapsed", { time });
}

/** Parts of a meta line, joined as the language joins them. */
export function metaLine(parts: (string | null | undefined)[]): string {
	return parts.filter((p): p is string => !!p).join(t("efficiency.meta.sep"));
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

/** The message for a failed analysis, or `null` for one the user stopped (nothing to say). */
export function analysisFailureMessage(failure: AnalysisFailure, agent: string): string | null {
	switch (failure.kind) {
		case "cancelled":
			return null;
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

