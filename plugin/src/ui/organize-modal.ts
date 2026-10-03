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
import { buildCategorySuggest, type CategorySuggest } from "./modals";
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
	checkEl: HTMLInputElement;
	chipEl: HTMLElement;
	categoryEl: HTMLInputElement;
	nameEl: HTMLInputElement;
	summaryEl: HTMLElement;
	commentEl: HTMLInputElement;
}

export class OrganizeModal extends Modal {
	private onlyIncomplete = true;
	private agent: AgentId | null = null;
	private statusEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private liveEl!: HTMLElement;
	private logEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private overallEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private abort: AbortController | null = null;
	private busy = false;
	private reviewRows: ReviewRow[] = [];
	private suggests: CategorySuggest[] = [];
	private ticker: number | null = null;

	constructor(private plugin: AgentSessionsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-organize");
		this.setTitle(t("organize.title"));
		this.agent = pickOrganizeAgent(this.plugin.settings.agents, process.platform);
		this.contentEl.createEl("p", { text: t("organize.intro"), cls: "agent-sessions-organize-intro" });
		this.contentEl.createEl("p", {
			text: this.agent ? t("organize.agentUsing", { agent: agentLabel(this.agent) }) : t("organize.noAgent"),
			cls: this.agent ? "agent-sessions-organize-agent" : "agent-sessions-organize-agent is-error",
		});
		new Setting(this.contentEl).setName(t("organize.onlyIncomplete")).addToggle((toggle) =>
			toggle.setValue(this.onlyIncomplete).onChange((value) => {
				this.onlyIncomplete = value;
			})
		);
		this.statusEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-status" });
		this.progressEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-progress" });
		this.progressEl.hide();
		const liveRow = this.progressEl.createDiv({ cls: "agent-sessions-organize-live" });
		liveRow.createSpan({ cls: "agent-sessions-organize-spinner" });
		this.liveEl = liveRow.createSpan({ cls: "agent-sessions-organize-live-text" });
		this.logEl = this.progressEl.createDiv({ cls: "agent-sessions-organize-log" });
		this.listEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-list" });
		this.overallEl = this.contentEl.createEl("input", {
			type: "text",
			cls: "agent-sessions-organize-overall",
			placeholder: t("organize.overallPlaceholder"),
		});
		this.overallEl.hide();
		this.actionsEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-actions" });
		this.renderActions();
	}

	onClose(): void {
		this.abort?.abort();
		this.stopTicker();
		this.destroySuggests();
		this.contentEl.empty();
	}

	private setStatus(text: string, isError = false): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", isError);
	}

	private renderActions(): void {
		this.actionsEl.empty();
		const setting = new Setting(this.actionsEl);
		if (this.busy) {
			setting.addButton((b) => b.setButtonText(t("action.cancel")).onClick(() => this.abort?.abort()));
			return;
		}
		setting.addButton((b) => b.setButtonText(t("action.cancel")).onClick(() => this.close()));
		const hasResults = this.reviewRows.length > 0;
		if (hasResults) {
			const unchecked = this.reviewRows.filter((r) => !r.checkEl.checked).length;
			if (unchecked > 0) {
				setting.addButton((b) =>
					b.setButtonText(t("organize.resuggest", { count: unchecked })).onClick(() => void this.resuggest())
				);
			}
		}
		setting.addButton((b) =>
			b
				.setButtonText(hasResults ? t("organize.suggestAgain") : t("organize.suggest"))
				.setDisabled(!this.agent)
				.onClick(() => void this.generate())
		);
		if (hasResults) {
			setting.addButton((b) =>
				b
					.setButtonText(t("organize.apply"))
					.setCta()
					.onClick(() => void this.applySelected())
			);
		}
		this.overallEl.toggle(hasResults && this.reviewRows.some((r) => !r.checkEl.checked));
	}

	private destroySuggests(): void {
		for (const s of this.suggests) {
			s.destroy();
		}
		this.suggests = [];
	}

	// ---- Progress -----------------------------------------------------------------

	private log(text: string, isError = false): void {
		const line = this.logEl.createDiv({ cls: "agent-sessions-organize-log-line" });
		if (isError) {
			line.addClass("is-error");
		}
		const now = new Date();
		const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
		line.createSpan({ text: stamp, cls: "agent-sessions-organize-log-time" });
		line.createSpan({ text });
		this.logEl.scrollTop = this.logEl.scrollHeight;
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
		this.progressEl.removeClass("is-done");
		tick();
		this.ticker = window.setInterval(tick, 1000);
	}

	private stopTicker(): void {
		if (this.ticker !== null) {
			window.clearInterval(this.ticker);
			this.ticker = null;
		}
		this.progressEl.addClass("is-done");
		this.liveEl.setText("");
	}

	// ---- Generating ---------------------------------------------------------------

	/** Runs `work` as the one busy operation: progress shown, Cancel wired, errors logged. */
	private async runBusy(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const abort = new AbortController();
		this.abort = abort;
		this.busy = true;
		this.progressEl.show();
		this.renderActions();
		try {
			await work(abort.signal);
		} catch (err) {
			this.stopTicker();
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
			this.busy = false;
			this.abort = null;
			this.renderActions();
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
		this.destroySuggests();
		this.listEl.empty();
		this.reviewRows = [];
		this.logEl.empty();
		this.setStatus("");
		const rows = selectSessions([...this.plugin.index.sessions.values()], { onlyIncomplete: this.onlyIncomplete });
		if (rows.length === 0) {
			this.setStatus(t("organize.none"));
			this.renderActions();
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
				return;
			}
			if (suggestions.length < rows.length) {
				this.log(t("organize.logMissing", { count: rows.length - suggestions.length }));
			}
			this.setStatus(rows.length >= ORGANIZE_BATCH_CAP ? t("organize.cap", { count: rows.length }) : "");
			this.renderReview(rows, candidates, suggestions);
		});
	}

	/** Asks again for the unchecked rows only, with the user's comments; the checked ones stay. */
	private async resuggest(): Promise<void> {
		const agent = this.agent;
		const targets = this.reviewRows.filter((r) => !r.checkEl.checked);
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
					previous: { category: r.categoryEl.value.trim(), name: r.nameEl.value.trim() },
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
		header.createSpan({ text: t("organize.colSummary") });
		header.createSpan({ text: t("organize.colSuggested") });
		header.createSpan({ text: t("organize.colApply"), cls: "agent-sessions-organize-cell-check" });
		const categories = this.plugin.index.categories();
		for (const suggestion of suggestions) {
			const found = byId.get(suggestion.id);
			if (!found) {
				continue;
			}
			this.reviewRows.push(this.renderRow(found.row, found.candidate, suggestion, categories));
		}
		this.refreshChips();
	}

	private renderRow(row: Row, candidate: OrganizeCandidate, suggestion: Suggestion, categories: string[]): ReviewRow {
		const el = this.listEl.createDiv({ cls: "agent-sessions-organize-row" });

		// Current: chip + name.
		const current = el.createDiv({ cls: "agent-sessions-organize-cell-current" });
		const [currentCategory, currentName] = row.name ? splitName(row.name) : [null, ""];
		if (currentCategory) {
			renderCategoryChip(current, currentCategory, this.plugin.index.categoryColorIndex(currentCategory));
		}
		const nameText = row.name ? currentName : sessionDisplayName(row) || t("organize.noName");
		current.createSpan({ text: nameText || t("organize.noName"), cls: "agent-sessions-organize-current-name" });
		current.setAttr("title", row.name || row.label || row.id);

		// Summary of the session's content.
		const fallback = excerpt(candidate.firstPrompt, SUMMARY_FALLBACK_MAX);
		const summaryEl = el.createDiv({ cls: "agent-sessions-organize-cell-summary" });

		// Suggested: chip (the category input inside it) + name input.
		const suggested = el.createDiv({ cls: "agent-sessions-organize-cell-suggested" });
		suggested.createSpan({ text: "→", cls: "agent-sessions-organize-arrow" }).setAttr("aria-hidden", "true");
		const chipEl = suggested.createSpan({ cls: "agent-sessions-row-chip agent-sessions-organize-chip-edit" });
		const categoryEl = chipEl.createEl("input", { type: "text", cls: "agent-sessions-organize-chip-input" });
		categoryEl.placeholder = t("organize.categoryPlaceholder");
		const nameEl = suggested.createEl("input", { type: "text", cls: "agent-sessions-organize-input" });
		nameEl.placeholder = t("organize.namePlaceholder");

		const checkWrap = el.createDiv({ cls: "agent-sessions-organize-cell-check" });
		const checkEl = checkWrap.createEl("input", { type: "checkbox" });

		const commentEl = el.createEl("input", {
			type: "text",
			cls: "agent-sessions-organize-comment",
			placeholder: t("organize.commentPlaceholder"),
		});

		const entry: ReviewRow = { row, candidate, fallback, el, checkEl, chipEl, categoryEl, nameEl, summaryEl, commentEl };
		this.fillRow(entry, suggestion);

		checkEl.addEventListener("change", () => {
			el.toggleClass("is-unchecked", !checkEl.checked);
			this.renderActions();
		});
		categoryEl.addEventListener("input", () => {
			this.sizeChipInput(categoryEl);
			this.refreshChips();
		});
		this.bindCategoryInput(categoryEl, categories);
		return entry;
	}

	/** Puts a suggestion into a row's fields, re-ticking it when it would change the name. */
	private fillRow(entry: ReviewRow, suggestion: Suggestion): void {
		entry.categoryEl.value = suggestion.category;
		entry.nameEl.value = suggestion.name;
		entry.summaryEl.setText(suggestion.summary || entry.fallback);
		entry.summaryEl.setAttr("title", suggestion.summary || entry.fallback);
		entry.checkEl.checked = changesName(entry.row.name, suggestion);
		entry.el.toggleClass("is-unchecked", !entry.checkEl.checked);
		this.sizeChipInput(entry.categoryEl);
	}

	private sizeChipInput(inputEl: HTMLInputElement): void {
		inputEl.size = Math.max(6, Array.from(inputEl.value || inputEl.placeholder).length + 1);
	}

	/**
	 * Colors every suggested chip the way it will look once created: a category that exists keeps
	 * its color, new ones get the slots they will be assigned (in row order), nothing is saved.
	 */
	private refreshChips(): void {
		const values = this.reviewRows.map((r) => r.categoryEl.value.trim());
		const colorFor = this.plugin.index.categoryColorPreview(values.filter((v) => v));
		this.reviewRows.forEach((r, i) => {
			const category = values[i];
			r.chipEl.toggleClass("is-empty", !category);
			r.chipEl.style.setProperty("--as-chip-hue", String(paletteHueDeg(category ? colorFor(category) : 0)));
		});
	}

	private bindCategoryInput(inputEl: HTMLInputElement, categories: string[]): void {
		const suggest = buildCategorySuggest(
			inputEl,
			categories,
			(c) => this.plugin.index.categoryColorIndex(c),
			(cat) => {
				inputEl.value = cat;
				this.sizeChipInput(inputEl);
				this.refreshChips();
				suggest.close();
			}
		);
		this.suggests.push(suggest);
		inputEl.addEventListener("focus", () => suggest.openFor(inputEl.value));
		inputEl.addEventListener("input", () => suggest.openFor(inputEl.value));
		inputEl.addEventListener("keydown", (evt) => {
			if (!suggest.isOpen()) {
				return;
			}
			if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
				evt.preventDefault();
				suggest.moveHighlight(evt.key === "ArrowDown" ? 1 : -1);
			} else if (evt.key === "Enter") {
				evt.preventDefault();
				suggest.confirmHighlighted();
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				suggest.close();
			}
		});
		inputEl.addEventListener("blur", () => window.setTimeout(() => suggest.close(), 0));
	}

	// ---- Applying -----------------------------------------------------------------

	/** One at a time, through `renameSession` (the row menu's path): each may start the session
	 * headless to send `/rename`, so they are not run in parallel. */
	private async applySelected(): Promise<void> {
		const picked = this.reviewRows
			.filter((r) => r.checkEl.checked)
			.map((r) => ({ id: r.row.id, name: fullName(r.categoryEl.value, r.nameEl.value) }))
			.filter((p) => p.name);
		if (picked.length === 0) {
			return;
		}
		const abort = new AbortController();
		this.abort = abort;
		this.busy = true;
		this.renderActions();
		this.log(t("organize.logApplying", { count: picked.length }));
		let done = 0;
		for (const p of picked) {
			if (abort.signal.aborted) {
				break;
			}
			this.setStatus(t("organize.applying", { done, total: picked.length }));
			await this.plugin.renameSession(p.id, p.name);
			done++;
		}
		this.busy = false;
		this.abort = null;
		new Notice(t("organize.applied", { count: done }));
		this.close();
	}
}
