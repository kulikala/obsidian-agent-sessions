// セッションマネージャー（D-8・D-44・§6.2）：表・折畳・絞込・アーカイブ表示・詳細パネル。
// サイドパネルとは見た目を変える（罫線のある表、等幅の日時列）。行の描画ロジック
// （状態の印・名前・時刻の整形、⋯ の行メニュー）は `rows.ts` を再利用する。

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type { Row } from "../index";
import type AgentSessionsPlugin from "../main";
import { usage } from "../backend";
import { NewSessionModal } from "../modals";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import { loadStore } from "../store";
import { buildManagerTree, splitName } from "../tree";
import { renderDetail, type DetailContext } from "./detail";
import { ARCHIVED_GROUP, flattenTree, moveSelection, type ManagerRow } from "./manager-model";
import { createRowActions, displayName, formatTime, showRowMenu, statusMark, type RowActions } from "./rows";

export const VIEW_TYPE_MANAGER = "agent-sessions-manager";

/**
 * 表の名前列に出す文字列。名前が有ればグループ名を除いた分（`splitName` の 2 要素目、
 * TUI と同じ）——グループに属さない名前ならそのまま全体になる。名前が無ければ
 * `displayName`（`label`／無題）に落ちる。
 */
function rowLabel(row: Row): string {
	if (row.name) {
		return splitName(row.name)[1];
	}
	return displayName(row);
}

export class ManagerView extends ItemView {
	private plugin: AgentSessionsPlugin;

	private wrapEl!: HTMLElement;
	private tableBodyEl!: HTMLTableSectionElement;
	private detailEl!: HTMLElement;
	private filterEl!: HTMLInputElement;

	private filterText = "";
	private showArchived = false;
	private rows: ManagerRow[] = [];
	private rowEls: HTMLTableRowElement[] = [];
	private cursor = -1;
	private detailId: string | null = null;
	private actions!: RowActions;
	/** 前面のターミナルタブのセッション（詳細パネルの既定表示に使う）。 */
	private frontId: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AgentSessionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_MANAGER;
	}

	getDisplayText(): string {
		return "セッションマネージャー";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-manager");
		this.buildSkeleton();

		this.register(this.plugin.index.onChange(() => this.render()));
		this.register(this.plugin.index.onError((message) => new Notice(`一覧の走査に失敗しました: ${message}`)));
		this.register(this.plugin.index.registry.onChange(() => this.render()));
		this.register(this.plugin.index.statusline.onChange(() => this.refreshDetail()));
		this.register(this.plugin.index.addVisible());
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));

		void this.plugin.index.rescan();
		this.render();
		this.wrapEl.focus();
	}

	private onActiveLeafChange(): void {
		const activeLeaf = this.app.workspace.activeLeaf;
		const state = activeLeaf?.view.getViewType() === VIEW_TYPE_TERMINAL ? activeLeaf.getViewState().state : undefined;
		const id = typeof state?.id === "string" ? state.id : undefined;
		if (id) {
			this.frontId = id;
			this.refreshDetail();
		}
	}

	// ---- 骨組み -----------------------------------------------------------------

	private buildSkeleton(): void {
		this.buildToolbar();

		const body = this.contentEl.createDiv({ cls: "agent-sessions-manager-body" });
		this.wrapEl = body.createDiv({ cls: "agent-sessions-manager-table-wrap" });
		this.wrapEl.tabIndex = 0;
		this.registerDomEvent(this.wrapEl, "keydown", (evt) => this.onListKeydown(evt));

		const table = this.wrapEl.createEl("table", { cls: "agent-sessions-manager-table" });
		const colgroup = table.createEl("colgroup");
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-mark" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-name" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-time" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-folder" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-menu" });
		this.tableBodyEl = table.createEl("tbody");

		this.detailEl = body.createDiv({ cls: "agent-sessions-manager-detail" });
	}

	private buildToolbar(): void {
		const toolbarEl = this.contentEl.createDiv({ cls: "agent-sessions-manager-toolbar" });
		this.iconButton(toolbarEl, "plus", "新規セッション", () => this.openNewSessionModal());
		this.iconButton(toolbarEl, "rotate-cw", "再走査", () => void this.plugin.index.rescan());

		this.filterEl = toolbarEl.createEl("input", {
			type: "text",
			placeholder: "絞込",
			cls: "agent-sessions-manager-filter",
		});
		this.registerDomEvent(this.filterEl, "input", () => {
			this.filterText = this.filterEl.value;
			this.render();
		});
		this.registerDomEvent(this.filterEl, "keydown", (evt) => {
			if (evt.key === "Escape") {
				evt.preventDefault();
				this.filterEl.value = "";
				this.filterText = "";
				this.render();
				this.wrapEl.focus();
			}
		});

		const moreBtn = this.iconButton(toolbarEl, "more-horizontal", "その他", (evt) => this.showMoreMenu(evt));
		moreBtn.addClass("agent-sessions-nav-more");
	}

	private iconButton(
		container: HTMLElement,
		icon: string,
		tooltip: string,
		onClick: (evt: MouseEvent) => void
	): HTMLElement {
		const btn = container.createDiv({ cls: "agent-sessions-nav-btn clickable-icon" });
		setIcon(btn, icon);
		setTooltip(btn, tooltip);
		this.registerDomEvent(btn, "click", (evt) => onClick(evt));
		return btn;
	}

	private openNewSessionModal(): void {
		new NewSessionModal(this.app, (name) => this.plugin.newSession(name || undefined)).open();
	}

	private showMoreMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("アーカイブを表示")
				.setChecked(this.showArchived)
				.onClick(() => {
					this.showArchived = !this.showArchived;
					this.render();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	// ---- 表 ---------------------------------------------------------------------

	private render(): void {
		const store = loadStore(this.plugin.storePath());
		let sessionRows = [...this.plugin.index.sessions.values()];
		if (this.filterText.trim()) {
			const needle = this.filterText.trim().toLowerCase();
			sessionRows = sessionRows.filter((r) => (r.name || r.label || r.id).toLowerCase().includes(needle));
		}
		const tree = buildManagerTree(sessionRows, store);
		this.rows = flattenTree(tree, this.showArchived);
		this.cursor = moveSelection(this.rows, this.cursor, 0);
		this.actions = createRowActions(this.app, this.plugin, (id) => this.selectById(id));

		this.tableBodyEl.empty();
		this.rowEls = this.rows.map((mrow, index) => this.renderRow(mrow, index));
		this.applySelectionHighlight();
		this.refreshDetail();
	}

	private renderRow(mrow: ManagerRow, index: number): HTMLTableRowElement {
		if (mrow.kind === "group") {
			const tr = this.tableBodyEl.createEl("tr", { cls: "agent-sessions-manager-row is-group" });
			const td = tr.createEl("td", { attr: { colspan: "5" } });
			const head = td.createDiv({ cls: "agent-sessions-manager-group-head" });
			head.createSpan({ cls: "agent-sessions-manager-caret", text: mrow.folded ? "▸" : "▾" });
			head.createSpan({ cls: "agent-sessions-manager-group-label", text: mrow.label });
			head.createSpan({ cls: "agent-sessions-manager-group-count", text: String(mrow.count) });
			tr.addEventListener("click", () => {
				this.cursor = index;
				this.wrapEl.focus();
				this.toggleFold(mrow);
			});
			return tr;
		}

		if (mrow.kind === "archived-orphan") {
			const tr = this.tableBodyEl.createEl("tr", { cls: "agent-sessions-manager-row is-indented is-archived" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-mark" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-name", text: mrow.name || `無題 ${mrow.id.slice(0, 8)}` });
			tr.createEl("td", { cls: "agent-sessions-manager-col-time" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-folder" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-menu" });
			tr.addEventListener("click", () => {
				this.cursor = index;
				this.wrapEl.focus();
				this.applySelectionHighlight();
				this.refreshDetail();
			});
			return tr;
		}

		const row = mrow.row;
		const tr = this.tableBodyEl.createEl("tr", { cls: "agent-sessions-manager-row" });
		if (mrow.indent) {
			tr.addClass("is-indented");
		}
		if (row.archived) {
			tr.addClass("is-archived");
		}

		const markTd = tr.createEl("td", { cls: "agent-sessions-manager-col-mark" });
		markTd.createSpan({ cls: `agent-sessions-row-mark ${statusMark(row)}` });
		tr.createEl("td", { cls: "agent-sessions-manager-col-name", text: rowLabel(row) });
		tr.createEl("td", { cls: "agent-sessions-manager-col-time", text: formatTime(row.last_activity) });
		tr.createEl("td", { cls: "agent-sessions-manager-col-folder", text: row.folder });

		const menuTd = tr.createEl("td", { cls: "agent-sessions-manager-col-menu" });
		const menuBtn = menuTd.createSpan({ cls: "agent-sessions-row-menu-btn", text: "⋯" });
		menuBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.selectIndex(index);
			showRowMenu(evt, row, this.actions);
		});

		tr.addEventListener("click", () => this.selectIndex(index));
		tr.addEventListener("dblclick", () => this.actions.openSession(row.id));
		tr.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.selectIndex(index);
			showRowMenu(evt, row, this.actions);
		});

		return tr;
	}

	private toggleFold(group: Extract<ManagerRow, { kind: "group" }>): void {
		if (group.key === ARCHIVED_GROUP) {
			// アーカイブの見出しは折畳まない——「アーカイブを表示」の on/off で開閉する。
			return;
		}
		this.plugin.setFolded(group.key, !group.folded);
		this.render();
	}

	// ---- 選択・キーボード操作（D-44：TUI と同じ ↑↓／Enter／`/`） -------------------------

	private selectIndex(index: number): void {
		this.cursor = index;
		this.wrapEl.focus();
		this.applySelectionHighlight();
		this.refreshDetail();
	}

	private selectById(id: string): void {
		const index = this.rows.findIndex((r) => r.kind === "session" && r.row.id === id);
		if (index >= 0) {
			this.selectIndex(index);
		}
	}

	private applySelectionHighlight(): void {
		this.rowEls.forEach((tr, i) => tr.toggleClass("is-selected", i === this.cursor));
		this.rowEls[this.cursor]?.scrollIntoView({ block: "nearest" });
	}

	private onListKeydown(evt: KeyboardEvent): void {
		if (evt.key === "/") {
			evt.preventDefault();
			this.filterEl.focus();
			this.filterEl.select();
			return;
		}
		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			this.cursor = moveSelection(this.rows, this.cursor, 1);
			this.applySelectionHighlight();
			this.refreshDetail();
			return;
		}
		if (evt.key === "ArrowUp") {
			evt.preventDefault();
			this.cursor = moveSelection(this.rows, this.cursor, -1);
			this.applySelectionHighlight();
			this.refreshDetail();
			return;
		}
		if (evt.key === "Enter") {
			evt.preventDefault();
			this.activateCursor();
		}
	}

	private activateCursor(): void {
		const mrow = this.rows[this.cursor];
		if (!mrow) {
			return;
		}
		if (mrow.kind === "group") {
			this.toggleFold(mrow);
		} else if (mrow.kind === "session") {
			this.actions.openSession(mrow.row.id);
		}
	}

	// ---- 詳細パネル -----------------------------------------------------------------

	/**
	 * 選択が有ればそれ、無ければ既定（前面のターミナルタブのセッション、無ければ表の
	 * 最初のセッション行）を表示する。どちらも無ければ空にする（実機修正：D-44）。
	 */
	private refreshDetail(): void {
		const mrow = this.rows[this.cursor];
		if (mrow?.kind === "session") {
			void this.showDetailFor(mrow.row.id);
			return;
		}
		const id = this.defaultDetailId();
		if (id) {
			void this.showDetailFor(id);
		} else {
			this.detailId = null;
			renderDetail(this.detailEl, null);
		}
	}

	private defaultDetailId(): string | null {
		if (this.frontId && this.plugin.index.sessions.has(this.frontId)) {
			return this.frontId;
		}
		for (const mrow of this.rows) {
			if (mrow.kind === "session") {
				return mrow.row.id;
			}
		}
		return null;
	}

	private async showDetailFor(id: string): Promise<void> {
		this.detailId = id;
		const row = this.plugin.index.sessions.get(id);
		if (!row) {
			renderDetail(this.detailEl, null);
			return;
		}
		let detail = null;
		try {
			detail = await this.plugin.index.getDetail(id);
		} catch {
			detail = null;
		}
		if (this.detailId !== id) {
			return;
		}
		const ctx: DetailContext = {
			row,
			detail,
			statusInfo: this.plugin.index.statusline.get(id),
			rc: this.plugin.index.registry.get(id)?.rc ?? null,
			fetchUsage: () => usage(this.plugin.agentSessionsPath(), id),
		};
		renderDetail(this.detailEl, ctx);
	}
}
