// トークン集計のモーダル（D-31）。`json usage ID` を 1 回呼び、以後の区間選択・
// 「全体」・「コピー」はローカルの `sumRange`／`toMarkdown` だけで完結する（CLI を呼び直さない）。
// 選んだ区間は、上の合計にも下のターン表にも同じだけ効く——「コピー」は今見えているものが
// そのまま Markdown になる。

import { App, Modal, Notice } from "obsidian";
import { usage } from "./backend";
import { formatEpoch, formatNumber, sumRange, toMarkdown } from "./usage";
import type { UsageResult, UsageTurn } from "./types";

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class UsageModal extends Modal {
	private result: UsageResult | null = null;
	private from = 0;
	private to = 0;
	private resultsEl!: HTMLElement;

	constructor(
		app: App,
		private agentSessionsPath: string,
		private sessionId: string,
		private sessionName: string
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`トークン集計：${this.sessionName}`);
		this.contentEl.addClass("agent-sessions-usage-modal");
		this.contentEl.createDiv({ text: "読み込み中…" });
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		try {
			this.result = await usage(this.agentSessionsPath, this.sessionId);
		} catch (err) {
			this.contentEl.empty();
			this.contentEl.createDiv({ text: `集計に失敗しました: ${messageOf(err)}` });
			return;
		}
		const turns = this.result.turns;
		this.from = turns[0]?.index ?? 0;
		this.to = turns[turns.length - 1]?.index ?? 0;
		this.renderControls(turns);
		this.resultsEl = this.contentEl.createDiv({ cls: "agent-sessions-usage-results" });
		this.renderResults();
	}

	/** 「から」「まで」のドロップダウン、「全体」、「コピー」。区間はこのモーダルの外へは出ない。 */
	private renderControls(turns: UsageTurn[]): void {
		const controls = this.contentEl.createDiv({ cls: "agent-sessions-usage-controls" });
		controls.createSpan({ text: "から" });
		const fromSelect = this.createTurnSelect(controls, turns, this.from, (v) => {
			this.from = v;
			this.renderResults();
		});
		controls.createSpan({ text: "まで" });
		const toSelect = this.createTurnSelect(controls, turns, this.to, (v) => {
			this.to = v;
			this.renderResults();
		});

		const wholeBtn = controls.createEl("button", { text: "全体" });
		wholeBtn.addEventListener("click", () => {
			this.from = turns[0]?.index ?? 0;
			this.to = turns[turns.length - 1]?.index ?? 0;
			fromSelect.value = String(this.from);
			toSelect.value = String(this.to);
			this.renderResults();
		});

		const copyBtn = controls.createEl("button", { text: "コピー", cls: "mod-cta" });
		copyBtn.addEventListener("click", () => {
			if (!this.result) {
				return;
			}
			const total = sumRange(this.result.turns, this.from, this.to);
			void navigator.clipboard.writeText(toMarkdown(this.result.turns, this.from, this.to, total));
			new Notice("Markdown をコピーしました");
		});
	}

	private createTurnSelect(
		container: HTMLElement,
		turns: UsageTurn[],
		value: number,
		onChange: (v: number) => void
	): HTMLSelectElement {
		const select = container.createEl("select");
		for (const t of turns) {
			select.createEl("option", { text: `#${t.index}`, value: String(t.index) });
		}
		select.value = String(value);
		select.addEventListener("change", () => onChange(Number(select.value)));
		return select;
	}

	/**
	 * 選んだ区間の合計を描き直す。「から」「まで」を変えるたびに呼ぶ。ターン表は常に
	 * 全ターンを見せる（区間は合計にだけ効く）ので、初回描画の後は組み直さない。
	 */
	private renderResults(): void {
		const result = this.result;
		if (!result) {
			return;
		}
		const total = sumRange(result.turns, this.from, this.to);

		let totalEl = this.resultsEl.querySelector<HTMLElement>(".agent-sessions-usage-total");
		if (!totalEl) {
			totalEl = this.resultsEl.createDiv({ cls: "agent-sessions-usage-total" });
			this.renderTable(result.turns);
		}
		totalEl.setText(
			`合計（#${Math.min(this.from, this.to)}〜#${Math.max(this.from, this.to)}）：` +
				`呼出 ${formatNumber(total.calls)}　入力 ${formatNumber(total.input)}　出力 ${formatNumber(total.output)}　` +
				`cache 作成 ${formatNumber(total.cache_create)}　cache 読出 ${formatNumber(total.cache_read)}　` +
				`thinking ${formatNumber(total.thinking)}`
		);
	}

	private renderTable(turns: UsageTurn[]): void {
		const table = this.resultsEl.createEl("table", { cls: "agent-sessions-usage-table" });
		const head = table.createEl("tr");
		for (const label of ["#", "時刻", "指示", "入力", "出力", "cache 作成", "cache 読出"]) {
			head.createEl("th", { text: label });
		}
		for (const t of turns) {
			const row = table.createEl("tr");
			row.createEl("td", { text: String(t.index) });
			row.createEl("td", { text: formatEpoch(t.ts) });
			row.createEl("td", { text: t.prompt });
			row.createEl("td", { text: formatNumber(t.input) });
			row.createEl("td", { text: formatNumber(t.output) });
			row.createEl("td", { text: formatNumber(t.cache_create) });
			row.createEl("td", { text: formatNumber(t.cache_read) });
		}
	}
}
