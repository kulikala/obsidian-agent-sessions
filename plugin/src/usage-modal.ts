// セッション解析結果のモーダル（D-45）。`json usage ID` を 1 回呼び、以後の区間選択・
// 「全体」・「コピー」はローカルの `sumRange`／`toMarkdown`／`nextSelection` だけで完結する
// （CLI を呼び直さない）。区間はターン表の行クリックで選ぶ——1 回目が開始行、2 回目が終了行、
// 開始行をもう一度クリックすると解除（全体に戻る）。カード・バー・凡例は選んだ区間の値。

import { App, Modal, Notice } from "obsidian";
import { usage } from "./backend";
import {
	effectiveRange,
	formatCost,
	formatDuration,
	formatEpoch,
	formatK,
	nextSelection,
	sumRange,
	toMarkdown,
} from "./usage";
import type { Selection } from "./usage";
import type { UsageResult, UsageTurn } from "./types";

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
	private selection: Selection = null;
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
		private sessionId: string,
		private sessionName: string
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-usage-modal");

		const header = this.contentEl.createDiv({ cls: "agent-sessions-usage-header" });
		header.createDiv({ cls: "agent-sessions-usage-title", text: `セッション解析結果：${this.sessionName}` });
		this.copyBtn = header.createEl("button", { cls: "agent-sessions-usage-copy mod-cta", text: "コピー" });
		this.copyBtn.disabled = true;
		this.copyBtn.addEventListener("click", () => this.copyMarkdown());

		this.bodyEl = this.contentEl.createDiv({ cls: "agent-sessions-usage-body" });
		this.bodyEl.createDiv({ cls: "agent-sessions-usage-loading", text: "読み込み中…" });
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		try {
			this.result = await usage(this.agentSessionsPath, this.sessionId);
		} catch (err) {
			this.bodyEl.empty();
			this.bodyEl.createDiv({ cls: "agent-sessions-usage-error", text: `集計に失敗しました: ${messageOf(err)}` });
			return;
		}
		this.bodyEl.empty();
		this.copyBtn.disabled = false;
		this.buildBody(this.result.turns);
	}

	/** カード・バー・ツール使用・ターン表の入れ物を 1 回だけ組む。以後は renderSelection() だけが動く。 */
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
		for (const label of ["#", "時刻", "指示", "入力", "出力", "コスト"]) {
			headRow.createEl("th", { text: label });
		}
		const tbody = table.createEl("tbody");
		this.rowEls = turns.map((t) => {
			const row = tbody.createEl("tr");
			row.createEl("td", { text: String(t.index) });
			row.createEl("td", { text: formatEpoch(t.ts), cls: "agent-sessions-usage-num" });
			const promptTd = row.createEl("td", { cls: "agent-sessions-usage-prompt", text: t.prompt || "（空）" });
			promptTd.setAttribute("title", t.prompt);
			row.createEl("td", { text: formatK(t.input + t.cache_read + t.cache_create), cls: "agent-sessions-usage-num" });
			row.createEl("td", { text: formatK(t.output), cls: "agent-sessions-usage-num" });
			row.createEl("td", { text: formatCost(t.cost), cls: "agent-sessions-usage-num" });
			row.addEventListener("click", () => {
				this.selection = nextSelection(this.selection, t.index);
				this.renderSelection();
			});
			return row;
		});

		this.renderSelection();
	}

	/** 選択（全体／開始行待ち／確定区間）に応じて、副題・カード・バー・行の強調だけを描き直す。 */
	private renderSelection(): void {
		const result = this.result;
		if (!result) {
			return;
		}
		const { from, to, pending } = effectiveRange(this.selection, result.turns);
		const total = sumRange(result.turns, from, to);
		const count = result.turns.filter((t) => t.index >= from && t.index <= to).length;
		const inputTotal = total.input + total.cache_read + total.cache_create;

		this.subtitleEl.empty();
		const label =
			this.selection === null ? "全体" : pending ? `#${from}〜（終了行をクリック）` : `#${from}〜#${to}`;
		this.subtitleEl.createSpan({ cls: "agent-sessions-usage-subtitle-label", text: label });
		if (this.selection !== null) {
			const wholeBtn = this.subtitleEl.createEl("button", {
				cls: "agent-sessions-usage-whole-btn",
				text: "全体",
			});
			wholeBtn.addEventListener("click", () => {
				this.selection = null;
				this.renderSelection();
			});
		}

		this.cardsEl.empty();
		this.renderCard(this.cardsEl, "コスト", formatCost(total.cost), total.estimated ? "概算" : undefined);
		this.renderCard(this.cardsEl, "トークン", formatK(inputTotal), `出力 ${formatK(total.output)}`);
		this.renderCard(this.cardsEl, "ターン数", formatK(count));
		this.renderCard(this.cardsEl, "期間", formatDuration(total.duration));

		this.renderBar(this.inputChartEl, "入力", [
			{ label: "非キャッシュ", value: total.input, cls: "uncached" },
			{ label: "cache 読出", value: total.cache_read, cls: "cache-read" },
			{ label: "cache 作成", value: total.cache_create, cls: "cache-create" },
		]);
		const thinking = Math.min(total.thinking, total.output);
		this.renderBar(this.outputChartEl, "出力", [
			{ label: "出力", value: Math.max(0, total.output - thinking), cls: "output" },
			{ label: "thinking", value: thinking, cls: "thinking" },
		]);
		this.renderTools(this.toolsChartEl, total.tools);

		result.turns.forEach((t, i) => {
			const row = this.rowEls[i];
			row.toggleClass("is-selected", this.selection !== null && t.index >= from && t.index <= to);
			row.toggleClass("is-anchor", pending && t.index === from);
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
		container.createDiv({ cls: "agent-sessions-usage-chart-title", text: "ツール使用" });
		const entries = Object.entries(tools)
			.sort((a, b) => b[1] - a[1])
			.slice(0, MAX_TOOL_ROWS);
		if (entries.length === 0) {
			container.createDiv({ cls: "agent-sessions-usage-empty", text: "ツール使用なし" });
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
		const { from, to } = effectiveRange(this.selection, result.turns);
		const total = sumRange(result.turns, from, to);
		void navigator.clipboard.writeText(toMarkdown(result.turns, from, to, total));
		new Notice("Markdown をコピーしました");
	}
}
