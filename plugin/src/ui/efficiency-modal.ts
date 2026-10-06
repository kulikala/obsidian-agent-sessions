// "Analyze token efficiency": runs `json efficiency` (local, nothing sent), shows the range, the
// totals, the breakdown and the statistics' own findings, and -- only when the user presses
// Analyze in an agent's pane -- sends that run's masked summary and excerpts to the same agent
// (`claude -p`, in a fresh empty folder), checks the reply (`sessions/efficiency.ts`) and shows the
// findings as cards. A `fix` card can start a session in the vault, in plan mode, with the request
// shown and editable first. States and failures: `efficiency-view.ts`. The last result per agent
// is saved under `<runtime>/efficiency/` and shown again next time.

import { Modal, Notice, Platform, Setting } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { efficiency, loginEnv, resolveAgentBinary, withBinDirOnPath } from "../backend/backend";
import { runHeadless } from "../backend/headless";
import { efficiencyDir, efficiencyRunDir } from "../backend/paths";
import { inRunFolder } from "../backend/run-folder";
import { getLang, t, type MessageKey } from "../i18n";
import { formatDateTimeShort } from "../i18n/datetime";
import { en } from "../i18n/locales/en";
import {
	analysisPrompt,
	candidates,
	estimateTokens,
	fixPrompt,
	fixSessionName,
	effectText,
	payloadOf,
	rangeLine,
	requestTemplate,
	runAnalysis,
	statFindings,
	type EffAgent,
	type EffHit,
	type EffOutput,
	type Finding,
} from "../sessions/efficiency";
import { detectorMetrics, loadResult, overlaps, payloadHash, saveResult, type SavedResult } from "../sessions/efficiency-store";
import type { HeadlessUsage } from "../sessions/organize-agent";
import { sessionDisplayName } from "../sessions/name";
import { parseEnvLines, type AgentId } from "../settings";
import { formatCost, formatK } from "../usage/usage";
import {
	analysisFailureMessage,
	classifyAnalysisFailure,
	classifyStatsFailure,
	hasData,
	initialState,
	shownFindings,
	statsFailureMessage,
	transition,
	type DialogEvent,
	type DialogState,
} from "./efficiency-view";

const ANALYSIS_TIMEOUT_MS = 300_000;
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
/** Detectors whose advice is a request template the user can copy. */
const TEMPLATE_DETECTORS = new Set(["E16", "E17"]);

interface Pane {
	agent: string;
	block: EffAgent;
	payload: string;
	prompt: string;
	el: HTMLElement;
	statusEl: HTMLElement;
	consentEl: HTMLElement;
	workingEl: HTMLElement;
	liveEl: HTMLElement;
	logEl: HTMLElement;
	findingsEl: HTMLElement;
	costEl: HTMLElement;
	findings: Finding[];
	previous: SavedResult | null;
	abort: AbortController | null;
	ticker: number | null;
}

export class EfficiencyModal extends Modal {
	private state: DialogState = initialState();
	private panes = new Map<string, Pane>();
	private bodyEl!: HTMLElement;
	private ticker: number | null = null;

	constructor(private plugin: AgentSessionsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-efficiency");
		this.setTitle(t("efficiency.title"));
		this.contentEl.createDiv({ cls: "agent-sessions-efficiency-intro", text: t("efficiency.intro") });
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
		const reading = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-reading" });
		const started = Date.now();
		const tick = (): void => reading.setText(t("efficiency.reading", { seconds: Math.floor((Date.now() - started) / 1000) }));
		tick();
		this.ticker = window.setInterval(tick, 1000);
		const s = this.plugin.settings;
		let out: EffOutput;
		try {
			if (!this.plugin.backendAvailable()) {
				throw new Error("not installed");
			}
			out = (await efficiency(this.plugin.agentSessionsPath(), this.plugin.vaultPath(), {
				agent: "claude",
				threshold: s.efficiencyThreshold,
				budget: s.efficiencyBudget,
			})) as EffOutput;
		} catch (err) {
			this.stopTicker();
			this.dispatch({ type: "statsFailed" });
			this.showStatsFailure(err);
			return;
		}
		this.stopTicker();
		reading.remove();
		const agents = Object.keys(out.agents ?? {}).filter((a) => a === "claude" && s.agents[a as AgentId]?.enabled);
		this.dispatch({ type: "statsDone", agents });
		if (agents.length === 0) {
			this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-error", text: t("efficiency.error.noData") });
			return;
		}
		for (const agent of agents) {
			this.buildPane(agent, out.agents[agent]);
		}
	}

	private stopTicker(): void {
		if (this.ticker !== null) {
			window.clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	private showStatsFailure(err: unknown): void {
		this.bodyEl.empty();
		const kind = classifyStatsFailure(err, this.plugin.backendAvailable());
		const box = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-error" });
		const error = err instanceof Error ? err.message : String(err);
		box.setText(statsFailureMessage(kind, error));
		const setting = new Setting(this.bodyEl);
		if (kind === "stats") {
			setting.addButton((b) => b.setButtonText(t("efficiency.error.retry")).onClick(() => void this.loadStats()));
		} else {
			setting.addButton((b) =>
				b
					.setButtonText(t(kind === "noProgram" ? "efficiency.error.install" : "efficiency.error.update"))
					.setCta()
					.onClick(() => {
						this.close();
						this.plugin.openInstallBackend();
					})
			);
		}
	}

	// ---- One agent's pane ------------------------------------------------------------------

	private buildPane(agent: string, block: EffAgent): void {
		const el = this.bodyEl.createDiv({ cls: "agent-sessions-efficiency-pane" });
		const name = AGENT_NAMES[agent] ?? agent;
		el.createDiv({ cls: "agent-sessions-efficiency-range", text: rangeLine(name, block) });
		if (block.limits.truncated) {
			el.createDiv({
				cls: "agent-sessions-efficiency-note",
				text:
					block.limits.reason === "max_bytes"
						? t("efficiency.range.truncatedBytes")
						: t("efficiency.range.truncated", { count: Number(block.limits.sessions_read ?? 200) }),
			});
		}
		if (block.baselines.disabled.length > 0) {
			el.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.limited") });
		}
		const payload = payloadOf(block);
		const pane: Pane = {
			agent,
			block,
			payload,
			prompt: analysisPrompt(payload, getLang()),
			el,
			statusEl: el.createDiv({ cls: "agent-sessions-efficiency-status" }),
			consentEl: createDiv(),
			workingEl: createDiv(),
			liveEl: createDiv(),
			logEl: createDiv(),
			findingsEl: createDiv(),
			costEl: createDiv(),
			findings: statFindings(block.hits),
			previous: null,
			abort: null,
			ticker: null,
		};
		this.panes.set(agent, pane);
		if (!hasData(block)) {
			pane.statusEl.setText(t("efficiency.error.noData"));
			return;
		}
		this.renderTotals(pane);
		pane.consentEl = el.createDiv({ cls: "agent-sessions-efficiency-consent" });
		pane.workingEl = el.createDiv({ cls: "agent-sessions-efficiency-working" });
		pane.liveEl = pane.workingEl.createDiv({ cls: "agent-sessions-efficiency-live" });
		const logDetails = pane.workingEl.createEl("details", { cls: "agent-sessions-efficiency-logdetails" });
		logDetails.createEl("summary", { text: t("efficiency.showLog") });
		pane.logEl = logDetails.createDiv({ cls: "agent-sessions-organize-log" });
		pane.workingEl.toggle(false);
		pane.findingsEl = el.createDiv({ cls: "agent-sessions-efficiency-findings" });
		pane.costEl = el.createDiv({ cls: "agent-sessions-efficiency-cost" });
		const saved = loadResult(efficiencyDir(), agent);
		if (saved && overlaps(saved, block.range)) {
			pane.previous = saved;
		}
		this.renderConsent(pane);
		this.renderFindings(pane);
	}

	private renderTotals(pane: Pane): void {
		const tot = pane.block.totals;
		const parts = [t("efficiency.total.w", { tokens: formatK(tot.w) })];
		if (typeof tot.usd === "number") {
			parts.push(t("efficiency.total.usd", { usd: formatCost(tot.usd) }));
		}
		if (typeof tot.cache_hit === "number") {
			parts.push(t("efficiency.total.cacheHit", { percent: Math.round(tot.cache_hit * 100) }));
		}
		parts.push(t("efficiency.total.calls", { count: tot.calls }));
		if (typeof tot.preamble_median === "number") {
			parts.push(t("efficiency.total.preamble", { tokens: formatK(tot.preamble_median) }));
		}
		pane.el.createDiv({ cls: "agent-sessions-efficiency-totals", text: parts.join(" · ") });
		const breakdown = pane.el.createDiv({ cls: "agent-sessions-efficiency-breakdown" });
		breakdown.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.breakdown.title") });
		const total = Math.max(tot.w, 1);
		for (const item of pane.block.breakdown) {
			const row = breakdown.createDiv({ cls: "agent-sessions-efficiency-bar-row" });
			row.createSpan({ cls: "agent-sessions-efficiency-bar-label", text: this.causeLabel(item.cause) });
			const bar = row.createDiv({ cls: "agent-sessions-efficiency-bar" });
			bar.createDiv({ cls: "agent-sessions-efficiency-bar-fill" }).style.width = `${Math.min(100, (item.w / total) * 100)}%`;
			row.createSpan({ cls: "agent-sessions-efficiency-bar-value", text: formatK(item.w) });
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

	private renderConsent(pane: Pane): void {
		const el = pane.consentEl;
		el.empty();
		const block = pane.block;
		if (block.excerpts.length === 0 && block.hits.length === 0) {
			el.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.consent.nothing") });
			return;
		}
		const name = AGENT_NAMES[pane.agent] ?? pane.agent;
		const sessions = new Set(block.excerpts.map((e) => e.session)).size;
		el.createDiv({
			text: t("efficiency.consent.body", {
				agent: name,
				model: this.plugin.settings.efficiencyModel,
				sessions,
				chars: pane.prompt.length.toLocaleString(getLang()),
				tokens: formatK(estimateTokens(pane.prompt)),
			}),
		});
		const windowKey = block.range.rule === "seven_day" ? "seven_day" : "five_hour";
		const usage = block.range.windows?.[windowKey]?.used_percentage;
		if (typeof usage === "number") {
			el.createDiv({
				text: t("efficiency.consent.usage", {
					window: t(`efficiency.consent.window.${windowKey}` as MessageKey),
					percent: Math.round(usage),
				}),
			});
		}
		const waiting = Object.entries(candidates(block.hits)).filter(([d]) => this.hasKey(`efficiency.candidate.${d}`));
		if (waiting.length > 0) {
			el.createDiv({
				text: t("efficiency.consent.candidates", {
					list: waiting.map(([d, count]) => t(`efficiency.candidate.${d}` as MessageKey, { count })).join(", "),
				}),
			});
		}
		if (pane.previous && pane.previous.payloadHash === payloadHash(pane.payload)) {
			el.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.sameAsPrevious") });
		}
		const details = el.createEl("details", { cls: "agent-sessions-efficiency-preview" });
		details.createEl("summary", { text: t("efficiency.consent.preview") });
		details.createEl("pre", { text: pane.prompt });
		const pstate = this.state.panes[pane.agent];
		new Setting(el).addButton((b) =>
			b
				.setButtonText(t(pstate === "result" ? "efficiency.consent.again" : "efficiency.consent.send"))
				.setCta()
				.setDisabled(pstate === "working")
				.onClick(() => void this.analyze(pane))
		);
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
		this.dispatch({ type: "start", agent: pane.agent });
		const abort = new AbortController();
		pane.abort = abort;
		pane.statusEl.setText("");
		pane.statusEl.removeClass("is-error");
		pane.logEl.empty();
		pane.workingEl.toggle(true);
		this.renderConsent(pane);
		const name = AGENT_NAMES[pane.agent] ?? pane.agent;
		let received = 0;
		const started = Date.now();
		const tick = (): void => {
			const params = { agent: name, seconds: Math.floor((Date.now() - started) / 1000), chars: received };
			pane.liveEl.setText(received > 0 ? t("efficiency.workingChars", params) : t("efficiency.working", params));
		};
		tick();
		pane.ticker = window.setInterval(tick, 1000);
		const cancel = pane.workingEl.createEl("button", { text: t("efficiency.cancel") });
		cancel.addEventListener("click", () => abort.abort());
		this.log(pane, t("efficiency.log.asked", { agent: name }));
		try {
			const agent = pane.agent as AgentId;
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
			const outcome = await runAnalysis(pane.prompt, pane.block, (prompt) =>
				inRunFolder(efficiencyRunDir(), (cwd) =>
					runHeadless({
						agent,
						bin,
						env,
						cwd,
						prompt,
						model: this.plugin.settings.efficiencyModel,
						timeoutMs: ANALYSIS_TIMEOUT_MS,
						signal: abort.signal,
						onProgress: (chars) => (received = chars),
					})
				)
			);
			if (outcome.retried) {
				this.log(pane, t("efficiency.log.retried", { error: outcome.retried }));
			}
			this.showCost(pane, outcome.usage);
			if (!outcome.result) {
				this.log(pane, t("efficiency.error.badReply"), true);
				this.dispatch({ type: "failed", agent: pane.agent });
				this.setPaneError(pane, t("efficiency.error.badReply"));
				return;
			}
			for (const note of outcome.result.notes) {
				this.log(pane, t("efficiency.log.removed", { note }));
			}
			this.log(
				pane,
				t("efficiency.log.received", {
					count: outcome.result.findings.filter((f) => !f.fromStats).length,
					seconds: Math.round((Date.now() - started) / 1000),
				})
			);
			pane.findings = outcome.result.findings;
			this.dispatch({ type: "succeeded", agent: pane.agent });
			this.save(pane, outcome.result.findings, outcome.result.dismissed, outcome.usage);
		} catch (err) {
			const failure = classifyAnalysisFailure(err, abort.signal.aborted);
			this.dispatch({ type: failure.kind === "cancelled" ? "cancelled" : "failed", agent: pane.agent });
			this.log(pane, failure.kind === "cancelled" ? t("efficiency.log.cancelled") : t("efficiency.log.failed", { error: String((err as Error)?.message ?? err) }), failure.kind !== "cancelled");
			this.setPaneError(pane, analysisFailureMessage(failure, name));
		} finally {
			this.stopPaneTicker(pane);
			pane.liveEl.setText("");
			cancel.remove();
			pane.abort = null;
			this.renderConsent(pane);
			this.renderFindings(pane);
		}
	}

	private setPaneError(pane: Pane, text: string): void {
		pane.statusEl.setText(text);
		pane.statusEl.addClass("is-error");
	}

	private showCost(pane: Pane, usage: HeadlessUsage | null): void {
		const agent = AGENT_NAMES[pane.agent] ?? pane.agent;
		if (!usage) {
			pane.costEl.setText(t("efficiency.selfCostUnknown"));
			return;
		}
		const params = { input: formatK(usage.input), output: formatK(usage.output), agent };
		pane.costEl.setText(
			usage.usd !== null ? t("efficiency.selfCost", { ...params, usd: formatCost(usage.usd) }) : t("efficiency.selfCostNoUsd", params)
		);
	}

	private save(pane: Pane, findings: Finding[], dismissed: SavedResult["dismissed"], usage: HeadlessUsage | null): void {
		try {
			saveResult(efficiencyDir(), {
				version: 1,
				agent: pane.agent,
				savedAt: Date.now() / 1000,
				model: this.plugin.settings.efficiencyModel,
				range: pane.block.range,
				totals: pane.block.totals,
				hits: pane.block.hits,
				findings,
				dismissed,
				selfCost: usage,
				payloadHash: payloadHash(pane.payload),
				metrics: detectorMetrics(pane.block.hits),
			});
		} catch (err) {
			this.log(pane, t("efficiency.log.failed", { error: (err as Error).message }), true);
		}
	}

	// ---- Findings ----------------------------------------------------------------------------

	private renderFindings(pane: Pane): void {
		const el = pane.findingsEl;
		el.empty();
		const pstate = this.state.panes[pane.agent] ?? "idle";
		let findings = shownFindings(pstate) === "llm" ? pane.findings : statFindings(pane.block.hits);
		if (pstate !== "result" && pstate !== "working" && pane.previous) {
			el.createDiv({
				cls: "agent-sessions-efficiency-subhead",
				text: t("efficiency.previous", { date: formatDateTimeShort(pane.previous.savedAt, getLang()) }),
			});
			findings = pane.previous.findings;
		}
		if (findings.length === 0) {
			el.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.card.none") });
			return;
		}
		const hits = new Map((pane.previous && findings === pane.previous.findings ? pane.previous.hits : pane.block.hits).map((h) => [h.id, h]));
		for (const f of findings) {
			this.renderCard(el, pane, f, hits);
		}
	}

	private sessionLabel(id: string, block: EffAgent): string {
		const row = this.plugin.index.sessions.get(id);
		if (row) {
			return sessionDisplayName(row);
		}
		return block.sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8);
	}

	private renderCard(parent: HTMLElement, pane: Pane, f: Finding, hits: Map<string, EffHit>): void {
		const card = parent.createDiv({ cls: "agent-sessions-efficiency-card" });
		const head = card.createDiv({ cls: "agent-sessions-efficiency-card-head" });
		head.createSpan({ cls: "agent-sessions-efficiency-card-title", text: f.title });
		if (f.fromStats) {
			head.createSpan({ cls: "agent-sessions-efficiency-badge", text: t("efficiency.card.fromStats") });
		}
		const share = pane.block.totals.w > 0 ? Math.round((f.impactW / pane.block.totals.w) * 1000) / 10 : 0;
		card.createDiv({
			cls: "agent-sessions-efficiency-card-impact",
			text: [
				f.impactUsd !== null
					? t("efficiency.card.impactUsd", { tokens: formatK(f.impactW), usd: formatCost(f.impactUsd), share })
					: t("efficiency.card.impact", { tokens: formatK(f.impactW), share }),
				effectText(f),
				this.hasKey(`efficiency.card.confidence.${f.confidence}`) ? t(`efficiency.card.confidence.${f.confidence}` as MessageKey) : "",
			]
				.filter(Boolean)
				.join(" · "),
		});
		if (f.cause) {
			card.createDiv({ cls: "agent-sessions-efficiency-card-cause", text: f.cause });
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
			evidence.createDiv({ cls: "agent-sessions-efficiency-quote", text: `${who}: “${q.text}”` });
		}
		const remedy = card.createDiv({ cls: "agent-sessions-efficiency-card-remedy" });
		remedy.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.card.remedy") });
		if (f.remedy.summary) {
			remedy.createDiv({ text: f.remedy.summary });
		}
		if (f.remedy.steps.length > 0) {
			const list = remedy.createEl("ul");
			for (const step of f.remedy.steps) {
				list.createEl("li", { text: step });
			}
		}
		if (f.remedy.kind === "fix" && f.remedy.change) {
			remedy.createDiv({
				cls: "agent-sessions-efficiency-targets",
				text: t("efficiency.card.targets", { files: f.remedy.targets.join(", ") }) + ` (${t(`efficiency.change.${f.remedy.change}`)})`,
			});
			if (f.remedy.draft) {
				remedy.createDiv({ cls: "agent-sessions-efficiency-subhead", text: t("efficiency.card.draft") });
				remedy.createEl("pre", { text: f.remedy.draft });
			}
			new Setting(remedy).addButton((b) =>
				b
					.setButtonText(t("efficiency.card.fixButton"))
					.setCta()
					.onClick(() => this.openFix(pane, f, hits))
			);
		} else if (TEMPLATE_DETECTORS.has(f.detector)) {
			new Setting(remedy).addButton((b) =>
				b.setButtonText(t("efficiency.card.copyTemplate")).onClick(async () => {
					await navigator.clipboard.writeText(requestTemplate());
					new Notice(t("efficiency.card.copied"));
				})
			);
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
		const prompt = fixPrompt(f, evidence);
		if (!prompt) {
			return;
		}
		new FixConfirmModal(this.plugin, pane.agent as AgentId, f, prompt).open();
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
		this.modalEl.addClass("agent-sessions-efficiency-fix");
		this.setTitle(t("efficiency.fix.confirmTitle"));
		const name = fixSessionName(this.finding);
		new Setting(this.contentEl).setName(t("efficiency.fix.agent")).setDesc(AGENT_NAMES[this.agent] ?? this.agent);
		new Setting(this.contentEl).setName(t("efficiency.fix.name")).setDesc(name);
		const change = this.finding.remedy.change;
		new Setting(this.contentEl)
			.setName(t("efficiency.fix.targets"))
			.setDesc(this.finding.remedy.targets.map((p) => `${p} (${change ? t(`efficiency.change.${change}`) : ""})`).join("\n"));
		this.contentEl.createDiv({ cls: "agent-sessions-efficiency-note", text: t("efficiency.fix.planNote") });
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
