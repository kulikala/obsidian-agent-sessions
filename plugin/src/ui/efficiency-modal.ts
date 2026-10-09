// "Analyze token efficiency": runs `json efficiency` (local, nothing sent), then shows one pane per
// agent -- and, for Codex and OpenCode, one per provider their conversations used, so a
// conversation is only ever analysed where it was held. Every pane lists the same eight checks
// (`sessions/efficiency-checks.ts`) and shows one of three screens:
//
// - empty: what the checks look at, the range covered, Analyze, and a folded "Details" saying what
//   would be sent, how much, to which model and against which usage limit;
// - analyzing: the checks settle one after another -- those the statistics settle on their own at
//   once, the others one request each to the same agent and provider (`claude -p`, `codex exec`,
//   `opencode run`, in a fresh empty folder) -- with a progress bar and Stop;
// - result: the date, a one-line summary, and the rows; a row with an issue opens to the next
//   step, what happened, its cause, quotes and an action (copy a request template, or start an
//   agent in the vault, in plan mode or its nearest, with the request shown and editable first).
//   Below them, the folded basis (totals, what was sent, the model) and Analyze again.
//
// The last result per pane is saved under `<runtime>/efficiency/` and is the result screen next
// time. States and words: `efficiency-view.ts`.

import { Modal, Notice, Platform, Setting, setIcon, setTooltip } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { efficiency, loginEnv, resolveAgentBinary, withBinDirOnPath } from "../backend/backend";
import { runHeadless } from "../backend/headless";
import { efficiencyDir, efficiencyRunDir } from "../backend/paths";
import { inRunFolder } from "../backend/run-folder";
import { getLang, t, type MessageKey } from "../i18n";
import { formatDateTimeShort } from "../i18n/datetime";
import {
	analysisArgs,
	analysisModels,
	estimateTokens,
	fixPrompt,
	fixSessionName,
	paneBlock,
	panesOf,
	requestTemplate,
	taskOfRef,
	usageWindow,
	type EffAgent,
	type EffHit,
	type EffOutput,
	type EffPane,
	type Finding,
} from "../sessions/efficiency";
import { allowedActions, checkPayload, checkPrompt, planChecks, runCheck, type CheckPlan } from "../sessions/efficiency-checks";
import { detectorMetrics, loadResult, overlaps, saveResult, type SavedResult } from "../sessions/efficiency-store";
import { addUsage, type HeadlessUsage } from "../sessions/organize-agent";
import { sessionDisplayName } from "../sessions/name";
import { parseEnvLines, type AgentId } from "../settings";
import { formatCost, formatK, formatNumber } from "../usage/usage";
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
	resultHeading,
	rowsToSave,
	savedRows,
	setRow,
	spanLabel,
	stateLabel,
	statsFailureMessage,
	summaryText,
	targetLine,
	transition,
	waitingRows,
	type DialogEvent,
	type DialogState,
	type Row,
} from "./efficiency-view";

const ANALYSIS_TIMEOUT_MS = 300_000;
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const AGENTS: AgentId[] = ["claude", "codex", "opencode"];
const CLS = "agent-sessions-efficiency";

/** An analysis running in a pane. */
interface Run {
	rows: Row[];
	started: number;
	abort: AbortController;
	usage: HeadlessUsage | null;
	ticker: number | null;
	/** The live line under the progress bar, updated every second. */
	elapsedEl: HTMLElement | null;
}

interface Pane {
	/** `claude`, or `<agent>-<provider>`: the dialog state, the saved result and the tab. */
	key: string;
	agent: AgentId;
	info: EffPane;
	block: EffAgent;
	plans: CheckPlan[];
	/** What an analysis would send: estimated tokens and sessions. */
	sent: { tokens: number; sessions: number };
	/** The model the last analysis ran on, when Codex refused the first choice. */
	usedModel: string | null;
	el: HTMLElement;
	tab: HTMLElement | null;
	/** The result shown on the result screen: the saved one, or the analysis just made. */
	saved: SavedResult | null;
	run: Run | null;
	/** Why the last analysis stopped, until the next one starts. */
	error: string | null;
	/** Open rows and disclosures, kept across redraws. */
	open: Set<string>;
}

export class EfficiencyModal extends Modal {
	private state: DialogState = initialState();
	private panes = new Map<string, Pane>();
	private bodyEl!: HTMLElement;
	private tabsEl: HTMLElement | null = null;

	constructor(private plugin: AgentSessionsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass(CLS);
		this.setTitle(t("efficiency.title"));
		this.bodyEl = this.contentEl.createDiv({ cls: `${CLS}-body` });
		void this.loadStats();
	}

	onClose(): void {
		for (const pane of this.panes.values()) {
			if (pane.run) {
				pane.run.abort.abort();
				this.stopTicker(pane.run);
			}
		}
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
		const loading = this.bodyEl.createDiv({ cls: `${CLS}-loading`, attr: { role: "status" } });
		loading.createSpan({ cls: `${CLS}-spin` });
		loading.createSpan({ text: t("efficiency.loading") });
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
			loading.remove();
			this.dispatch({ type: "statsFailed" });
			this.showStatsFailure(err);
			return;
		}
		loading.remove();
		const agents = AGENTS.filter((a) => out.agents?.[a] && s.agents[a]?.enabled);
		const panes = agents.flatMap((agent) => panesOf(agent, out.agents[agent]).map((info) => ({ agent, info })));
		if (panes.length === 0) {
			this.dispatch({ type: "statsDone", agents: [], withResult: [] });
			this.bodyEl.createDiv({ cls: `${CLS}-note`, text: t("efficiency.error.noData") });
			return;
		}
		if (panes.length > 1) {
			this.tabsEl = this.bodyEl.createDiv({ cls: `${CLS}-tabs`, attr: { role: "tablist" } });
		}
		// The provider goes on a tab only when the agent has more than one.
		const count = (agent: string): number => panes.filter((p) => p.agent === agent).length;
		for (const { agent, info } of panes) {
			this.buildPane(agent, info, paneBlock(out.agents[agent], info), count(agent) > 1);
		}
		this.dispatch({
			type: "statsDone",
			agents: panes.map((p) => p.info.key),
			withResult: [...this.panes.values()].filter((p) => p.saved).map((p) => p.key),
		});
		for (const pane of this.panes.values()) {
			this.render(pane);
		}
		this.selectPane(panes[0].info.key);
	}

	private showStatsFailure(err: unknown): void {
		const kind = classifyStatsFailure(err, this.plugin.backendAvailable());
		const error = err instanceof Error ? err.message : String(err);
		const box = this.bodyEl.createDiv({ cls: `${CLS}-failed` });
		box.createDiv({ cls: `${CLS}-error`, text: statsFailureMessage(kind, error) });
		const actions = box.createDiv({ cls: `${CLS}-foot is-end` });
		if (kind === "stats") {
			actions.createEl("button", { text: t("efficiency.error.retry") }).addEventListener("click", () => void this.loadStats());
		} else {
			const button = actions.createEl("button", { cls: "mod-cta", text: t(kind === "noProgram" ? "efficiency.error.install" : "efficiency.error.update") });
			button.addEventListener("click", () => {
				this.close();
				this.plugin.openInstallBackend();
			});
		}
	}

	// ---- Panes --------------------------------------------------------------------------------

	private buildPane(agent: AgentId, info: EffPane, block: EffAgent, withProvider: boolean): void {
		const el = this.bodyEl.createDiv({ cls: `${CLS}-pane` });
		const name = AGENT_NAMES[agent] ?? agent;
		let tab: HTMLElement | null = null;
		if (this.tabsEl) {
			tab = this.tabsEl.createEl("button", { cls: `${CLS}-tab`, attr: { role: "tab" } });
			tab.createSpan({ text: withProvider && info.provider ? t("efficiency.tabProvider", { agent: name, provider: info.provider }) : name });
			tab.createSpan({ cls: `${CLS}-tab-mark` });
			tab.addEventListener("click", () => this.selectPane(info.key));
		}
		const plans = planChecks(block);
		const saved = loadResult(efficiencyDir(), info.key);
		const pane: Pane = {
			key: info.key,
			agent,
			info,
			block,
			plans,
			sent: this.sentEstimate(block, plans),
			usedModel: null,
			el,
			tab,
			saved: saved && overlaps(saved, block.range) ? saved : null,
			run: null,
			error: null,
			open: new Set(),
		};
		this.panes.set(info.key, pane);
	}

	/** What an analysis would send: the requests of the checks that need the model. */
	private sentEstimate(block: EffAgent, plans: CheckPlan[]): { tokens: number; sessions: number } {
		let tokens = 0;
		const sessions = new Set<string>();
		for (const plan of plans) {
			if (plan.outcome !== "model") {
				continue;
			}
			const payload = checkPayload(block, plan);
			tokens += estimateTokens(checkPrompt(payload, allowedActions(plan), getLang()));
			for (const e of block.excerpts) {
				if (payload.hits.some((h) => h.task === e.task)) {
					sessions.add(e.session);
				}
			}
		}
		return { tokens, sessions: sessions.size };
	}

	private selectPane(key: string): void {
		for (const pane of this.panes.values()) {
			const selected = pane.key === key;
			pane.el.toggle(selected);
			pane.tab?.toggleClass("is-active", selected);
			pane.tab?.setAttribute("aria-selected", String(selected));
		}
	}

	private agentName(pane: Pane): string {
		return AGENT_NAMES[pane.agent] ?? pane.agent;
	}

	/** The model the analysis uses, as shown. */
	private modelName(pane: Pane): string {
		if (pane.agent === "claude") {
			return this.plugin.settings.efficiencyModel;
		}
		return pane.usedModel ?? pane.info.model ?? t("efficiency.defaultModel");
	}

	/** Draws the pane's screen from scratch. */
	private render(pane: Pane): void {
		const screen = this.state.panes[pane.key] ?? "empty";
		pane.el.empty();
		this.renderTab(pane);
		if (screen === "analyzing" && pane.run) {
			this.renderAnalyzing(pane, pane.run);
		} else if (screen === "result" && pane.saved) {
			this.renderResult(pane, pane.saved);
		} else {
			this.renderEmpty(pane);
		}
	}

	/** The tab's mark: a spinner while the pane is analysing. */
	private renderTab(pane: Pane): void {
		const mark = pane.tab?.querySelector<HTMLElement>(`.${CLS}-tab-mark`);
		if (!pane.tab || !mark) {
			return;
		}
		const running = this.state.panes[pane.key] === "analyzing";
		mark.toggleClass(`${CLS}-spin`, running);
		mark.setAttribute("aria-label", running ? stateLabel("running") : "");
	}

	private head(parent: HTMLElement, title: string, sub: string): void {
		const head = parent.createDiv({ cls: `${CLS}-head` });
		head.createDiv({ cls: `${CLS}-h1`, text: title });
		head.createDiv({ cls: `${CLS}-sub`, text: sub });
	}

	private renderError(pane: Pane): void {
		if (pane.error) {
			pane.el.createDiv({ cls: `${CLS}-error`, text: pane.error, attr: { role: "alert" } });
		}
	}

	// ---- Empty -----------------------------------------------------------------------------------

	private renderEmpty(pane: Pane): void {
		const block = pane.block;
		this.head(pane.el, t("efficiency.empty.heading"), hasData(block) ? targetLine(block.range, block.sessions.length, block.totals.w) : t("efficiency.error.noData"));
		this.renderError(pane);
		this.renderRows(pane, idleRows(), "empty");
		if (!hasData(block)) {
			return;
		}
		const go = pane.el.createDiv({ cls: `${CLS}-go` });
		go.createEl("button", { cls: "mod-cta", text: t("efficiency.analyze") }).addEventListener("click", () => void this.analyze(pane));
		go.createDiv({ cls: `${CLS}-sub`, text: t("efficiency.estimate") });
		this.disclosure(pane, "details", t("efficiency.details"), t("efficiency.details.sub"), (body) => {
			body.createDiv({ text: t("efficiency.details.lead") });
			const local = pane.info.local;
			const kv = body.createEl("dl", { cls: `${CLS}-kv` });
			const item = (label: string, value: string): void => {
				kv.createEl("dt", { text: label });
				kv.createEl("dd", { text: value });
			};
			item(t(local ? "efficiency.details.whatLocal" : "efficiency.details.what"), t("efficiency.details.whatValue"));
			item(
				t("efficiency.details.amount"),
				pane.sent.tokens > 0
					? t("efficiency.details.amountValue", { tokens: formatK(pane.sent.tokens), sessions: pane.sent.sessions })
					: t("efficiency.details.amountNone")
			);
			const agent = this.agentName(pane);
			item(
				t("efficiency.details.model"),
				local ? t("efficiency.details.modelLocal", { model: this.modelName(pane) }) : t("efficiency.details.modelValue", { agent, model: this.modelName(pane) })
			);
			const usage = usageWindow(block.range);
			item(
				t("efficiency.details.limit"),
				local
					? t("efficiency.details.limitLocal")
					: usage
						? t("efficiency.details.limitPercent", { agent, window: usage.label, percent: Math.round(usage.percent) })
						: t("efficiency.details.limitValue", { agent })
			);
			const prompts = pane.plans
				.filter((plan) => plan.outcome === "model")
				.map((plan) => checkPrompt(checkPayload(block, plan), allowedActions(plan), getLang()));
			if (prompts.length > 0) {
				const preview = body.createEl("details", { cls: `${CLS}-preview` });
				preview.createEl("summary", { text: t("efficiency.details.preview") });
				preview.createEl("pre", { text: prompts.join("\n\n----\n\n") });
			}
		});
	}

	// ---- Analyzing -------------------------------------------------------------------------------

	private renderAnalyzing(pane: Pane, run: Run): void {
		const block = pane.block;
		this.head(
			pane.el,
			t("efficiency.analyzing.heading"),
			metaLine([spanLabel(block.range, true), t("efficiency.meta.sessions", { count: block.sessions.length }), this.modelName(pane)])
		);
		const done = doneCount(run.rows);
		const prog = pane.el.createDiv({ cls: `${CLS}-prog` });
		const bar = prog.createDiv({
			cls: `${CLS}-progress`,
			attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(run.rows.length), "aria-valuenow": String(done) },
		});
		bar.createEl("i").style.width = `${(done / run.rows.length) * 100}%`;
		const meta = prog.createDiv({ cls: `${CLS}-prog-meta ${CLS}-sub` });
		meta.createSpan({ text: t("efficiency.progress", { done }), attr: { role: "status" } });
		run.elapsedEl = meta.createSpan({ text: elapsedText((Date.now() - run.started) / 1000) });
		this.renderRows(pane, run.rows, "analyzing");
		const foot = pane.el.createDiv({ cls: `${CLS}-foot` });
		foot.createDiv({ cls: `${CLS}-sub`, text: t("efficiency.analyzing.note") });
		foot.createEl("button", { text: t("efficiency.stop") }).addEventListener("click", () => run.abort.abort());
	}

	private stopTicker(run: Run): void {
		if (run.ticker !== null) {
			window.clearInterval(run.ticker);
			run.ticker = null;
		}
	}

	// ---- Result ----------------------------------------------------------------------------------

	private renderResult(pane: Pane, saved: SavedResult): void {
		const rows = savedRows(saved.checks);
		const summary = pane.el.createDiv({ cls: `${CLS}-summary` });
		summary.createDiv({ cls: `${CLS}-h1`, text: resultHeading(saved.savedAt) });
		summary.createDiv({ cls: `${CLS}-summary-text`, text: summaryText(rows) });
		const cost = saved.selfCost?.usd;
		summary.createDiv({
			cls: `${CLS}-sub`,
			text: metaLine([
				spanLabel(saved.range, true),
				t("efficiency.meta.sessions", { count: saved.sessions }),
				t("efficiency.meta.model", { model: saved.model }),
				typeof cost === "number" ? t("efficiency.meta.cost", { usd: formatCost(cost) }) : null,
			]),
		});
		this.renderError(pane);
		this.renderRows(pane, rows, "result", saved);
		this.disclosure(pane, "basis", t("efficiency.basis"), t("efficiency.basis.sub"), (body) => {
			const tot = saved.totals;
			const stats = body.createDiv({ cls: `${CLS}-stats` });
			const tile = (value: string, label: string): HTMLElement => {
				const cell = stats.createDiv({ cls: `${CLS}-stat` });
				cell.createEl("b", { text: value });
				cell.createSpan({ text: label });
				return cell;
			};
			setTooltip(tile(formatK(tot.w), t("efficiency.basis.tokens")), t("efficiency.help.weighted"));
			if (typeof tot.usd === "number") {
				tile(t("efficiency.basis.costValue", { usd: formatCost(tot.usd) }), t("efficiency.basis.cost"));
			}
			if (typeof tot.cache_hit === "number") {
				tile(`${Math.round(tot.cache_hit * 100)}%`, t("efficiency.basis.cacheHit"));
			}
			tile(formatNumber(tot.calls), t("efficiency.basis.calls"));
			const kv = body.createEl("dl", { cls: `${CLS}-kv` });
			kv.createEl("dt", { text: t(pane.info.local ? "efficiency.basis.sentLocal" : "efficiency.basis.sent") });
			kv.createEl("dd", {
				text:
					saved.sent.tokens > 0
						? t("efficiency.details.amountValue", { tokens: formatK(saved.sent.tokens), sessions: saved.sent.sessions })
						: t("efficiency.details.amountNone"),
			});
			kv.createEl("dt", { text: t("efficiency.basis.model") });
			kv.createEl("dd", {
				text: pane.info.local
					? t("efficiency.details.modelLocal", { model: saved.model })
					: t("efficiency.details.modelValue", { agent: this.agentName(pane), model: saved.model }),
			});
		});
		const foot = pane.el.createDiv({ cls: `${CLS}-foot` });
		const fresh = this.newSessions(pane, saved);
		if (fresh > 0) {
			foot.createDiv({ cls: `${CLS}-sub`, text: t("efficiency.newSessions", { count: fresh }) });
		} else {
			foot.addClass("is-end");
		}
		const again = foot.createEl("button", { text: t("efficiency.again") });
		again.disabled = !hasData(pane.block);
		again.addEventListener("click", () => void this.analyze(pane));
	}

	/** Sessions of this agent active since the result that it did not cover. */
	private newSessions(pane: Pane, saved: SavedResult): number {
		const covered = new Set(saved.sessionIds);
		let n = 0;
		for (const row of this.plugin.index.sessions.values()) {
			if (row.agent === pane.agent && !row.child && row.last_activity > saved.savedAt && !covered.has(row.id)) {
				n += 1;
			}
		}
		return n;
	}

	// ---- Rows ------------------------------------------------------------------------------------

	/** The eight rows. On the result screen a row with an issue is a button that opens its finding. */
	private renderRows(pane: Pane, rows: Row[], screen: "empty" | "analyzing" | "result", saved?: SavedResult): void {
		const list = pane.el.createDiv({ cls: `${CLS}-points` });
		rows.forEach((row) => {
			const item = list.createDiv({ cls: `${CLS}-pt is-${row.state}` });
			const finding = row.state === "issue" ? row.finding : null;
			const openable = screen === "result" && finding !== null && saved !== undefined;
			const isOpen = openable && pane.open.has(`row:${row.check}`);
			item.toggleClass("is-open", isOpen);
			const head = openable ? item.createEl("button", { cls: `${CLS}-pt-row`, attr: { type: "button", "aria-expanded": String(isOpen), "data-open-key": `row:${row.check}` } }) : item.createDiv({ cls: `${CLS}-pt-row` });
			const text = head.createSpan({ cls: `${CLS}-pt-text` });
			text.createSpan({ cls: `${CLS}-pt-name`, text: checkName(row.check) });
			const desc =
				screen === "empty" ? checkDesc(row.check) : row.state === "running" ? t("efficiency.reading") : screen === "result" && finding ? finding.title : "";
			if (desc) {
				text.createSpan({ cls: `${CLS}-pt-desc`, text: desc });
			}
			const st = head.createSpan({ cls: `${CLS}-st is-${row.state}` });
			if (row.state === "running") {
				st.createSpan({ cls: `${CLS}-spin` });
			} else if (row.state === "ok" || row.state === "issue") {
				const mark = st.createSpan({ cls: `${CLS}-mark`, attr: { "aria-hidden": "true" } });
				setIcon(mark, row.state === "ok" ? "check" : "alert-circle");
			}
			st.createSpan({ cls: `${CLS}-st-label`, text: stateLabel(row.state) });
			if (finding) {
				st.createSpan({ cls: `${CLS}-st-amt`, text: t("efficiency.saving", { tokens: formatK(finding.savingW) }) });
			}
			if (!openable || !finding || !saved) {
				return;
			}
			const act = st.createSpan({ cls: `${CLS}-st-act` });
			act.createSpan({ text: t(isOpen ? "efficiency.hide" : "efficiency.show") });
			act.createSpan({ cls: `${CLS}-chev` });
			head.addEventListener("click", () => {
				this.toggleOpen(pane, `row:${row.check}`);
			});
			if (isOpen) {
				this.renderFinding(item.createDiv({ cls: `${CLS}-pt-body` }), pane, finding, saved);
			}
		});
	}

	private toggleOpen(pane: Pane, key: string): void {
		if (pane.open.has(key)) {
			pane.open.delete(key);
		} else {
			pane.open.add(key);
		}
		const scroll = this.contentEl.scrollTop;
		this.render(pane);
		this.contentEl.scrollTop = scroll;
		pane.el.querySelector<HTMLElement>(`[data-open-key="${key}"]`)?.focus();
	}

	/** An issue's next step, what happened, its cause, quotes and action. */
	private renderFinding(body: HTMLElement, pane: Pane, f: Finding, saved: SavedResult): void {
		body.createDiv({ cls: `${CLS}-fix`, text: f.fix });
		const kv = body.createEl("dl", { cls: `${CLS}-kv` });
		kv.createEl("dt", { text: t("efficiency.finding.observed") });
		kv.createEl("dd", { text: f.observed });
		if (f.cause) {
			kv.createEl("dt", { text: t("efficiency.finding.cause") });
			kv.createEl("dd", { text: t(`efficiency.cause.${f.cause}` as MessageKey) });
		}
		const hits = new Map(saved.hits.map((h) => [h.id, h]));
		const sessionOfTask = new Map(saved.hits.filter((h) => h.task).map((h) => [h.task as string, h.session]));
		for (const q of f.quotes) {
			const session = sessionOfTask.get(taskOfRef(q.ref));
			body.createEl("blockquote", {
				cls: `${CLS}-quote`,
				text: session ? t("efficiency.quote", { text: q.text, session: this.sessionLabel(session, pane.block) }) : q.text,
			});
		}
		if (f.action === "none") {
			return;
		}
		const actions = body.createDiv({ cls: `${CLS}-body-act` });
		if (f.action === "agent") {
			actions.createEl("button", { text: t("efficiency.action.agent") }).addEventListener("click", () => this.openFix(pane, f, hits));
		} else {
			actions.createEl("button", { text: t("efficiency.action.template") }).addEventListener("click", () => {
				void navigator.clipboard.writeText(requestTemplate()).then(() => new Notice(t("efficiency.copied")));
			});
		}
	}

	/** A full-width row that folds `fill`'s content; open or closed is kept across redraws. */
	private disclosure(pane: Pane, key: string, label: string, sub: string, fill: (body: HTMLElement) => void): void {
		const isOpen = pane.open.has(key);
		const box = pane.el.createDiv({ cls: `${CLS}-disc` });
		box.toggleClass("is-open", isOpen);
		const head = box.createEl("button", { cls: `${CLS}-disc-head`, attr: { type: "button", "aria-expanded": String(isOpen), "data-open-key": key } });
		const text = head.createSpan({ cls: `${CLS}-disc-label` });
		text.createEl("b", { text: label });
		text.createSpan({ text: sub });
		const act = head.createSpan({ cls: `${CLS}-st-act` });
		act.createSpan({ text: t(isOpen ? "efficiency.hide" : "efficiency.show") });
		act.createSpan({ cls: `${CLS}-chev` });
		head.addEventListener("click", () => this.toggleOpen(pane, key));
		if (isOpen) {
			fill(box.createDiv({ cls: `${CLS}-disc-body` }));
		}
	}

	private sessionLabel(id: string, block: EffAgent): string {
		const row = this.plugin.index.sessions.get(id);
		if (row) {
			return sessionDisplayName(row);
		}
		return block.sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);
	}

	// ---- Analysis --------------------------------------------------------------------------------

	private async analyze(pane: Pane): Promise<void> {
		if (pane.run) {
			return;
		}
		const run: Run = { rows: waitingRows(), started: Date.now(), abort: new AbortController(), usage: null, ticker: null, elapsedEl: null };
		pane.run = run;
		pane.error = null;
		pane.open.clear();
		this.dispatch({ type: "start", agent: pane.key });
		this.render(pane);
		run.ticker = window.setInterval(() => run.elapsedEl?.setText(elapsedText((Date.now() - run.started) / 1000)), 1000);
		const update = (rows: Row[]): void => {
			run.rows = rows;
			if (this.state.panes[pane.key] === "analyzing") {
				this.render(pane);
			}
		};
		try {
			const ask = await this.asker(pane, run.abort.signal);
			for (const [i, plan] of pane.plans.entries()) {
				if (run.abort.signal.aborted) {
					throw new Error("aborted");
				}
				if (plan.outcome !== "model") {
					update(setRow(run.rows, i, plan.outcome));
					continue;
				}
				update(setRow(run.rows, i, "running"));
				const payload = checkPayload(pane.block, plan);
				const actions = allowedActions(plan);
				const outcome = await runCheck(checkPrompt(payload, actions, getLang()), payload, actions, ask);
				run.usage = addUsage(run.usage, outcome.usage);
				update(setRow(run.rows, i, outcome.finding ? "issue" : "ok", outcome.finding));
			}
			pane.saved = this.save(pane, run);
			this.dispatch({ type: "finished", agent: pane.key });
		} catch (err) {
			const failure = classifyAnalysisFailure(err, run.abort.signal.aborted);
			pane.error = analysisFailureMessage(failure, this.agentName(pane));
			this.dispatch({ type: "stopped", agent: pane.key, hasResult: pane.saved !== null });
		} finally {
			this.stopTicker(run);
			pane.run = null;
			if (this.panes.get(pane.key) === pane) {
				this.render(pane);
			}
		}
	}

	/** How one request is sent: the agent's binary and environment, resolved once, in a fresh empty
	 * folder. Codex: the strongest model Codex lists first; one it refuses as unavailable gives way
	 * to the next, which then stays for the rest of the analysis. */
	private async asker(pane: Pane, signal: AbortSignal): Promise<(prompt: string) => Promise<{ text: string; usage: HeadlessUsage | null }>> {
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
		const models = analysisModels(pane.info);
		let current = Math.max(0, pane.usedModel ? models.indexOf(pane.usedModel) : 0);
		return async (prompt) => {
			for (;;) {
				try {
					return await inRunFolder(efficiencyRunDir(), (cwd) =>
						runHeadless({
							agent,
							bin,
							env,
							cwd,
							prompt,
							model: this.plugin.settings.efficiencyModel,
							extraArgs: analysisArgs({ ...pane.info, model: models[current] }),
							timeoutMs: ANALYSIS_TIMEOUT_MS,
							signal,
						})
					);
				} catch (err) {
					if (current + 1 >= models.length || signal.aborted || !modelUnavailable(err)) {
						throw err;
					}
					current += 1;
					pane.usedModel = models[current];
				}
			}
		};
	}

	/** Saves a finished analysis as the pane's last result (and keeps it shown even when the file
	 * can't be written). */
	private save(pane: Pane, run: Run): SavedResult {
		const cited = new Set(run.rows.flatMap((r) => r.finding?.hits ?? []));
		const result: SavedResult = {
			version: 2,
			agent: pane.key,
			savedAt: Date.now() / 1000,
			model: this.modelName(pane),
			range: pane.block.range,
			totals: pane.block.totals,
			sessions: pane.block.sessions.length,
			sessionIds: pane.block.sessions.map((s) => s.id),
			checks: rowsToSave(run.rows),
			hits: pane.block.hits.filter((h) => cited.has(h.id)),
			selfCost: run.usage,
			sent: pane.sent,
			metrics: detectorMetrics(pane.block.hits),
		};
		try {
			saveResult(efficiencyDir(), result);
		} catch (err) {
			console.warn("agent-sessions: could not save the token efficiency result", err);
		}
		return result;
	}

	private hitLine(h: EffHit, block: EffAgent): string {
		return t("efficiency.hitLine", {
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
		this.modalEl.addClass(`${CLS}-fix-dialog`);
		this.setTitle(t("efficiency.fix.confirmTitle"));
		const name = fixSessionName(this.finding);
		new Setting(this.contentEl).setName(t("efficiency.fix.agent")).setDesc(AGENT_NAMES[this.agent] ?? this.agent);
		new Setting(this.contentEl).setName(t("efficiency.fix.name")).setDesc(name);
		const change = this.finding.change;
		new Setting(this.contentEl)
			.setName(t("efficiency.fix.targets"))
			.setDesc(this.finding.targets.map((p) => `${p} (${change ? t(`efficiency.change.${change}`) : ""})`).join("\n"));
		this.contentEl.createDiv({
			cls: `${CLS}-note`,
			text: t(
				this.agent === "codex" ? "efficiency.fix.planNoteCodex" : this.agent === "opencode" ? "efficiency.fix.planNoteOpencode" : "efficiency.fix.planNote"
			),
		});
		this.contentEl.createDiv({ cls: `${CLS}-subhead`, text: t("efficiency.fix.prompt") });
		const area = this.contentEl.createEl("textarea", { cls: `${CLS}-fix-prompt` });
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
