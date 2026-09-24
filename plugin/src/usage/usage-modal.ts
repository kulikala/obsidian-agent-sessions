// The session analytics modal. Calls `json usage ID` once; range selection, "Whole", and "Copy"
// afterward are handled entirely by the local `sumRange`/`toMarkdown`/`nextSelection` (the CLI
// isn't called again). A range is picked by clicking rows in the turn table — the first click is
// the start row, the second is the end row, and clicking the start row again clears the
// selection (back to "whole"). Cards, bars, and the legend reflect the selected range.

import { App, Modal, Notice } from "obsidian";
import { usage } from "../backend/backend";
import { t } from "../i18n";
import {
	effectiveRange,
	formatCost,
	formatDuration,
	formatEpoch,
	formatK,
	nextSelection,
	promptOrBeforeFirst,
	sumRange,
	toMarkdown,
} from "./usage";
import type { Selection } from "./usage";
import type { UsageResult, UsageTurn } from "../types";

const MAX_TOOL_ROWS = 12;

interface BarSegment {
	label: string;
	value: number;
	cls: string;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class UsageModal extends Modal {
	private result: UsageResult | null = null;
	// Not named `selection` — Obsidian's `Modal.open()` writes its own `this.selection = {
	// win, range, focusEl }` (the text selection to restore on close), so a field with that name
	// gets overwritten immediately (confirmed on a real build).
	private turnSelection: Selection = null;
	private bodyEl!: HTMLElement;
	private copyBtn!: HTMLButtonElement;
	private subtitleEl!: HTMLElement;
	private cardsEl!: HTMLElement;
	private inputChartEl!: HTMLElement;
	private outputChartEl!: HTMLElement;
	private toolsChartEl!: HTMLElement;
	private rowEls: HTMLTableRowElement[] = [];

	constructor(
		app: App,
		private agentSessionsPath: string,
		private vaultPath: string,
		private sessionId: string,
		private sessionName: string
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-usage-modal");

		const header = this.contentEl.createDiv({ cls: "agent-sessions-usage-header" });
		header.createDiv({ cls: "agent-sessions-usage-title", text: t("usage.title", { name: this.sessionName }) });
		this.copyBtn = header.createEl("button", { cls: "agent-sessions-usage-copy mod-cta", text: t("action.copy") });
		this.copyBtn.disabled = true;
		this.copyBtn.addEventListener("click", () => this.copyMarkdown());

		this.bodyEl = this.contentEl.createDiv({ cls: "agent-sessions-usage-body" });
		this.bodyEl.createDiv({ cls: "agent-sessions-usage-loading", text: t("usage.loading") });
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		try {
			this.result = await usage(this.agentSessionsPath, this.vaultPath, this.sessionId);
		} catch (err) {
			this.bodyEl.empty();
			this.bodyEl.createDiv({ cls: "agent-sessions-usage-error", text: t("usage.loadFailed", { error: messageOf(err) }) });
			return;
		}
		this.bodyEl.empty();
		this.copyBtn.disabled = false;
		this.buildBody(this.result.turns);
	}

	/** Builds the containers for cards, bars, tool use, and the turn table just once. After this, only renderSelection() runs. */
	private buildBody(turns: UsageTurn[]): void {
		this.subtitleEl = this.bodyEl.createDiv({ cls: "agent-sessions-usage-subtitle" });
		this.cardsEl = this.bodyEl.createDiv({ cls: "agent-sessions-usage-cards" });

		const chartsEl = this.bodyEl.createDiv({ cls: "agent-sessions-usage-charts" });
		this.inputChartEl = chartsEl.createDiv({ cls: "agent-sessions-usage-chart" });
		this.outputChartEl = chartsEl.createDiv({ cls: "agent-sessions-usage-chart" });
		this.toolsChartEl = chartsEl.createDiv({ cls: "agent-sessions-usage-chart agent-sessions-usage-chart-tools" });

		const table = this.bodyEl.createEl("table", { cls: "agent-sessions-usage-table" });
		const thead = table.createEl("thead");
		const headRow = thead.createEl("tr");
		for (const label of [
			"#",
			t("usage.col.time"),
			t("usage.col.prompt"),
			t("usage.col.input"),
			t("usage.col.output"),
			t("usage.col.cost"),
		]) {
			headRow.createEl("th", { text: label });
		}
		const tbody = table.createEl("tbody");
		this.rowEls = turns.map((turn) => {
			const row = tbody.createEl("tr");
			row.createEl("td", { text: String(turn.index) });
			row.createEl("td", { text: formatEpoch(turn.ts), cls: "agent-sessions-usage-num" });
			const promptText = promptOrBeforeFirst(turn) || t("usage.emptyPrompt");
			const promptTd = row.createEl("td", {
				cls: "agent-sessions-usage-prompt",
				text: promptText,
			});
			promptTd.setAttribute("title", promptText);
			row.createEl("td", {
				text: formatK(turn.input + turn.cache_read + turn.cache_create),
				cls: "agent-sessions-usage-num",
			});
			row.createEl("td", { text: formatK(turn.output), cls: "agent-sessions-usage-num" });
			row.createEl("td", { text: formatCost(turn.cost), cls: "agent-sessions-usage-num" });
			row.addEventListener("click", () => {
				this.turnSelection = nextSelection(this.turnSelection, turn.index);
				this.renderSelection();
			});
			return row;
		});

		this.renderSelection();
	}

	/** Redraws just the subtitle, cards, bars, and row highlighting, based on the selection (whole / waiting for start row / a confirmed range). */
	private renderSelection(): void {
		const result = this.result;
		if (!result) {
			return;
		}
		const { from, to, pending } = effectiveRange(this.turnSelection, result.turns);
		const total = sumRange(result.turns, from, to);
		const count = result.turns.filter((turn) => turn.index >= from && turn.index <= to).length;
		const inputTotal = total.input + total.cache_read + total.cache_create;

		this.subtitleEl.empty();
		const label =
			this.turnSelection === null
				? t("usage.whole")
				: pending
					? t("usage.rangePending", { from })
					: t("usage.range", { from, to });
		this.subtitleEl.createSpan({ cls: "agent-sessions-usage-subtitle-label", text: label });
		if (this.turnSelection !== null) {
			const wholeBtn = this.subtitleEl.createEl("button", {
				cls: "agent-sessions-usage-whole-btn",
				text: t("usage.whole"),
			});
			wholeBtn.addEventListener("click", () => {
				this.turnSelection = null;
				this.renderSelection();
			});
		}

		this.cardsEl.empty();
		this.renderCard(
			this.cardsEl,
			t("usage.col.cost"),
			formatCost(total.cost),
			total.estimated ? t("usage.card.estimated") : undefined
		);
		this.renderCard(
			this.cardsEl,
			t("usage.card.tokens"),
			formatK(inputTotal),
			t("usage.card.outputSub", { output: formatK(total.output) })
		);
		this.renderCard(this.cardsEl, t("usage.card.turns"), formatK(count));
		this.renderCard(this.cardsEl, t("usage.card.duration"), formatDuration(total.duration));

		this.renderBar(this.inputChartEl, t("usage.chart.input"), [
			{ label: t("usage.chart.uncached"), value: total.input, cls: "uncached" },
			{ label: t("usage.chart.cacheRead"), value: total.cache_read, cls: "cache-read" },
			{ label: t("usage.chart.cacheCreate"), value: total.cache_create, cls: "cache-create" },
		]);
		const thinking = Math.min(total.thinking, total.output);
		this.renderBar(this.outputChartEl, t("usage.chart.output"), [
			{ label: t("usage.chart.output"), value: Math.max(0, total.output - thinking), cls: "output" },
			{ label: "thinking", value: thinking, cls: "thinking" },
		]);
		this.renderTools(this.toolsChartEl, total.tools);

		result.turns.forEach((turn, i) => {
			const row = this.rowEls[i];
			row.toggleClass("is-selected", this.turnSelection !== null && turn.index >= from && turn.index <= to);
			row.toggleClass("is-anchor", pending && turn.index === from);
		});
	}

	private renderCard(container: HTMLElement, label: string, value: string, sub?: string): void {
		const card = container.createDiv({ cls: "agent-sessions-usage-card" });
		card.createDiv({ cls: "agent-sessions-usage-card-value", text: value });
		card.createDiv({ cls: "agent-sessions-usage-card-label", text: label });
		if (sub) {
			card.createDiv({ cls: "agent-sessions-usage-card-sub", text: sub });
		}
	}

	private renderBar(container: HTMLElement, title: string, segments: BarSegment[]): void {
		container.empty();
		container.createDiv({ cls: "agent-sessions-usage-chart-title", text: title });
		const bar = container.createDiv({ cls: "agent-sessions-usage-bar" });
		const total = segments.reduce((sum, s) => sum + s.value, 0);
		if (total <= 0) {
			bar.addClass("is-empty");
		}
		for (const s of segments) {
			if (s.value <= 0) {
				continue;
			}
			const seg = bar.createDiv({ cls: `agent-sessions-usage-bar-segment is-${s.cls}` });
			seg.style.width = `${(s.value / total) * 100}%`;
		}
		const legend = container.createDiv({ cls: "agent-sessions-usage-legend" });
		for (const s of segments) {
			const item = legend.createDiv({ cls: "agent-sessions-usage-legend-item" });
			item.createSpan({ cls: `agent-sessions-usage-legend-dot is-${s.cls}` });
			item.createSpan({ cls: "agent-sessions-usage-legend-text", text: `${s.label} ${formatK(s.value)}` });
		}
	}

	private renderTools(container: HTMLElement, tools: Record<string, number>): void {
		container.empty();
		container.createDiv({ cls: "agent-sessions-usage-chart-title", text: t("usage.chart.toolsTitle") });
		const entries = Object.entries(tools)
			.sort((a, b) => b[1] - a[1])
			.slice(0, MAX_TOOL_ROWS);
		if (entries.length === 0) {
			container.createDiv({ cls: "agent-sessions-usage-empty", text: t("usage.chart.toolsEmpty") });
			return;
		}
		const max = entries[0][1];
		for (const [name, count] of entries) {
			const row = container.createDiv({ cls: "agent-sessions-usage-tool-row" });
			row.createDiv({ cls: "agent-sessions-usage-tool-name", text: name });
			const barWrap = row.createDiv({ cls: "agent-sessions-usage-tool-bar" });
			const fill = barWrap.createDiv({ cls: "agent-sessions-usage-tool-bar-fill" });
			fill.style.width = `${max > 0 ? (count / max) * 100 : 0}%`;
			row.createDiv({ cls: "agent-sessions-usage-tool-count", text: formatK(count) });
		}
	}

	private copyMarkdown(): void {
		const result = this.result;
		if (!result) {
			return;
		}
		const { from, to } = effectiveRange(this.turnSelection, result.turns);
		const total = sumRange(result.turns, from, to);
		void navigator.clipboard.writeText(toMarkdown(result.turns, from, to, total));
		new Notice(t("notice.markdownCopied"));
	}
}
