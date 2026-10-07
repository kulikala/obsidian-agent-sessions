// "Analyze token efficiency": runs `json efficiency` (local, nothing sent), shows the range, the
// totals, the breakdown and the statistics' own findings, and -- only when the user presses
// Analyze in a pane -- sends that pane's masked summary and excerpts to the same agent and provider
// (`claude -p`, `codex exec`, `opencode run`, in a fresh empty folder), checks the reply
// (`sessions/efficiency.ts`) and shows the findings as cards. There is one pane per agent, and for
// Codex and OpenCode one per provider their conversations used, so a conversation is only ever
// analysed where it was held. A pane shows one status band at the top, the three steps (read the
// records, analyse in detail, results and next steps) and a section for each. A `fix` card can
// start a session in the vault, in plan mode (or the agent's nearest), with the request shown and
// editable first. States, failures and what the band and the list's heading say:
// `efficiency-view.ts`. The last result per pane is saved under `<runtime>/efficiency/` and shown
// again next time.

import { Modal, Notice, Platform, Setting, setIcon, setTooltip } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { efficiency, loginEnv, resolveAgentBinary, withBinDirOnPath } from "../backend/backend";
import { runHeadless } from "../backend/headless";
import { efficiencyDir, efficiencyRunDir } from "../backend/paths";
import { inRunFolder } from "../backend/run-folder";
import { getLang, t, type MessageKey } from "../i18n";
import { formatDateTimeShort } from "../i18n/datetime";
import { en } from "../i18n/locales/en";
import {
	analysisArgs,
	analysisModels,
	analysisPrompt,
	candidates,
	estimateTokens,
	fixPrompt,
	fixSessionName,
	effectText,
	paneBlock,
	panesOf,
	payloadOf,
	rangeLine,
	requestTemplate,
	runAnalysis,
	statFindings,
	usageWindow,
	type EffAgent,
	type EffHit,
	type EffOutput,
	type EffPane,
	type Finding,
} from "../sessions/efficiency";
import { detectorMetrics, loadResult, overlaps, payloadHash, saveResult, type SavedResult } from "../sessions/efficiency-store";
import { usedTools, type HeadlessUsage } from "../sessions/organize-agent";
import { sessionDisplayName } from "../sessions/name";
import { parseEnvLines, type AgentId } from "../settings";
import { formatCost, formatK, formatNumber } from "../usage/usage";
import {
	analysisFailureMessage,
	band,
	modelUnavailable,
	classifyAnalysisFailure,
	classifyStatsFailure,
	hasData,
	initialState,
	listHeading,
	listSource,
	retryHelps,
	statsFailureMessage,
	steps,
	transition,
	type Band,
	type DialogEvent,
	type DialogState,
	type StepState,
} from "./efficiency-view";

const ANALYSIS_TIMEOUT_MS = 300_000;
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const AGENTS: AgentId[] = ["claude", "codex", "opencode"];
/** Detectors whose advice is a request template the user can copy. */
const TEMPLATE_DETECTORS = new Set(["E16", "E17"]);
const STEP_KEYS = [
	["efficiency.step.stats", "efficiency.step.statsDesc"],
	["efficiency.step.analyze", "efficiency.step.analyzeDesc"],
	["efficiency.step.result", "efficiency.step.resultDesc"],
] as const satisfies readonly (readonly [MessageKey, MessageKey])[];

/** The status band: its text, and the Cancel button shown while an analysis runs. */
interface BandView {
	el: HTMLElement;
	textEl: HTMLElement;
	/** The live region: only what screen readers should hear, set when the state changes. */
	liveEl: HTMLElement;
	cancel: HTMLButtonElement;
}

/** One analysis that produced findings: when, on which model, and what it used. */
interface Run {
	at: number;
	model: string;
	usage: HeadlessUsage | null;
}

interface Pane {
	/** `claude`, or `<agent>-<provider>`: the dialog state, the saved result and the tab. */
	key: string;
	agent: AgentId;
	info: EffPane;
	/** The model the last analysis ran on, when Codex refused the first choice. */
	usedModel?: string | null;
	block: EffAgent;
	payload: string;
	prompt: string;
	el: HTMLElement;
	tab: HTMLElement | null;
	band: BandView;
	stepsEl: HTMLElement;
	sections: HTMLElement[];
	consentEl: HTMLElement;
	logDetails: HTMLElement;
	logEl: HTMLElement;
	listEl: HTMLElement;
	findings: Finding[];
	/** The saved result shown when no analysis ran in this dialog (or the last one failed). */
	previous: SavedResult | null;
	/** The analysis made in this dialog whose findings are shown. */
	lastRun: Run | null;
	/** Why the last analysis failed or stopped, until the next one starts. */
	error: { text: string; retry: boolean } | null;
	toolUsed: boolean;
	started: number;
	received: number;
	abort: AbortController | null;
	ticker: number | null;
}

export class EfficiencyModal extends Modal {
	private state: DialogState = initialState();
	private panes = new Map<string, Pane>();
	private bodyEl!: HTMLElement;
	private tabsEl: HTMLElement | null = null;
	private ticker: number | null = null;

	constructor(private plugin: AgentSessionsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-efficiency");
		this.setTitle(t("action.analyzeEfficiency"));
		this.bodyEl = this.contentEl.createDiv({ cls: "agent-sessions-efficiency-body" });
		void this.loadStats();
	}

	onClose(): void {
		for (const pane of this.panes.values()) {
			pane.abort?.abort();
			this.stopPaneTicker(pane);
		}
		this.stopTicker();
		this.contentEl.empty();
	}

	private dispatch(event: DialogEvent): void {
		this.state = transition(this.state, event);
	}

	// ---- Statistics ------------------------------------------------------------------------

	private async loadStats(): Promise<void> {
		this.dispatch({ type: "restart" });
		this.bodyEl.empty();
		this.panes.clear();
		this.tabsEl = null;
		// Until there are panes, one stand-in pane shows the band and the steps.
		const shell = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-pane" });
		const bandView = createBand(shell);
		renderSteps(shell.createEl("ol", { cls: "agent-sessions-efficiency-steps" }), steps("stats", undefined, "stats"));
		const started = Date.now();
		const tick = (): void => setBand(bandView, band({ overall: "stats", seconds: Math.floor((Date.now() - started) / 1000) }));
		tick();
		this.ticker = window.setInterval(tick, 1000);
		const s = this.plugin.settings;
		let out: EffOutput;
		try {
			if (!this.plugin.backendAvailable()) {
				throw new Error("not installed");
			}
			out = (await efficiency(this.plugin.agentSessionsPath(), this.plugin.vaultPath(), {
				agents: AGENTS.filter((a) => s.agents[a]?.enabled),
				threshold: s.efficiencyThreshold,
				budget: s.efficiencyBudget,
			})) as EffOutput;
		} catch (err) {
			this.stopTicker();
			this.dispatch({ type: "statsFailed" });
			this.showStatsFailure(shell, bandView, err);
			return;
		}
		this.stopTicker();
		shell.remove();
		const agents = AGENTS.filter((a) => out.agents?.[a] && s.agents[a]?.enabled);
		const panes = agents.flatMap((agent) => panesOf(agent, out.agents[agent]).map((info) => ({ agent, info })));
		this.dispatch({ type: "statsDone", agents: panes.map((p) => p.info.key) });
		if (panes.length === 0) {
			const empty = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-pane" });
			setBand(createBand(empty), band({ overall: "ready", hasData: false }));
			return;
		}
		if (panes.length > 1) {
			this.tabsEl = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-tabs", attr: { role: "tablist" } });
		}
		for (const { agent, info } of panes) {
			this.buildPane(agent, info, paneBlock(out.agents[agent], info));
		}
		this.selectPane(panes[0].info.key);
	}

	/** Shows one pane; the tab row (two panes or more) marks it. */
	private selectPane(key: string): void {
		for (const pane of this.panes.values()) {
			const selected = pane.key === key;
			pane.el.toggle(selected);
			pane.tab?.toggleClass("is-active", selected);
			pane.tab?.setAttribute("aria-selected", String(selected));
		}
	}

	private paneName(pane: Pick<Pane, "agent" | "info">): string {
		const name = AGENT_NAMES[pane.agent] ?? pane.agent;
		return pane.agent === "claude" || !pane.info.provider ? name : t("efficiency.tabProvider", { agent: name, provider: pane.info.provider });
	}

	/** The model the analysis uses, as shown before sending. */
	private modelName(pane: Pane): string {
		if (pane.agent === "claude") {
			return this.plugin.settings.efficiencyModel;
		}
		return pane.usedModel ?? pane.info.model ?? t("efficiency.defaultModel");
	}

	private stopTicker(): void {
		if (this.ticker !== null) {
			window.clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	private showStatsFailure(shell: HTMLElement, bandView: BandView, err: unknown): void {
		const kind = classifyStatsFailure(err, this.plugin.backendAvailable());
		const error = err instanceof Error ? err.message : String(err);
		setBand(bandView, band({ overall: "failed", error: { text: statsFailureMessage(kind, error), retry: false } }));
		renderSteps(shell.querySelector<HTMLElement>(".agent-sessions-efficiency-steps") ?? shell.createEl("ol"), steps("failed", undefined, "stats"));
		if (kind === "stats") {
			actionButton(bandView.el, t("efficiency.error.retry"), false).addEventListener("click", () => void this.loadStats());
		} else {
			actionButton(bandView.el, t(kind === "noProgram" ? "efficiency.error.install" : "efficiency.error.update"), true).addEventListener("click", () => {
				this.close();
				this.plugin.openInstallBackend();
			});
		}
	}

	// ---- One agent's pane ------------------------------------------------------------------

	private buildPane(agent: AgentId, info: EffPane, block: EffAgent): void {
		const el = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-pane" });
		const name = this.paneName({ agent, info });
		let tab: HTMLElement | null = null;
		if (this.tabsEl) {
			tab = this.tabsEl.createEl("button", { cls: "agent-sessions-efficiency-tab", attr: { role: "tab" } });
			tab.createSpan({ text: name });
			tab.createSpan({ cls: "agent-sessions-efficiency-tab-mark" });
			tab.addEventListener("click", () => this.selectPane(info.key));
		}
		const payload = payloadOf(block);
		const pane: Pane = {
			key: info.key,
			agent,
			info,
			block,
			payload,
			prompt: analysisPrompt(payload, getLang()),
			el,
			tab,
			band: createBand(el),
			stepsEl: el.createEl("ol", { cls: "agent-sessions-efficiency-steps" }),
			sections: [],
			consentEl: createDiv(),
			logDetails: createDiv(),
			logEl: createDiv(),
			listEl: createDiv(),
			findings: statFindings(block.hits),
			previous: null,
			lastRun: null,
			error: null,
			toolUsed: false,
			started: Date.now(),
			received: 0,
			abort: null,
			ticker: null,
		};
		pane.band.cancel.addEventListener("click", () => pane.abort?.abort());
		this.panes.set(info.key, pane);
		if (!hasData(block)) {
			pane.stepsEl.remove();
			this.renderBand(pane);
			return;
		}
		const stats = this.section(pane, 0);
		stats.createDiv({ cls: "agent-sessions-efficiency-range", text: rangeLine(name, block) });
		if (block.limits.truncated) {
			stats.createDiv({
				cls: "agent-sessions-efficiency-note",
				text:
					block.limits.reason === "max_bytes"
						? t("efficiency.range.truncatedBytes")
						: t("efficiency.range.truncated", { count: Number(block.limits.sessions_read ?? 200) }),
			});
		}
		if (block.baselines.disabled.length > 0) {
			stats.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.limited") });
		}
		this.renderTotals(pane, stats);
		const analyze = this.section(pane, 1);
		pane.consentEl = analyze.createDiv({ cls: "agent-sessions-efficiency-consent" });
		pane.logDetails = analyze.createEl("details", { cls: "agent-sessions-efficiency-logdetails" });
		pane.logDetails.createEl("summary", { text: t("efficiency.showLog") });
		pane.logEl = pane.logDetails.createDiv({ cls: "agent-sessions-organize-log" });
		pane.listEl = this.section(pane, 2);
		const saved = loadResult(efficiencyDir(), info.key);
		if (saved && overlaps(saved, block.range)) {
			pane.previous = saved;
		}
		this.renderPane(pane);
	}

	/** Step `index`'s section: its number, name and what it does, then its content. */
	private section(pane: Pane, index: number): HTMLElement {
		const [nameKey, descKey] = STEP_KEYS[index];
		const el = pane.el.createDiv({ cls: "agent-sessions-efficiency-section" });
		const head = el.createDiv({ cls: "agent-sessions-efficiency-section-head" });
		head.createSpan({ cls: "agent-sessions-efficiency-step-num", text: String(index + 1) });
		head.createSpan({ cls: "agent-sessions-efficiency-section-name", text: t(nameKey) });
		el.createDiv({ cls: "agent-sessions-efficiency-section-desc", text: t(descKey) });
		pane.sections.push(el);
		return el;
	}

	/** Everything that follows the pane's state: the band, the steps, the tab's mark, the consent
	 * and the list. */
	private renderPane(pane: Pane): void {
		this.renderBand(pane);
		const pstate = this.state.panes[pane.key] ?? "idle";
		const marks = steps(this.state.overall, pstate, listSource(pstate, pane.previous !== null));
		renderSteps(pane.stepsEl, marks, (i) => pane.sections[i]?.scrollIntoView({ block: "start", behavior: "smooth" }));
		pane.sections.forEach((s, i) => s.toggleClass("is-current", marks[i] === "busy" || marks[i] === "current"));
		this.renderTab(pane);
		this.renderConsent(pane);
		this.renderFindings(pane);
	}

	private renderBand(pane: Pane): void {
		const pstate = this.state.panes[pane.key] ?? "idle";
		const source = listSource(pstate, pane.previous !== null);
		setBand(
			pane.band,
			band({
				overall: this.state.overall,
				pane: pstate,
				agent: this.paneName(pane),
				seconds: Math.floor((Date.now() - pane.started) / 1000),
				chars: pane.received,
				hasData: hasData(pane.block),
				analysable: pane.block.excerpts.length > 0 || pane.block.hits.length > 0,
				statCount: statFindings(pane.block.hits).length,
				resultCount: pane.findings.length,
				previousAt: source === "previous" && pane.previous ? pane.previous.savedAt : null,
				toolUsed: pane.toolUsed,
				error: pane.error,
			})
		);
	}

	/** The tab's mark: a pulsing dot while analysing, a check when done, an alert when failed. */
	private renderTab(pane: Pane): void {
		const mark = pane.tab?.querySelector<HTMLElement>(".agent-sessions-efficiency-tab-mark");
		if (!pane.tab || !mark) {
			return;
		}
		const pstate = this.state.panes[pane.key] ?? "idle";
		mark.empty();
		mark.className = `agent-sessions-efficiency-tab-mark is-${pstate}`;
		if (pstate === "result") {
			setIcon(mark, "check");
		} else if (pstate === "failed") {
			setIcon(mark, "alert-circle");
		}
		const label = pstate === "idle" ? "" : t(`efficiency.tabState.${pstate}`);
		pane.tab.setAttribute("aria-label", label ? `${this.paneName(pane)} — ${label}` : this.paneName(pane));
	}

	private renderTotals(pane: Pane, parent: HTMLElement): void {
		const tot = pane.block.totals;
		const grid = parent.createDiv({ cls: "agent-sessions-efficiency-totals" });
		const item = (label: string, value: string): HTMLElement => {
			const cell = grid.createDiv({ cls: "agent-sessions-efficiency-total" });
			cell.createDiv({ cls: "agent-sessions-efficiency-total-value", text: value });
			cell.createDiv({ cls: "agent-sessions-efficiency-total-label", text: label });
			return cell;
		};
		setTooltip(item(t("efficiency.totals.w"), formatK(tot.w)), t("efficiency.help.weighted"));
		if (typeof tot.usd === "number") {
			item(t("efficiency.totals.usd"), t("efficiency.totals.usdValue", { usd: formatCost(tot.usd) }));
		}
		if (typeof tot.cache_hit === "number") {
			item(t("efficiency.totals.cacheHit"), `${Math.round(tot.cache_hit * 100)}%`);
		}
		item(t("efficiency.totals.calls"), formatNumber(tot.calls));
		if (typeof tot.preamble_median === "number") {
			item(t("efficiency.totals.preamble"), formatK(tot.preamble_median));
		}
		const breakdown = parent.createDiv({ cls: "agent-sessions-efficiency-breakdown" });
		breakdown.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.breakdown.title") });
		const total = Math.max(tot.w, 1);
		for (const entry of pane.block.breakdown) {
			const row = breakdown.createDiv({ cls: "agent-sessions-efficiency-bar-row" });
			row.createSpan({ cls: "agent-sessions-efficiency-bar-label", text: this.causeLabel(entry.cause) });
			const bar = row.createDiv({ cls: "agent-sessions-efficiency-bar" });
			bar.createDiv({ cls: "agent-sessions-efficiency-bar-fill" }).style.width = `${Math.min(100, (entry.w / total) * 100)}%`;
			row.createSpan({ cls: "agent-sessions-efficiency-bar-value", text: formatK(entry.w) });
		}
	}

	private causeLabel(cause: string): string {
		if (cause === "other") {
			return t("efficiency.breakdown.other");
		}
		if (cause === "team") {
			return t("efficiency.breakdown.team");
		}
		const key = `efficiency.detector.${cause}.title`;
		return this.hasKey(key) ? t(key as MessageKey) : cause;
	}

	private hasKey(key: string): boolean {
		return key in en;
	}

	/** The run whose findings are shown (this dialog's, or the saved one), or null for the
	 * statistics' own. */
	private shownRun(pane: Pane): Run | null {
		const source = listSource(this.state.panes[pane.key] ?? "idle", pane.previous !== null);
		if (source === "llm") {
			return pane.lastRun;
		}
		if (source === "previous" && pane.previous) {
			return { at: pane.previous.savedAt, model: pane.previous.model, usage: pane.previous.selfCost };
		}
		return null;
	}

	/** What Analyze sends and what it gives. Once a result is shown it folds into one line, and
	 * Analyze again becomes a plain button. */
	private renderConsent(pane: Pane): void {
		const el = pane.consentEl;
		el.empty();
		const block = pane.block;
		pane.logDetails.toggle(pane.logEl.childElementCount > 0);
		if (block.excerpts.length === 0 && block.hits.length === 0) {
			el.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.consent.nothing") });
			return;
		}
		const run = this.shownRun(pane);
		el.toggleClass("is-folded", run !== null);
		let body = el;
		if (run) {
			const folded = el.createEl("details", { cls: "agent-sessions-efficiency-consent-folded" });
			const date = formatDateTimeShort(run.at, getLang());
			folded.createEl("summary", {
				text: run.usage
					? t("efficiency.consent.summary", { model: run.model, date, input: formatK(run.usage.input), output: formatK(run.usage.output) })
					: t("efficiency.consent.summaryNoUsage", { model: run.model, date }),
			});
			body = folded.createDiv({ cls: "agent-sessions-efficiency-consent-body" });
		}
		body.createDiv({ cls: "agent-sessions-efficiency-consent-lead", text: t("efficiency.consent.lead") });
		const facts = body.createDiv({ cls: "agent-sessions-efficiency-facts" });
		const fact = (label: string, value: string): void => {
			facts.createDiv({ cls: "agent-sessions-efficiency-fact-label", text: label });
			facts.createDiv({ cls: "agent-sessions-efficiency-fact-value", text: value });
		};
		const name = this.paneName(pane);
		const local = pane.info.local;
		// A local provider's model reads it on this machine: nothing goes to a service.
		fact(
			t("efficiency.consent.toLabel"),
			local ? t("efficiency.consent.toValueLocal", { model: this.modelName(pane) }) : t("efficiency.consent.toValue", { agent: name, model: this.modelName(pane) })
		);
		fact(
			t(local ? "efficiency.consent.whatLabelLocal" : "efficiency.consent.whatLabel"),
			t("efficiency.consent.whatValue", {
				sessions: new Set(block.excerpts.map((e) => e.session)).size,
				chars: pane.prompt.length.toLocaleString(getLang()),
				tokens: formatK(estimateTokens(pane.prompt)),
			})
		);
		const usage = usageWindow(block.range);
		if (usage) {
			fact(t("efficiency.consent.usageLabel"), t("efficiency.consent.usageValue", { window: usage.label.trim(), percent: Math.round(usage.percent) }));
		}
		const waiting = Object.entries(candidates(block.hits)).filter(([d]) => this.hasKey(`efficiency.candidate.${d}`));
		if (waiting.length > 0) {
			fact(
				t("efficiency.consent.candidatesLabel"),
				waiting.map(([d, count]) => t(`efficiency.candidate.${d}` as MessageKey, { count })).join(t("efficiency.listSeparator"))
			);
		}
		body.createDiv({
			cls: "agent-sessions-efficiency-note",
			text: local ? t("efficiency.consent.noteLocal") : t("efficiency.consent.noteService", { agent: name }),
		});
		if (pane.previous && pane.previous.payloadHash === payloadHash(pane.payload)) {
			body.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.sameAsPrevious") });
		}
		const details = body.createEl("details", { cls: "agent-sessions-efficiency-preview" });
		details.createEl("summary", { text: t("efficiency.consent.preview") });
		details.createEl("pre", { text: pane.prompt });
		const send = actionButton(el, t(run ? "efficiency.consent.again" : "efficiency.consent.send"), !run);
		send.disabled = this.state.panes[pane.key] === "working";
		send.addEventListener("click", () => void this.analyze(pane));
	}

	// ---- Analysis --------------------------------------------------------------------------

	private log(pane: Pane, text: string, isError = false): void {
		const line = pane.logEl.createDiv({ cls: "agent-sessions-organize-log-line" });
		if (isError) {
			line.addClass("is-error");
		}
		const now = new Date();
		line.createSpan({
			cls: "agent-sessions-organize-log-time",
			text: [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"),
		});
		line.createSpan({ text });
	}

	private stopPaneTicker(pane: Pane): void {
		if (pane.ticker !== null) {
			window.clearInterval(pane.ticker);
			pane.ticker = null;
		}
	}

	private async analyze(pane: Pane): Promise<void> {
		this.dispatch({ type: "start", agent: pane.key });
		const abort = new AbortController();
		pane.abort = abort;
		pane.error = null;
		pane.toolUsed = false;
		pane.received = 0;
		pane.started = Date.now();
		pane.logEl.empty();
		const name = this.paneName(pane);
		this.log(pane, t("efficiency.log.asked", { agent: name }));
		this.renderPane(pane);
		pane.ticker = window.setInterval(() => this.renderBand(pane), 1000);
		let succeeded = false;
		try {
			const agent = pane.agent;
			const settings = this.plugin.settings.agents[agent];
			const bin = await resolveAgentBinary(agent, settings.path, Platform.isMacOS).catch((err: Error) => {
				// Not found on this machine: the same failure as a spawn that can't find it.
				throw Object.assign(new Error(err.message), { code: "ENOENT" });
			});
			const env = withBinDirOnPath(
				{
					...process.env,
					...(await loginEnv(Platform.isMacOS).catch((): Record<string, string> => ({}))),
					...parseEnvLines(settings.env),
				},
				bin
			);
			let tools = false;
			// Codex: the strongest model Codex lists first; one it refuses as unavailable gives way
			// to the next (the choice then stays for the retry and the saved result).
			const models = analysisModels(pane.info);
			let current = 0;
			pane.usedModel = null;
			const runWith = (prompt: string, model: string | null) =>
				inRunFolder(efficiencyRunDir(), (cwd) =>
					runHeadless({
						agent,
						bin,
						env,
						cwd,
						prompt,
						model: this.plugin.settings.efficiencyModel,
						extraArgs: analysisArgs({ ...pane.info, model }),
						timeoutMs: ANALYSIS_TIMEOUT_MS,
						signal: abort.signal,
						onProgress: (chars) => (pane.received = chars),
					})
				);
			const outcome = await runAnalysis(pane.prompt, pane.block, async (prompt) => {
				for (;;) {
					try {
						const run = await runWith(prompt, models[current]);
						tools = tools || usedTools(agent, run.stdout);
						return run;
					} catch (err) {
						if (current + 1 >= models.length || abort.signal.aborted || !modelUnavailable(err)) {
							throw err;
						}
						this.log(pane, t("efficiency.log.modelUnavailable", { model: models[current] ?? "", next: models[current + 1] ?? "" }));
						current += 1;
						pane.usedModel = models[current];
					}
				}
			});
			if (tools) {
				this.log(pane, t("efficiency.toolUsed"), true);
				pane.toolUsed = true;
			}
			if (outcome.retried) {
				this.log(pane, t("efficiency.log.retried", { error: outcome.retried }));
			}
			if (!outcome.result) {
				this.log(pane, this.costText(pane, outcome.usage));
				this.log(pane, t("efficiency.error.badReply"), true);
				this.dispatch({ type: "failed", agent: pane.key });
				pane.error = { text: t("efficiency.error.badReply"), retry: true };
				return;
			}
			for (const note of outcome.result.notes) {
				this.log(pane, t("efficiency.log.removed", { note }));
			}
			this.log(
				pane,
				t("efficiency.log.received", {
					count: outcome.result.findings.filter((f) => !f.fromStats).length,
					seconds: Math.round((Date.now() - pane.started) / 1000),
				})
			);
			pane.findings = outcome.result.findings;
			pane.lastRun = { at: Date.now() / 1000, model: this.modelName(pane), usage: outcome.usage };
			this.dispatch({ type: "succeeded", agent: pane.key });
			this.save(pane, outcome.result.findings, outcome.result.dismissed, outcome.usage);
			succeeded = true;
		} catch (err) {
			const failure = classifyAnalysisFailure(err, abort.signal.aborted);
			this.dispatch({ type: failure.kind === "cancelled" ? "cancelled" : "failed", agent: pane.key });
			this.log(pane, failure.kind === "cancelled" ? t("efficiency.log.cancelled") : t("efficiency.log.failed", { error: String((err as Error)?.message ?? err) }), failure.kind !== "cancelled");
			pane.error = { text: analysisFailureMessage(failure, name), retry: retryHelps(failure) };
		} finally {
			this.stopPaneTicker(pane);
			pane.abort = null;
			this.renderPane(pane);
		}
		if (succeeded && pane.el.isShown()) {
			pane.listEl.scrollIntoView({ block: "start", behavior: "smooth" });
		}
	}

	/** What the analysis itself used, and whose usage limits it counts toward. */
	private costText(pane: Pane, usage: HeadlessUsage | null): string {
		if (!usage) {
			return t("efficiency.selfCostUnknown");
		}
		const params = { input: formatK(usage.input), output: formatK(usage.output), agent: this.paneName(pane) };
		if (pane.info.local) {
			return t("efficiency.selfCostLocal", params);
		}
		return usage.usd !== null ? t("efficiency.selfCost", { ...params, usd: formatCost(usage.usd) }) : t("efficiency.selfCostNoUsd", params);
	}

	private save(pane: Pane, findings: Finding[], dismissed: SavedResult["dismissed"], usage: HeadlessUsage | null): void {
		const result: SavedResult = {
			version: 1,
			agent: pane.key,
			savedAt: pane.lastRun?.at ?? Date.now() / 1000,
			model: this.modelName(pane),
			range: pane.block.range,
			totals: pane.block.totals,
			hits: pane.block.hits,
			findings,
			dismissed,
			selfCost: usage,
			payloadHash: payloadHash(pane.payload),
			metrics: detectorMetrics(pane.block.hits),
		};
		// A later failed or cancelled run in this dialog falls back to this result.
		pane.previous = result;
		try {
			saveResult(efficiencyDir(), result);
		} catch (err) {
			this.log(pane, t("efficiency.log.failed", { error: (err as Error).message }), true);
		}
	}

	// ---- Findings ----------------------------------------------------------------------------

	/** The list, under a heading that says where it comes from (and, for an analysis, its cost).
	 * While an analysis runs, the statistics' findings are dimmed and can't be used. */
	private renderFindings(pane: Pane): void {
		const el = pane.listEl;
		el.querySelector(".agent-sessions-efficiency-list")?.remove();
		const list = el.createDiv({ cls: "agent-sessions-efficiency-list" });
		const pstate = this.state.panes[pane.key] ?? "idle";
		const run = this.shownRun(pane);
		const heading = listHeading(pstate, pane.previous, pane.lastRun);
		const head = list.createDiv({ cls: "agent-sessions-efficiency-list-head" });
		head.createDiv({ cls: "agent-sessions-efficiency-list-title", text: heading.text });
		if (run) {
			head.createDiv({ cls: "agent-sessions-efficiency-cost", text: this.costText(pane, run.usage) });
		}
		const findings = heading.source === "llm" ? pane.findings : heading.source === "previous" && pane.previous ? pane.previous.findings : statFindings(pane.block.hits);
		const cards = list.createDiv({ cls: "agent-sessions-efficiency-cards" });
		if (heading.busy) {
			cards.addClass("is-busy");
			cards.setAttribute("inert", "");
			cards.setAttribute("aria-busy", "true");
		}
		if (findings.length === 0) {
			cards.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.card.none") });
			return;
		}
		const hits = new Map((heading.source === "previous" && pane.previous ? pane.previous.hits : pane.block.hits).map((h) => [h.id, h]));
		for (const f of findings) {
			this.renderCard(cards, pane, f, hits);
		}
	}

	private sessionLabel(id: string, block: EffAgent): string {
		const row = this.plugin.index.sessions.get(id);
		if (row) {
			return sessionDisplayName(row);
		}
		return block.sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);
	}

	/** A finding: what happened, its impact, the cause, the next step, the proposed change, the
	 * evidence (folded) and the buttons. */
	private renderCard(parent: HTMLElement, pane: Pane, f: Finding, hits: Map<string, EffHit>): void {
		const card = parent.createDiv({ cls: "agent-sessions-efficiency-card" });
		const head = card.createDiv({ cls: "agent-sessions-efficiency-card-head" });
		head.createSpan({ cls: "agent-sessions-efficiency-card-title", text: f.title });
		if (f.fromStats) {
			head.createSpan({ cls: "agent-sessions-efficiency-badge", text: t("efficiency.card.fromStats") });
		}
		const share = pane.block.totals.w > 0 ? Math.round((f.impactW / pane.block.totals.w) * 1000) / 10 : 0;
		const impact = card.createDiv({ cls: "agent-sessions-efficiency-card-impact" });
		const amount = impact.createSpan({
			cls: "agent-sessions-efficiency-card-amount",
			text:
				f.impactUsd !== null
					? t("efficiency.card.impactUsd", { tokens: formatK(f.impactW), usd: formatCost(f.impactUsd), share })
					: t("efficiency.card.impact", { tokens: formatK(f.impactW), share }),
		});
		setTooltip(amount, t("efficiency.help.weighted"));
		if (this.hasKey(`efficiency.card.confidence.${f.confidence}`)) {
			const confidence = impact.createSpan({
				cls: `agent-sessions-efficiency-badge agent-sessions-efficiency-confidence is-${f.confidence}`,
				text: t(`efficiency.card.confidence.${f.confidence}` as MessageKey),
			});
			setTooltip(confidence, t("efficiency.help.confidence"));
		}
		const effect = effectText(f);
		if (effect) {
			card.createDiv({ cls: "agent-sessions-efficiency-card-effect", text: effect });
		}
		if (f.cause) {
			const cause = card.createDiv({ cls: "agent-sessions-efficiency-card-block" });
			cause.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.card.cause") });
			cause.createDiv({ cls: "agent-sessions-efficiency-card-cause", text: f.cause });
		}
		const remedy = card.createDiv({ cls: "agent-sessions-efficiency-card-block agent-sessions-efficiency-card-remedy" });
		remedy.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.card.remedy") });
		if (f.remedy.summary) {
			remedy.createDiv({ text: f.remedy.summary });
		}
		if (f.remedy.steps.length > 0) {
			const list = remedy.createEl("ol");
			for (const step of f.remedy.steps) {
				list.createEl("li", { text: step });
			}
		}
		if (f.remedy.kind === "fix" && f.remedy.change) {
			const fix = card.createDiv({ cls: "agent-sessions-efficiency-card-block" });
			fix.createDiv({
				cls: "agent-sessions-efficiency-targets",
				text: t("efficiency.card.targets", { files: f.remedy.targets.join(", ") }) + ` (${t(`efficiency.change.${f.remedy.change}`)})`,
			});
			if (f.remedy.draft) {
				fix.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.card.draft") });
				fix.createEl("pre", { text: f.remedy.draft });
			}
		}
		const evidence = card.createEl("details", { cls: "agent-sessions-efficiency-card-evidence" });
		evidence.createEl("summary", { text: t("efficiency.card.evidence") });
		for (const id of f.hits) {
			const h = hits.get(id);
			if (!h) {
				continue;
			}
			const line = evidence.createDiv({ cls: "agent-sessions-efficiency-hit" });
			line.createSpan({ text: this.hitLine(h, pane.block) });
			const open = line.createEl("a", { text: t("efficiency.card.openSession"), href: "#" });
			open.addEventListener("click", (evt) => {
				evt.preventDefault();
				void this.plugin.openSession(h.session);
			});
		}
		for (const q of f.quotes) {
			const task = q.ref.replace(/\.[pr]\d+$/, "");
			const ex = pane.block.excerpts.find((e) => e.task === task);
			const who = ex ? this.sessionLabel(ex.session, pane.block) : task;
			evidence.createDiv({ cls: "agent-sessions-efficiency-quote", text: t("efficiency.card.quote", { session: who, text: q.text }) });
		}
		if (f.remedy.kind === "fix" && f.remedy.change) {
			actionButton(card, t("efficiency.card.fixButton"), true).addEventListener("click", () => this.openFix(pane, f, hits));
		} else if (TEMPLATE_DETECTORS.has(f.detector)) {
			actionButton(card, t("efficiency.card.copyTemplate"), false).addEventListener("click", () => {
				void navigator.clipboard.writeText(requestTemplate()).then(() => new Notice(t("efficiency.card.copied")));
			});
		}
	}

	private hitLine(h: EffHit, block: EffAgent): string {
		return t("efficiency.card.hitLine", {
			session: this.sessionLabel(h.session, block),
			time: h.ts ? formatDateTimeShort(h.ts, getLang()) : "—",
			tokens: formatK(h.impact_w),
		});
	}

	private openFix(pane: Pane, f: Finding, hits: Map<string, EffHit>): void {
		const evidence = f.hits
			.map((id) => hits.get(id))
			.filter((h): h is EffHit => !!h)
			.slice(0, 3)
			.map((h) => this.hitLine(h, pane.block));
		const prompt = fixPrompt(f, evidence, pane.agent);
		if (!prompt) {
			return;
		}
		new FixConfirmModal(this.plugin, pane.agent, f, prompt).open();
	}
}

/** The status band at the top of a pane: one line saying what is going on and what to do next.
 * Screen readers hear it once per state through a hidden live region; the visible line, whose
 * counters tick every second, is hidden from them. Its sticky wrapper is the modal's background,
 * so nothing scrolling under it shows around it. */
function createBand(parent: HTMLElement): BandView {
	const wrap = parent.createDiv({ cls: "agent-sessions-efficiency-band-wrap" });
	const el = wrap.createDiv({ cls: "agent-sessions-efficiency-band" });
	const liveEl = el.createSpan({ cls: "agent-sessions-efficiency-sr", attr: { role: "status", "aria-live": "polite" } });
	const row = el.createDiv({ cls: "agent-sessions-efficiency-band-row" });
	row.createSpan({ cls: "agent-sessions-efficiency-band-icon" });
	const textEl = row.createSpan({ cls: "agent-sessions-efficiency-band-text", attr: { "aria-hidden": "true" } });
	const cancel = row.createEl("button", { cls: "agent-sessions-efficiency-band-cancel", text: t("efficiency.cancel") });
	cancel.toggle(false);
	return { el, textEl, liveEl, cancel };
}

function setBand(view: BandView, b: Band): void {
	if (view.textEl.textContent !== b.text) {
		view.textEl.setText(b.text);
	}
	if (view.liveEl.textContent !== b.announce) {
		view.liveEl.setText(b.announce);
	}
	for (const tone of ["busy", "info", "done", "error"]) {
		view.el.toggleClass(`is-${tone}`, tone === b.tone);
	}
	view.cancel.toggle(b.cancel);
}

/** The three steps, each with its number, name and mark; the current one stands out. Clicking a
 * step scrolls to its section. */
function renderSteps(el: HTMLElement, marks: StepState[], onClick?: (index: number) => void): void {
	el.empty();
	STEP_KEYS.forEach(([nameKey], i) => {
		const mark = marks[i] ?? "todo";
		const item = el.createEl("li", { cls: `agent-sessions-efficiency-step is-${mark}` });
		if (mark === "busy" || mark === "current") {
			item.setAttribute("aria-current", "step");
		}
		item.createSpan({ cls: "agent-sessions-efficiency-step-num", text: String(i + 1) });
		const text = item.createDiv({ cls: "agent-sessions-efficiency-step-text" });
		text.createDiv({ cls: "agent-sessions-efficiency-step-name", text: t(nameKey) });
		text.createDiv({ cls: "agent-sessions-efficiency-step-state", text: t(`efficiency.step.${mark}`) });
		if (onClick) {
			item.addClass("is-clickable");
			item.addEventListener("click", () => onClick(i));
		}
	});
}

/** A right-aligned button row under `parent` (a plain row: no setting divider above it). */
function actionButton(parent: HTMLElement, text: string, cta: boolean): HTMLButtonElement {
	const button = parent.createDiv({ cls: "agent-sessions-efficiency-actions" }).createEl("button", { text });
	if (cta) {
		button.addClass("mod-cta");
	}
	return button;
}

/** The confirmation before a fixing session starts: the agent, the session's name, the files it
 * may change, and the request, which can be edited. */
class FixConfirmModal extends Modal {
	constructor(
		private plugin: AgentSessionsPlugin,
		private agent: AgentId,
		private finding: Finding,
		private prompt: string
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-efficiency-fix");
		this.setTitle(t("efficiency.fix.confirmTitle"));
		const name = fixSessionName(this.finding);
		new Setting(this.contentEl).setName(t("efficiency.fix.agent")).setDesc(AGENT_NAMES[this.agent] ?? this.agent);
		new Setting(this.contentEl).setName(t("efficiency.fix.name")).setDesc(name);
		const change = this.finding.remedy.change;
		new Setting(this.contentEl)
			.setName(t("efficiency.fix.targets"))
			.setDesc(this.finding.remedy.targets.map((p) => `${p} (${change ? t(`efficiency.change.${change}`) : ""})`).join("\n"));
		this.contentEl.createDiv({
			cls: "agent-sessions-efficiency-note",
			text: t(
				this.agent === "codex" ? "efficiency.fix.planNoteCodex" : this.agent === "opencode" ? "efficiency.fix.planNoteOpencode" : "efficiency.fix.planNote"
			),
		});
		this.contentEl.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.fix.prompt") });
		const area = this.contentEl.createEl("textarea", { cls: "agent-sessions-efficiency-fix-prompt" });
		area.value = this.prompt;
		area.rows = 18;
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(t("efficiency.fix.start"))
				.setCta()
				.onClick(() => {
					const text = area.value.trim();
					if (!text) {
						return;
					}
					this.plugin.newSession(name, this.agent, { prompt: text, permissionMode: "plan", remember: false });
					this.close();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
