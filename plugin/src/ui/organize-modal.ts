// "Organize names and categories": asks a headless agent (Claude Code, else Codex, else OpenCode)
// for a `Category: Name` and a one-line summary per session, lets the user edit, pick and
// comment, and applies the picked ones through the same rename path as the row menu
// (`plugin.renameSession`). Nothing is applied without pressing Apply.

import { homedir } from "os";
import { join } from "path";
import { Modal, Notice, Platform, Setting } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { loginEnv, resolveAgentBinary, withBinDirOnPath } from "../backend/backend";
import { runHeadless } from "../backend/headless";
import { t } from "../i18n";
import type { Row } from "../sessions/index";
import {
	buildFollowUpPrompt,
	buildPrompt,
	changesName,
	excerpt,
	fullName,
	ORGANIZE_BATCH_CAP,
	parseSuggestions,
	selectSessions,
	toCandidate,
	type OrganizeCandidate,
	type Suggestion,
} from "../sessions/organize";
import { agentLabel, pickOrganizeAgent } from "../sessions/organize-agent";
import { sessionDisplayName } from "../sessions/name";
import { splitName } from "../sessions/tree";
import { parseEnvLines, type AgentId } from "../settings";
import { renderCategoryChip } from "./chip";
import { reviewState, viewAfterRun, type OrganizeView } from "./organize-view";
import { createRoundCheck, type RoundCheck } from "./round-check";
import { paletteHueDeg } from "../sessions/category";

const DETAIL_CONCURRENCY = 4;
/** A folder with no CLAUDE.md above it, so the headless run doesn't pick up a project's instructions. */
const HEADLESS_CWD = join(homedir(), ".agents", "sessions", "organize");
const SUMMARY_FALLBACK_MAX = 120;

interface ReviewRow {
	row: Row;
	candidate: OrganizeCandidate;
	/** The first prompt, shown when the model gave no summary. */
	fallback: string;
	el: HTMLElement;
	check: RoundCheck;
	chipEl: HTMLElement;
	/** The suggested category and name: shown as text, changed only by a new suggestion. */
	category: string;
	name: string;
	nameEl: HTMLElement;
	summaryEl: HTMLElement;
	commentEl: HTMLInputElement;
}

export class OrganizeModal extends Modal {
	private onlyIncomplete = true;
	private agent: AgentId | null = null;
	private statusEl!: HTMLElement;
	private views!: Record<OrganizeView, HTMLElement>;
	private view: OrganizeView = "start";
	private startActionsEl!: HTMLElement;
	private resultActionsEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private liveEl!: HTMLElement;
	private logEl!: HTMLElement;
	private logDetailsEl!: HTMLDetailsElement;
	private logCopyEl!: HTMLElement;
	private overallEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private abort: AbortController | null = null;
	private reviewRows: ReviewRow[] = [];
	private ticker: number | null = null;

	constructor(private plugin: AgentSessionsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-organize");
		this.setTitle(t("organize.title"));
		this.agent = pickOrganizeAgent(this.plugin.settings.agents, process.platform);
		this.statusEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-status" });
		this.views = {
			start: this.contentEl.createDiv({ cls: "agent-sessions-organize-view" }),
			working: this.contentEl.createDiv({ cls: "agent-sessions-organize-view" }),
			result: this.contentEl.createDiv({ cls: "agent-sessions-organize-view" }),
		};
		this.buildStartView(this.views.start);
		this.buildWorkingView(this.views.working);
		this.buildResultView(this.views.result);
		this.logDetailsEl = createEl("details", { cls: "agent-sessions-organize-logdetails" });
		this.logDetailsEl.createEl("summary", { text: t("organize.showLog") });
		this.logCopyEl = this.logDetailsEl.createDiv({ cls: "agent-sessions-organize-log" });
		this.showView("start");
	}

	/** Shows `view` and hides the others; the last run's log disclosure follows the visible view. */
	private showView(view: OrganizeView): void {
		this.view = view;
		for (const [name, el] of Object.entries(this.views)) {
			el.toggle(name === view);
		}
		if (view !== "working") {
			this.views[view].appendChild(this.logDetailsEl);
			this.logDetailsEl.toggle(this.logCopyEl.childElementCount > 0);
		}
	}

	private buildStartView(el: HTMLElement): void {
		el.createEl("p", { text: t("organize.intro"), cls: "agent-sessions-organize-intro" });
		el.createEl("p", {
			text: this.agent ? t("organize.agentUsing", { agent: agentLabel(this.agent) }) : t("organize.noAgent"),
			cls: this.agent ? "agent-sessions-organize-agent" : "agent-sessions-organize-agent is-error",
		});
		new Setting(el).setName(t("organize.onlyIncomplete")).addToggle((toggle) =>
			toggle.setValue(this.onlyIncomplete).onChange((value) => {
				this.onlyIncomplete = value;
			})
		);
		this.startActionsEl = el.createDiv({ cls: "agent-sessions-organize-actions" });
		const setting = new Setting(this.startActionsEl);
		setting.addButton((b) => b.setButtonText(t("action.cancel")).onClick(() => this.close()));
		setting.addButton((b) =>
			b
				.setButtonText(t("organize.suggest"))
				.setDisabled(!this.agent)
				.setCta()
				.onClick(() => void this.generate())
		);
	}

	private buildWorkingView(el: HTMLElement): void {
		this.progressEl = el.createDiv({ cls: "agent-sessions-organize-progress" });
		const liveRow = this.progressEl.createDiv({ cls: "agent-sessions-organize-live" });
		liveRow.createSpan({ cls: "agent-sessions-organize-spinner" });
		this.liveEl = liveRow.createSpan({ cls: "agent-sessions-organize-live-text" });
		this.logEl = this.progressEl.createDiv({ cls: "agent-sessions-organize-log" });
		const actions = el.createDiv({ cls: "agent-sessions-organize-actions" });
		new Setting(actions).addButton((b) => b.setButtonText(t("action.cancel")).onClick(() => this.abort?.abort()));
	}

	private buildResultView(el: HTMLElement): void {
		this.listEl = el.createDiv({ cls: "agent-sessions-organize-list" });
		this.overallEl = el.createEl("input", {
			type: "text",
			cls: "agent-sessions-organize-overall",
			placeholder: t("organize.overallPlaceholder"),
		});
		this.overallEl.hide();
		this.resultActionsEl = el.createDiv({ cls: "agent-sessions-organize-actions" });
	}

	onClose(): void {
		this.abort?.abort();
		this.stopTicker();
		this.contentEl.empty();
	}

	private setStatus(text: string, isError = false): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", isError);
	}

	/** The result view's buttons, which depend on how many rows are unticked. */
	private renderActions(): void {
		this.resultActionsEl.empty();
		const setting = new Setting(this.resultActionsEl);
		setting.addButton((b) => b.setButtonText(t("action.cancel")).onClick(() => this.close()));
		const state = reviewState(this.reviewRows.map((r) => r.check.get()));
		const unchecked = state.unchecked;
		if (state.showResuggest) {
			setting.addButton((b) =>
				b.setButtonText(t("organize.resuggest", { count: unchecked })).onClick(() => void this.resuggest())
			);
		}
		setting.addButton((b) =>
			b
				.setButtonText(t("organize.suggestAgain"))
				.setDisabled(!this.agent)
				.onClick(() => void this.generate())
		);
		setting.addButton((b) =>
			b
				.setButtonText(t("organize.apply"))
				.setCta()
				.setDisabled(!state.canApply)
				.onClick(() => void this.applySelected())
		);
		this.overallEl.toggle(state.showResuggest);
	}

	// ---- Progress -----------------------------------------------------------------

	private log(text: string, isError = false): void {
		const now = new Date();
		const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
		for (const container of [this.logEl, this.logCopyEl]) {
			const line = container.createDiv({ cls: "agent-sessions-organize-log-line" });
			if (isError) {
				line.addClass("is-error");
			}
			line.createSpan({ text: stamp, cls: "agent-sessions-organize-log-time" });
			line.createSpan({ text });
			container.scrollTop = container.scrollHeight;
		}
	}

	/** Shows the spinner and the live line, which ticks every second until `stopTicker`. */
	private startTicker(agent: AgentId, received: () => number): void {
		this.stopTicker();
		const started = Date.now();
		const tick = (): void => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			const chars = received();
			const params = { agent: agentLabel(agent), seconds, chars };
			this.liveEl.setText(chars > 0 ? t("organize.workingChars", params) : t("organize.working", params));
		};
		tick();
		this.ticker = window.setInterval(tick, 1000);
	}

	private stopTicker(): void {
		if (this.ticker !== null) {
			window.clearInterval(this.ticker);
			this.ticker = null;
		}
		this.liveEl.setText("");
	}

	// ---- Generating ---------------------------------------------------------------

	/**
	 * Runs `work` as the one busy operation on the working view: Cancel wired, errors logged. `work`
	 * resolves true when it produced results to show; otherwise (or on error or cancel) the dialog
	 * returns to the view it came from, status and log in place.
	 */
	private async runBusy(work: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
		const from = this.view;
		const abort = new AbortController();
		this.abort = abort;
		this.setStatus("");
		this.logEl.empty();
		this.logCopyEl.empty();
		this.showView("working");
		let produced = false;
		try {
			produced = await work(abort.signal);
		} catch (err) {
			if (abort.signal.aborted) {
				this.log(t("organize.logCancelled"));
				this.setStatus("");
			} else {
				const error = err instanceof Error ? err.message : String(err);
				this.log(t("organize.logFailed", { error }), true);
				this.setStatus(t("organize.failed", { error }), true);
			}
		} finally {
			this.stopTicker();
			this.abort = null;
			this.renderActions();
			this.showView(viewAfterRun(from, produced));
		}
	}

	/** One headless request for `prompt`; resolves with the suggestions for `ids`. */
	private async ask(agent: AgentId, prompt: string, ids: string[], signal: AbortSignal): Promise<Suggestion[]> {
		const settings = this.plugin.settings.agents[agent];
		const bin = await resolveAgentBinary(agent, settings.path, Platform.isMacOS);
		const env = withBinDirOnPath(
			{
				...process.env,
				...(await loginEnv(Platform.isMacOS).catch((): Record<string, string> => ({}))),
				...parseEnvLines(settings.env),
			},
			bin
		);
		let received = 0;
		const started = Date.now();
		this.log(t("organize.logAsked", { agent: agentLabel(agent) }));
		this.startTicker(agent, () => received);
		const text = await runHeadless({
			agent,
			bin,
			env,
			cwd: HEADLESS_CWD,
			prompt,
			signal,
			onProgress: (chars) => (received = chars),
		});
		const suggestions = parseSuggestions(text, ids);
		this.stopTicker();
		this.log(
			t("organize.logReceived", { count: suggestions.length, seconds: Math.round((Date.now() - started) / 1000) })
		);
		return suggestions;
	}

	private async generate(): Promise<void> {
		this.agent = pickOrganizeAgent(this.plugin.settings.agents, process.platform);
		const agent = this.agent;
		if (!agent) {
			this.setStatus(t("organize.noAgent"), true);
			return;
		}
		this.setStatus("");
		const rows = selectSessions([...this.plugin.index.sessions.values()], { onlyIncomplete: this.onlyIncomplete });
		if (rows.length === 0) {
			this.setStatus(t("organize.none"));
			return;
		}
		await this.runBusy(async (signal) => {
			this.log(t("organize.logReading", { count: rows.length }));
			const candidates = await this.readCandidates(rows, signal);
			this.log(t("organize.logRead", { count: rows.length }));
			const suggestions = await this.ask(
				agent,
				buildPrompt(candidates, this.plugin.index.categories()),
				rows.map((r) => r.id),
				signal
			);
			if (suggestions.length === 0) {
				this.setStatus(t("organize.noSuggestions"), true);
				return false;
			}
			if (suggestions.length < rows.length) {
				this.log(t("organize.logMissing", { count: rows.length - suggestions.length }));
			}
			this.setStatus(rows.length >= ORGANIZE_BATCH_CAP ? t("organize.cap", { count: rows.length }) : "");
			this.listEl.empty();
			this.reviewRows = [];
			this.overallEl.value = "";
			this.renderReview(rows, candidates, suggestions);
			return true;
		});
	}

	/** Asks again for the unchecked rows only, with the user's comments; the checked ones stay. */
	private async resuggest(): Promise<void> {
		const agent = this.agent;
		const targets = this.reviewRows.filter((r) => !r.check.get());
		if (!agent || targets.length === 0) {
			return;
		}
		const overall = this.overallEl.value;
		await this.runBusy(async (signal) => {
			const prompt = buildFollowUpPrompt(
				targets.map((r) => r.candidate),
				this.plugin.index.categories(),
				targets.map((r) => ({
					id: r.row.id,
					previous: { category: r.category, name: r.name },
					comment: r.commentEl.value,
				})),
				overall
			);
			const suggestions = await this.ask(
				agent,
				prompt,
				targets.map((r) => r.row.id),
				signal
			);
			const byId = new Map(suggestions.map((s) => [s.id, s]));
			if (suggestions.length < targets.length) {
				this.log(t("organize.logMissing", { count: targets.length - suggestions.length }));
			}
			for (const target of targets) {
				const suggestion = byId.get(target.row.id);
				if (suggestion) {
					this.fillRow(target, suggestion);
					target.commentEl.value = "";
				}
			}
			this.refreshChips();
			return true;
		});
	}

	/** The excerpts, a few sessions at a time (each is one `json detail` process). */
	private async readCandidates(rows: Row[], signal: AbortSignal): Promise<OrganizeCandidate[]> {
		const out: OrganizeCandidate[] = new Array<OrganizeCandidate>(rows.length);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < rows.length && !signal.aborted) {
				const i = next++;
				const detail = await this.plugin.index.getDetail(rows[i].id).catch(() => null);
				out[i] = toCandidate(rows[i], detail);
			}
		};
		await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, rows.length) }, worker));
		if (signal.aborted) {
			throw new Error("aborted");
		}
		return out;
	}

	// ---- Review -------------------------------------------------------------------

	private renderReview(rows: Row[], candidates: OrganizeCandidate[], suggestions: Suggestion[]): void {
		const byId = new Map(rows.map((r, i) => [r.id, { row: r, candidate: candidates[i] }]));
		const header = this.listEl.createDiv({ cls: "agent-sessions-organize-row is-header" });
		header.createSpan({ text: t("organize.colCurrent") });
		header.createSpan({ text: t("organize.colSuggested") });
		header.createSpan({ text: t("organize.colApply"), cls: "agent-sessions-organize-cell-check" });
		for (const suggestion of suggestions) {
			const found = byId.get(suggestion.id);
			if (!found) {
				continue;
			}
			this.reviewRows.push(this.renderRow(found.row, found.candidate, suggestion));
		}
		this.refreshChips();
		this.renderActions();
	}

	private renderRow(row: Row, candidate: OrganizeCandidate, suggestion: Suggestion): ReviewRow {
		const el = this.listEl.createDiv({ cls: "agent-sessions-organize-row" });

		// Current: chip + name on the first line, the session summary muted below.
		const current = el.createDiv({ cls: "agent-sessions-organize-cell-current" });
		const currentLine = current.createDiv({ cls: "agent-sessions-organize-current-line" });
		const [currentCategory, currentName] = row.name ? splitName(row.name) : [null, ""];
		if (currentCategory) {
			renderCategoryChip(currentLine, currentCategory, this.plugin.index.categoryColorIndex(currentCategory));
		}
		const nameText = row.name ? currentName : sessionDisplayName(row) || t("organize.noName");
		currentLine.createSpan({ text: nameText || t("organize.noName"), cls: "agent-sessions-organize-current-name" });
		current.setAttr("title", row.name || row.label || row.id);
		const fallback = excerpt(candidate.firstPrompt, SUMMARY_FALLBACK_MAX);
		const summaryEl = current.createDiv({ cls: "agent-sessions-organize-summary" });

		// Suggested: the category as a read-only chip + the name as plain text.
		const suggested = el.createDiv({ cls: "agent-sessions-organize-cell-suggested" });
		suggested.createSpan({ text: "→", cls: "agent-sessions-organize-arrow" }).setAttr("aria-hidden", "true");
		const chipEl = suggested.createSpan({ cls: "agent-sessions-row-chip agent-sessions-organize-chip" });
		const nameEl = suggested.createSpan({ cls: "agent-sessions-organize-suggested-name" });

		const checkWrap = el.createDiv({ cls: "agent-sessions-organize-cell-check" });
		const commentEl = el.createEl("input", {
			type: "text",
			cls: "agent-sessions-organize-comment",
			placeholder: t("organize.commentPlaceholder"),
		});
		const check = createRoundCheck(checkWrap, {
			value: true,
			label: t("organize.applyThis"),
			onChange: (value) => {
				el.toggleClass("is-unchecked", !value);
				this.renderActions();
			},
		});
		// The whole cell is the hit area.
		checkWrap.addEventListener("click", (evt) => {
			if (evt.target === checkWrap) {
				check.el.click();
			}
		});

		const entry: ReviewRow = { row, candidate, fallback, el, check, chipEl, category: "", name: "", nameEl, summaryEl, commentEl };
		this.fillRow(entry, suggestion);
		return entry;
	}

	/** Puts a suggestion into a row, re-ticking it when it would change the name. */
	private fillRow(entry: ReviewRow, suggestion: Suggestion): void {
		entry.category = suggestion.category.trim();
		entry.name = suggestion.name;
		entry.chipEl.setText(entry.category || t("organize.noCategory"));
		entry.nameEl.setText(suggestion.name);
		entry.summaryEl.setText(suggestion.summary || entry.fallback);
		entry.summaryEl.setAttr("title", suggestion.summary || entry.fallback);
		const on = changesName(entry.row.name, suggestion);
		entry.check.set(on);
		entry.el.toggleClass("is-unchecked", !on);
	}

	/**
	 * Colors every suggested chip the way it will look once created: a category that exists keeps
	 * its color, new ones get the slots they will be assigned (in row order), nothing is saved.
	 */
	private refreshChips(): void {
		const values = this.reviewRows.map((r) => r.category);
		const colorFor = this.plugin.index.categoryColorPreview(values.filter((v) => v));
		this.reviewRows.forEach((r, i) => {
			const category = values[i];
			r.chipEl.toggleClass("is-empty", !category);
			r.chipEl.style.setProperty("--as-chip-hue", String(paletteHueDeg(category ? colorFor(category) : 0)));
		});
	}

	// ---- Applying -----------------------------------------------------------------

	/** One at a time, through `renameSession` (the row menu's path): each may start the session
	 * headless to send `/rename`, so they are not run in parallel. */
	private async applySelected(): Promise<void> {
		const picked = this.reviewRows
			.filter((r) => r.check.get())
			.map((r) => ({ id: r.row.id, name: fullName(r.category, r.name) }))
			.filter((p) => p.name);
		if (picked.length === 0) {
			return;
		}
		const abort = new AbortController();
		this.abort = abort;
		this.setStatus("");
		this.logEl.empty();
		this.logCopyEl.empty();
		this.showView("working");
		this.log(t("organize.logApplying", { count: picked.length }));
		let done = 0;
		for (const p of picked) {
			if (abort.signal.aborted) {
				break;
			}
			this.liveEl.setText(t("organize.applying", { done, total: picked.length }));
			await this.plugin.renameSession(p.id, p.name);
			done++;
		}
		this.abort = null;
		new Notice(t("organize.applied", { count: done }));
		this.close();
	}
}
