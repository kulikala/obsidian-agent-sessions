// Token efficiency: the pure half shared by the checks. The types of `agent-sessions json
// efficiency`, the panes, the number checks that keep a model's text to the statistics' numbers,
// the canned text used whenever the model's can't be, a finding's shape, and the request that
// asks an agent to fix one finding. The eight checks and their requests: `efficiency-checks.ts`.
// No `obsidian` import, so tests can load it directly.
//
// The model only chooses words: which hits a finding covers, its impact, its change kind and its
// target files always come from the statistics. A sentence with a number the statistics don't
// have is replaced by the canned one, and `/clear` is never suggested -- switching conversations
// is "start a new conversation in a new tab".

import { t, type MessageKey } from "../i18n";
import { en } from "../i18n/locales/en";
import type { AgentId } from "../settings";
import { formatCost, formatK } from "../usage/usage";
import { windowLabel } from "../views/manager-model";

// ---- `json efficiency` -------------------------------------------------------------------

export type ChangeKind = "add" | "trim" | "move";
export type RemedyKind = "fix" | "habit";

export interface EffWindow {
	used_percentage: number | null;
	end: number | null;
	exhausted: boolean;
}

export interface EffRange {
	rule: string;
	start: number;
	end: number;
	used_percentage: number | null;
	exhausted: boolean;
	budget?: number;
	/** What set a budget range's start: the budget, the one-day minimum, or the 7-day maximum. */
	basis?: "budget" | "min_day" | "max_week";
	windows?: Record<string, EffWindow>;
}

export interface EffTotals {
	calls: number;
	uncached_in: number;
	cache_read: number;
	cache_write: number;
	cache_write_1h: number;
	output: number;
	reasoning: number;
	w: number;
	usd: number | null;
	unpriced_calls: number;
	cache_hit: number | null;
	preamble_median: number | null;
}

export interface EffSession {
	id: string;
	provider?: string;
	name: string | null;
	cwd: string | null;
	folder: string | null;
	calls: number;
	w: number;
	usd: number | null;
}

export interface EffHit {
	id: string;
	detector: string;
	session: string;
	task: string | null;
	ts: number | null;
	metrics: Record<string, unknown>;
	impact_w: number;
	impact_usd: number | null;
	saving_rate: number;
	confidence: string;
	needs_llm: boolean;
	remedy_kind: RemedyKind;
	change: ChangeKind | null;
	targets: string[];
	shown_targets: string[];
	/** E08: the file read at the start of every session (absolute; `metrics.shown_path` masked). */
	read_path?: string;
}

export interface EffQuoteSource {
	ref: string;
	text: string;
}

export interface EffExcerpt {
	task: string;
	session: string;
	provider: string;
	w: number;
	calls: number;
	impact_w: number;
	prompts: (EffQuoteSource & { rework?: number[] })[];
	replies: EffQuoteSource[];
	tools: Record<string, unknown>[];
}

/** What one analysis may send: one provider's sessions of one agent (Claude Code has one pane;
 * Codex and OpenCode one per provider their sessions used). `model` is the model the analysis
 * asks for (`null`: the agent's default), `local` whether that provider runs on this machine. */
export interface EffPane {
	key: string;
	agent: string;
	provider: string;
	model: string | null;
	/** Codex: the models to try in order (strongest listed tier first); `model` is the first. */
	models?: string[];
	local: boolean;
	sessions: number;
	w: number;
	totals: EffTotals;
	breakdown: { cause: string; w: number }[];
	/** The ids of the hits in this pane's sessions. */
	hits: string[];
	summary: Record<string, unknown>;
	excerpts: EffExcerpt[];
}

export interface EffAgent {
	range: EffRange;
	totals: EffTotals;
	sessions: EffSession[];
	breakdown: { cause: string; w: number }[];
	tasks: Record<string, unknown>[];
	hits: EffHit[];
	excerpts: EffExcerpt[];
	baselines: { disabled: string[] } & Record<string, unknown>;
	limits: { truncated: boolean; reason: string | null } & Record<string, unknown>;
	summary: Record<string, unknown>;
	panes?: EffPane[];
}

/** One pane's view of an agent's block: its sessions, hits, totals, breakdown and what it sends;
 * the range and the baselines are the agent's. */
export function paneBlock(block: EffAgent, pane: EffPane): EffAgent {
	const ids = new Set(pane.hits);
	const hits = block.hits.filter((h) => ids.has(h.id));
	const sessions = new Set(hits.map((h) => h.session));
	for (const e of pane.excerpts) {
		sessions.add(e.session);
	}
	return {
		...block,
		totals: pane.totals,
		breakdown: pane.breakdown,
		sessions: block.sessions.filter((s) => (s.provider ? s.provider === pane.provider : sessions.has(s.id))),
		hits,
		excerpts: pane.excerpts,
		summary: pane.summary,
		panes: [pane],
	};
}

/** The panes of an agent's block: its own `panes`, or (an older program) one made of the block. */
export function panesOf(agent: string, block: EffAgent): EffPane[] {
	if (block.panes && block.panes.length > 0) {
		return block.panes;
	}
	return [
		{
			key: agent,
			agent,
			provider: "",
			model: null,
			local: false,
			sessions: block.sessions.length,
			w: block.totals.w,
			totals: block.totals,
			breakdown: block.breakdown,
			hits: block.hits.map((h) => h.id),
			summary: block.summary,
			excerpts: block.excerpts,
		},
	];
}

/** The models an analysis tries, in order (at least one entry; `null` for the agent's default). */
export function analysisModels(pane: Pick<EffPane, "model" | "models">): (string | null)[] {
	return pane.models && pane.models.length > 0 ? pane.models : [pane.model];
}

/** The CLI arguments that make the analysis use the pane's provider and model: Codex `-m` (and
 * `-c model_provider=…` for a provider other than OpenAI), OpenCode `--model provider/model`.
 * Claude Code's model is the "Model for token efficiency" setting (`headlessArgs`). */
export function analysisArgs(pane: Pick<EffPane, "agent" | "provider" | "model">): string[] {
	if (pane.agent === "codex") {
		const args = pane.model ? ["-m", pane.model] : [];
		return pane.provider && pane.provider !== "openai" ? [...args, "-c", `model_provider="${pane.provider}"`] : args;
	}
	if (pane.agent === "opencode" && pane.model) {
		return ["--model", pane.provider ? `${pane.provider}/${pane.model}` : pane.model];
	}
	return [];
}

export interface EffOutput {
	version: number;
	agents: Record<string, EffAgent>;
}

// ---- What is sent ----------------------------------------------------------------------------

/** Estimated tokens of a string: ASCII at 4 characters a token, anything else at 1.5 (the same
 * estimate the statistics use). */
export function estimateTokens(text: string): number {
	let ascii = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 128) {
			ascii++;
		}
	}
	return Math.round(ascii / 4 + (text.length - ascii) / 1.5);
}

/** The usage window to name before sending: the one the range follows, else the first one with
 * a known percentage (5 hours, 7 days, then Codex's other lengths). `null` when none has one. */
export function usageWindow(range: EffRange): { label: string; percent: number } | null {
	const windows = range.windows ?? {};
	const others = Object.keys(windows).filter((k) => k.startsWith("window_"));
	const keys = [range.rule, "five_hour", "seven_day", ...others];
	for (const key of keys) {
		const percent = windows[key]?.used_percentage;
		if (typeof percent !== "number") {
			continue;
		}
		if (key === "five_hour" || key === "seven_day") {
			return { label: t(`efficiency.window.${key}` as MessageKey), percent };
		}
		const minutes = Number(/^window_(\d+)m$/.exec(key)?.[1]);
		return { label: Number.isFinite(minutes) && minutes > 0 ? windowLabel(minutes) : key, percent };
	}
	return null;
}

// ---- A finding ----------------------------------------------------------------------------------

export interface Quote {
	ref: string;
	text: string;
}

/** Why the tokens were spent: how requests were written, the agent's own steps, settings or
 * instruction files, or how conversations and models are used. */
export type Cause = "user_prompt" | "agent_behavior" | "config" | "habit";
export const CAUSES: readonly Cause[] = ["user_prompt", "agent_behavior", "config", "habit"];

/** What a finding offers: start an agent that changes the target files, copy a request template,
 * or nothing beyond the advice. */
export type FixAction = "agent" | "template" | "none";

/** One check's issue: what happened, why, the next step, and what the statistics say about it. */
export interface Finding {
	check: string;
	hits: string[];
	/** What happened, in a few words (the row's line). */
	title: string;
	/** What happened, in a sentence or two. */
	observed: string;
	cause: Cause | "";
	/** The next step. */
	fix: string;
	quotes: Quote[];
	action: FixAction;
	/** For `agent`: the change kind and the files it may change, from the statistics. */
	change: ChangeKind | null;
	targets: string[];
	/** For `agent`: the proposed change. */
	draft: string;
	/** Files the finding is about besides its targets (E08: what sessions keep reading). */
	sources: string[];
	impactW: number;
	impactUsd: number | null;
	/** The tokens fixing it could save at most. */
	savingW: number;
	/** From the statistics alone (canned text), not from the model. */
	fromStats: boolean;
}

/** Thrown for a reply that is not the JSON object asked for (the caller asks once more). */
export class ReplyShapeError extends Error {}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asStr(value: unknown, max?: number): string {
	const s = typeof value === "string" ? value.trim() : "";
	return max ? Array.from(s).slice(0, max).join("") : s;
}

export function asStrList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ---- Numbers the model may write ---------------------------------------------------------------

const NUMBER_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|K|M|B|万|億)?/g;
const SCALE: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 億: 1e8 };

/** The values of the numbers written in `text` that have three or more digits, or are written
 * with a unit (12K, 1.2M, 3万). */
export function numbersIn(text: string): number[] {
	const out: number[] = [];
	for (const m of text.matchAll(NUMBER_RE)) {
		const whole = m[1].replace(/,/g, "");
		const unit = m[3];
		if (!unit && whole.length < 3) {
			continue;
		}
		const value = Number(`${whole}${m[2] ? "." + m[2] : ""}`) * (unit ? SCALE[unit] : 1);
		if (value >= 100) {
			out.push(value);
		}
	}
	return out;
}

/** Every number in what was sent (keys' values, at any depth). */
export function sentNumbers(value: unknown, out: number[] = []): number[] {
	if (typeof value === "number" && Number.isFinite(value)) {
		out.push(Math.abs(value));
	} else if (Array.isArray(value)) {
		for (const v of value) {
			sentNumbers(v, out);
		}
	} else if (value && typeof value === "object") {
		for (const v of Object.values(value)) {
			sentNumbers(v, out);
		}
	}
	return out;
}

function known(value: number, sent: number[]): boolean {
	return sent.some((s) => s > 0 && Math.abs(value - s) <= 0.05 * s);
}

function sentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+|(?<=[。！？])\s*|\n+/).filter((s) => s.trim().length > 0);
}

/** `text` with every sentence that has an unknown number replaced (once) by `canned`. */
export function replaceUnknownNumbers(text: string, sent: number[], canned: string): string {
	let used = false;
	const out: string[] = [];
	for (const s of sentences(text)) {
		if (numbersIn(s).every((n) => known(n, sent))) {
			out.push(s.trim());
		} else if (!used) {
			out.push(canned);
			used = true;
		}
	}
	// CJK sentences follow each other without a space.
	return out.reduce((acc, part) => (acc === "" ? part : /[。！？]$/.test(acc) ? acc + part : `${acc} ${part}`), "");
}

const CLEAR_RE = /\/clear\b/i;

/** Whether `text` mentions the `/clear` command. */
export function mentionsClear(text: string): boolean {
	return CLEAR_RE.test(text);
}


export function normalizeSpace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export function taskOfRef(ref: string): string {
	return ref.replace(/\.[pr]\d+$/, "");
}

// ---- Canned findings (D-13) -------------------------------------------------------------------

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function seconds(value: number): string {
	const minutes = Math.round(value / 60);
	return minutes >= 120
		? t("efficiency.duration.hours", { count: Math.round(minutes / 60) })
		: t("efficiency.duration.minutes", { count: minutes });
}

function fileLabel(hit: EffHit): string {
	return hit.shown_targets[0] ?? hit.targets[0] ?? "";
}

/** The canned title, cause and remedy of a group of hits of one detector, with the statistics'
 * numbers filled in (from the largest hit). */
export function canned(hits: EffHit[]): { title: string; cause: string; remedy: string } {
	const h = [...hits].sort((a, b) => b.impact_w - a.impact_w)[0];
	const m = h.metrics;
	const d = h.detector;
	const vars: Record<string, string | number> = {};
	let remedyKey = `efficiency.detector.${d}.remedy`;
	switch (d) {
		case "E01":
			vars.tokens = formatK(num(m.est_tokens));
			vars.reads = num(m.reads_after);
			if (h.remedy_kind === "fix") {
				remedyKey = "efficiency.detector.E01.remedyFix";
			}
			break;
		case "E02":
			vars.calls = num(m.calls_over);
			vars.threshold = formatK(num(m.threshold));
			vars.max = formatK(num(m.max_ctx));
			break;
		case "E03":
			vars.tasks = num(m.tasks);
			vars.carry = formatK(num(m.carry));
			break;
		case "E04":
			vars.gap = seconds(num(m.gap));
			vars.write = formatK(num(m.cache_write));
			if (h.remedy_kind === "fix") {
				remedyKey = "efficiency.detector.E04.remedyFix";
			}
			break;
		case "E05":
			vars.from = String(m.from ?? "");
			vars.to = String(m.to ?? "");
			vars.write = formatK(num(m.cache_write));
			break;
		case "E08":
			vars.path = String(m.shown_path ?? h.read_path ?? "");
			vars.sessions = num(m.sessions);
			vars.tokens = formatK(num(m.est_tokens));
			if (h.remedy_kind === "fix") {
				remedyKey = "efficiency.detector.E08.remedyFix";
			}
			break;
		case "E14":
			vars.preamble = formatK(num(m.preamble));
			vars.excess = formatK(num(m.excess));
			vars.baseline = formatK(num(m.baseline));
			vars.lines = num(m.long_file_lines);
			vars.skills = num(m.skills);
			if (h.remedy_kind === "fix") {
				remedyKey = "efficiency.detector.E14.remedyMove";
			} else if (m.many_skills) {
				remedyKey = "efficiency.detector.E14.remedySkills";
			}
			break;
		case "E16":
			vars.corrections = num(m.corrections);
			vars.calls = num(m.calls);
			vars.ratio = (num(m.calls_ratio) || 0).toFixed(1);
			break;
		case "E17":
			vars.calls = num(m.calls);
			break;
	}
	vars.file = fileLabel(h);
	const has = (key: string): key is MessageKey => key in en;
	return {
		title: has(`efficiency.detector.${d}.title`) ? t(`efficiency.detector.${d}.title` as MessageKey, vars) : d,
		cause: has(`efficiency.detector.${d}.cause`) ? t(`efficiency.detector.${d}.cause` as MessageKey, vars) : "",
		remedy: has(remedyKey) ? t(remedyKey as MessageKey, vars) : "",
	};
}

/** Impact, dollars and estimated saving of a set of hits, recomputed from the statistics (D-7). */
export function impactOf(hits: EffHit[]): { impactW: number; impactUsd: number | null; effectW: number } {
	let impactW = 0;
	let effectW = 0;
	let usd: number | null = null;
	for (const h of hits) {
		impactW += h.impact_w;
		effectW += h.impact_w * h.saving_rate;
		if (typeof h.impact_usd === "number") {
			usd = (usd ?? 0) + h.impact_usd;
		}
	}
	return { impactW, impactUsd: usd, effectW: Math.round(effectW) };
}

/** The change an agent may make for these hits: only when every hit is a `fix` with the same
 * change and targets; `null` otherwise. */
export function statsChange(hits: EffHit[]): { change: ChangeKind; targets: string[] } | null {
	const first = hits[0];
	if (!first || !first.change) {
		return null;
	}
	const same = hits.every((h) => h.remedy_kind === "fix" && h.change === first.change && sameList(h.targets, first.targets));
	return same && first.targets.length > 0 ? { change: first.change, targets: [...first.targets] } : null;
}

export function sourcesOf(hits: EffHit[]): string[] {
	return [...new Set(hits.map((h) => h.read_path).filter((p): p is string => !!p))];
}

function sameList(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The cause the statistics alone point to, by detector. */
export function defaultCause(hits: EffHit[]): Cause {
	switch (hits[0]?.detector) {
		case "E01":
			return "agent_behavior";
		case "E14":
			return "config";
		case "E16":
		case "E17":
			return "user_prompt";
		case "E04":
		case "E08":
			return statsChange(hits) ? "config" : "habit";
		default:
			return "habit";
	}
}

/** One check's issue from the statistics alone (canned text), for a reply that couldn't be read. */
export function statFinding(check: string, hits: EffHit[], template: boolean): Finding {
	const text = canned(hits);
	const change = statsChange(hits);
	const impact = impactOf(hits);
	return {
		check,
		hits: hits.map((h) => h.id),
		title: text.title,
		observed: text.cause,
		cause: defaultCause(hits),
		fix: text.remedy,
		quotes: [],
		action: change ? "agent" : template ? "template" : "none",
		change: change?.change ?? null,
		targets: change?.targets ?? [],
		draft: "",
		sources: sourcesOf(hits),
		impactW: impact.impactW,
		impactUsd: impact.impactUsd,
		savingW: impact.effectW,
		fromStats: true,
	};
}

// ---- Asking an agent to fix one finding (D-12) ------------------------------------------------

export const MAX_LINES: Record<ChangeKind, number> = { add: 40, trim: 120, move: 120 };

/** The new session's name: "Token efficiency: <title>". */
export function fixSessionName(finding: Pick<Finding, "title">): string {
	return t("efficiency.fix.sessionName", { title: finding.title });
}

/** The estimated saving as text ("up to about 1.2M weighted tokens ($3.40)"). */
export function effectText(finding: Pick<Finding, "savingW" | "impactUsd" | "impactW">): string {
	const usd =
		finding.impactUsd !== null && finding.impactW > 0 ? (finding.impactUsd * finding.savingW) / finding.impactW : null;
	return usd !== null
		? t("efficiency.fix.effectUsd", { tokens: formatK(finding.savingW), usd: formatCost(usd) })
		: t("efficiency.fix.effect", { tokens: formatK(finding.savingW) });
}

/**
 * The request that starts the fixing session, in the UI language: the finding, the files that may
 * change (with the change kind), the proposed change, and how to proceed -- stop at a diff and wait
 * for approval, the change kind's own paragraph, the prohibitions, how to undo, and that the change
 * applies to new conversations. `null` for a finding an agent can't fix.
 */
export function fixPrompt(finding: Finding, evidence: string[], agent: AgentId = "claude"): string | null {
	const change = finding.change;
	if (finding.action !== "agent" || !change || finding.targets.length === 0) {
		return null;
	}
	const targets = finding.targets.slice(0, 2);
	const lines = [
		t("efficiency.fix.prompt.intro"),
		"",
		t("efficiency.fix.prompt.finding", { title: finding.title }),
		t("efficiency.fix.prompt.cause", { cause: finding.observed }),
		t("efficiency.fix.prompt.evidence"),
		...evidence.slice(0, 3).map((e) => `- ${e}`),
		t("efficiency.fix.prompt.effect", { effect: effectText(finding) }),
		"",
		t("efficiency.fix.prompt.targets"),
		...targets.map((path, i) =>
			t("efficiency.fix.prompt.target", {
				path,
				change: change === "move" ? t(i === 0 ? "efficiency.fix.moveFrom" : "efficiency.fix.moveTo") : t(`efficiency.change.${change}`),
			})
		),
		...(finding.sources.length > 0 ? [t("efficiency.fix.prompt.sources"), ...finding.sources.slice(0, 3).map((p) => `- ${p}`)] : []),
		t("efficiency.fix.prompt.draft"),
		finding.draft || finding.fix,
		"",
		t("efficiency.fix.prompt.steps"),
		t("efficiency.fix.prompt.step1"),
		t("efficiency.fix.prompt.step2", { max_lines: MAX_LINES[change] }),
		t(`efficiency.fix.prompt.${change}`),
		t(agent === "codex" ? "efficiency.fix.prompt.step3Codex" : agent === "opencode" ? "efficiency.fix.prompt.step3Opencode" : "efficiency.fix.prompt.step3"),
		"",
		t("efficiency.fix.prompt.rules"),
		t("efficiency.fix.prompt.rule1"),
		t("efficiency.fix.prompt.rule2"),
		t("efficiency.fix.prompt.rule3"),
		"",
		t("efficiency.fix.prompt.finally"),
		t("efficiency.fix.prompt.newConversation"),
	];
	return lines.join("\n");
}

/** The request template for a clearer prompt (repeated fixes, the first request), copied with
 * "Copy a request template". */
export function requestTemplate(): string {
	return t("efficiency.template");
}
