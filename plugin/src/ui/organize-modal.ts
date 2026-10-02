// "Organize names and categories": asks a headless Claude Code for a `Category: Name` per
// session, lets the user edit and pick, and applies the picked ones through the same rename
// path as the row menu (`plugin.renameSession`). Nothing is applied without pressing Apply.

import { homedir } from "os";
import { join } from "path";
import { Modal, Notice, Platform, Setting } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { loginEnv, resolveAgentBinary, withBinDirOnPath } from "../backend/backend";
import { runClaudeHeadless } from "../backend/claude-headless";
import { t } from "../i18n";
import type { Row } from "../sessions/index";
import {
	buildPrompt,
	changesName,
	fullName,
	ORGANIZE_BATCH_CAP,
	parseSuggestions,
	selectSessions,
	toCandidate,
	type OrganizeCandidate,
	type Suggestion,
} from "../sessions/organize";
import { sessionDisplayName } from "../sessions/name";
import { parseEnvLines } from "../settings";
import { buildCategorySuggest, type CategorySuggest } from "./modals";

const DETAIL_CONCURRENCY = 4;
/** A folder with no CLAUDE.md above it, so the headless run doesn't pick up a project's instructions. */
const HEADLESS_CWD = join(homedir(), ".agents", "sessions", "organize");

interface ReviewRow {
	row: Row;
	suggestion: Suggestion;
	checkEl: HTMLInputElement;
	categoryEl: HTMLInputElement;
	nameEl: HTMLInputElement;
}

export class OrganizeModal extends Modal {
	private onlyIncomplete = true;
	private statusEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private listEl!: HTMLElement;
	private abort: AbortController | null = null;
	private busy = false;
	private reviewRows: ReviewRow[] = [];
	private suggests: CategorySuggest[] = [];

	constructor(private plugin: AgentSessionsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-organize");
		this.setTitle(t("organize.title"));
		this.contentEl.createEl("p", { text: t("organize.intro"), cls: "agent-sessions-organize-intro" });
		new Setting(this.contentEl).setName(t("organize.onlyIncomplete")).addToggle((toggle) =>
			toggle.setValue(this.onlyIncomplete).onChange((value) => {
				this.onlyIncomplete = value;
			})
		);
		this.statusEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-status" });
		this.listEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-list" });
		this.actionsEl = this.contentEl.createDiv({ cls: "agent-sessions-organize-actions" });
		this.renderActions();
	}

	onClose(): void {
		this.abort?.abort();
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
		setting.addButton((b) =>
			b.setButtonText(hasResults ? t("organize.suggestAgain") : t("organize.suggest")).onClick(() => void this.generate())
		);
		if (hasResults) {
			setting.addButton((b) =>
				b
					.setButtonText(t("organize.apply"))
					.setCta()
					.onClick(() => void this.applySelected())
			);
		}
	}

	private destroySuggests(): void {
		for (const s of this.suggests) {
			s.destroy();
		}
		this.suggests = [];
	}

	// ---- Generating ---------------------------------------------------------------

	private async generate(): Promise<void> {
		this.destroySuggests();
		this.listEl.empty();
		this.reviewRows = [];
		const agent = this.plugin.settings.agents.claude;
		if (!agent.enabled) {
			this.setStatus(t("organize.claudeDisabled"), true);
			this.renderActions();
			return;
		}
		const rows = selectSessions([...this.plugin.index.sessions.values()], { onlyIncomplete: this.onlyIncomplete });
		if (rows.length === 0) {
			this.setStatus(t("organize.none"));
			this.renderActions();
			return;
		}
		const abort = new AbortController();
		this.abort = abort;
		this.busy = true;
		this.renderActions();
		try {
			const candidates = await this.readCandidates(rows, abort.signal);
			this.setStatus(t("organize.asking"));
			const bin = await resolveAgentBinary("claude", agent.path, Platform.isMacOS);
			const env = withBinDirOnPath(
				{
					...process.env,
					...(await loginEnv(Platform.isMacOS).catch((): Record<string, string> => ({}))),
					...parseEnvLines(agent.env),
				},
				bin
			);
			const text = await runClaudeHeadless({
				bin,
				env,
				cwd: HEADLESS_CWD,
				prompt: buildPrompt(candidates, this.plugin.index.categories()),
				signal: abort.signal,
			});
			const suggestions = parseSuggestions(
				text,
				rows.map((r) => r.id)
			);
			if (suggestions.length === 0) {
				this.setStatus(t("organize.noSuggestions"), true);
			} else {
				this.setStatus(rows.length >= ORGANIZE_BATCH_CAP ? t("organize.cap", { count: rows.length }) : "");
				this.renderReview(rows, suggestions);
			}
		} catch (err) {
			if (abort.signal.aborted) {
				this.setStatus("");
			} else {
				this.setStatus(t("organize.failed", { error: err instanceof Error ? err.message : String(err) }), true);
			}
		} finally {
			this.busy = false;
			this.abort = null;
			this.renderActions();
		}
	}

	/** The excerpts, a few sessions at a time (each is one `json detail` process). */
	private async readCandidates(rows: Row[], signal: AbortSignal): Promise<OrganizeCandidate[]> {
		const out: OrganizeCandidate[] = new Array<OrganizeCandidate>(rows.length);
		let next = 0;
		let done = 0;
		const worker = async (): Promise<void> => {
			while (next < rows.length && !signal.aborted) {
				const i = next++;
				const detail = await this.plugin.index.getDetail(rows[i].id).catch(() => null);
				out[i] = toCandidate(rows[i], detail);
				done++;
				this.setStatus(t("organize.reading", { done, total: rows.length }));
			}
		};
		this.setStatus(t("organize.reading", { done: 0, total: rows.length }));
		await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, rows.length) }, worker));
		if (signal.aborted) {
			throw new Error("aborted");
		}
		return out;
	}

	// ---- Review -------------------------------------------------------------------

	private renderReview(rows: Row[], suggestions: Suggestion[]): void {
		const byId = new Map(rows.map((r) => [r.id, r]));
		const header = this.listEl.createDiv({ cls: "agent-sessions-organize-row is-header" });
		header.createSpan();
		header.createSpan({ text: t("organize.colSession") });
		header.createSpan({ text: t("organize.colCategory") });
		header.createSpan({ text: t("organize.colName") });
		const categories = this.plugin.index.categories();
		const colorIndexFor = (c: string) => this.plugin.index.categoryColorIndex(c);
		for (const suggestion of suggestions) {
			const row = byId.get(suggestion.id);
			if (!row) {
				continue;
			}
			const el = this.listEl.createDiv({ cls: "agent-sessions-organize-row" });
			const checkEl = el.createEl("input", { type: "checkbox" });
			checkEl.checked = changesName(row.name, suggestion);
			const current = el.createSpan({ cls: "agent-sessions-organize-current" });
			current.setText(row.name || sessionDisplayName(row) || t("organize.noName"));
			current.setAttr("title", row.name || row.label || row.id);
			const categoryEl = el.createEl("input", { type: "text", cls: "agent-sessions-organize-input" });
			categoryEl.value = suggestion.category;
			categoryEl.placeholder = t("organize.categoryPlaceholder");
			const nameEl = el.createEl("input", { type: "text", cls: "agent-sessions-organize-input" });
			nameEl.value = suggestion.name;
			nameEl.placeholder = t("organize.namePlaceholder");
			this.bindCategoryInput(categoryEl, categories, colorIndexFor);
			this.reviewRows.push({ row, suggestion, checkEl, categoryEl, nameEl });
		}
	}

	private bindCategoryInput(
		inputEl: HTMLInputElement,
		categories: string[],
		colorIndexFor: (category: string) => number
	): void {
		const suggest = buildCategorySuggest(inputEl, categories, colorIndexFor, (cat) => {
			inputEl.value = cat;
			suggest.close();
		});
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
