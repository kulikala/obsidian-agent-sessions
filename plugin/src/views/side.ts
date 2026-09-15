// サイドパネル（D-7・§6.1）：メニュー行・一覧 3 区分・詳細欄・ステータスバー。

import { ItemView, Menu, Notice, type WorkspaceLeaf } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import { NewSessionModal } from "../modals";
import { formatStatus } from "../statusline";
import type { Row } from "../index";
import { createRowActions, renderDetailPane, renderRow, RowSelection, type RowActions } from "./rows";
import { computeSideList, leafIdsOf } from "./side-list";

export const VIEW_TYPE_SIDE = "agent-sessions-side";

export class SideView extends ItemView {
	private plugin: AgentSessionsPlugin;

	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private detailToggleEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private selection = new RowSelection();

	private frontId: string | null = null;
	private detailId: string | null = null;
	private detailCollapsed = false;

	constructor(leaf: WorkspaceLeaf, plugin: AgentSessionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SIDE;
	}

	getDisplayText(): string {
		return "Agent Sessions";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-side");
		this.buildSkeleton();

		this.register(this.plugin.index.onChange(() => this.render()));
		this.register(this.plugin.index.onError((message) => new Notice(`一覧の走査に失敗しました: ${message}`)));
		this.register(this.plugin.index.registry.onChange(() => this.render()));
		this.register(this.plugin.index.statusline.onChange(() => this.renderStatusBar()));
		this.register(this.plugin.index.addVisible());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onLayoutChange()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));

		this.onLayoutChange();
		this.onActiveLeafChange();
	}

	// ---- 骨組み -----------------------------------------------------------------

	private buildSkeleton(): void {
		const menuEl = this.contentEl.createDiv({ cls: "agent-sessions-menu-row" });
		const newBtn = menuEl.createEl("button", { text: "新規セッション" });
		this.registerDomEvent(newBtn, "click", () => this.openNewSessionModal());
		const managerBtn = menuEl.createEl("button", { text: "セッションマネージャー" });
		this.registerDomEvent(managerBtn, "click", () => void this.plugin.openManagerTab());
		const moreBtn = menuEl.createEl("button", { text: "⋯", cls: "agent-sessions-menu-more" });
		this.registerDomEvent(moreBtn, "click", (evt) => this.showMenuRowMenu(evt));

		this.listEl = this.contentEl.createDiv({ cls: "agent-sessions-list" });

		this.detailToggleEl = this.contentEl.createDiv({ cls: "agent-sessions-detail-toggle", text: "詳細" });
		this.registerDomEvent(this.detailToggleEl, "click", () => this.toggleDetail());
		this.detailEl = this.contentEl.createDiv({ cls: "agent-sessions-detail" });

		this.statusEl = this.contentEl.createDiv({ cls: "agent-sessions-status-bar" });
	}

	private openNewSessionModal(): void {
		new NewSessionModal(this.app, (name) => this.plugin.newSession(name || undefined)).open();
	}

	private showMenuRowMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("設定を開く")
				.setIcon("settings")
				.onClick(() => this.plugin.openSettings())
		);
		menu.addItem((item) =>
			item
				.setTitle("再走査")
				.setIcon("refresh-cw")
				.onClick(() => void this.plugin.index.rescan())
		);
		menu.addItem((item) =>
			item
				.setTitle("アーカイブを表示")
				.setIcon("archive")
				.onClick(() => void this.plugin.openManagerTab())
		);
		menu.showAtMouseEvent(evt);
	}

	private toggleDetail(): void {
		this.detailCollapsed = !this.detailCollapsed;
		this.detailEl.toggleClass("is-collapsed", this.detailCollapsed);
		this.detailToggleEl.toggleClass("is-collapsed", this.detailCollapsed);
	}

	// ---- 一覧 -------------------------------------------------------------------

	private terminalLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
	}

	private onLayoutChange(): void {
		this.plugin.index.setOpenTabs(leafIdsOf(this.terminalLeaves()));
		this.render();
	}

	private onActiveLeafChange(): void {
		const activeLeaf = this.app.workspace.activeLeaf;
		const state = activeLeaf?.view.getViewType() === VIEW_TYPE_TERMINAL ? activeLeaf.getViewState().state : undefined;
		const id = typeof state?.id === "string" ? state.id : undefined;
		if (id) {
			this.frontId = id;
		}
		this.render();
	}

	private render(): void {
		this.listEl.empty();
		this.selection.clear();
		const actions = createRowActions(this.app, this.plugin, (id) => void this.showDetail(id));
		const list = computeSideList(this.plugin.index.sessions, this.terminalLeaves(), this.plugin.settings.recentCount);
		this.renderSection(this.listEl, "開いているタブ", list.openTabs, actions);
		this.renderSection(this.listEl, "起動中", list.running, actions);
		this.renderSection(this.listEl, "最近", list.recent, actions);
		this.renderStatusBar();
	}

	private renderSection(container: HTMLElement, title: string, rows: Row[], actions: RowActions): void {
		if (rows.length === 0) {
			return;
		}
		container.createDiv({ cls: "agent-sessions-section-title", text: title });
		for (const row of rows) {
			renderRow(container, row, { front: row.id === this.frontId, selection: this.selection, actions });
		}
	}

	private async showDetail(id: string): Promise<void> {
		if (this.detailId === id) {
			return;
		}
		this.detailId = id;
		const row = this.plugin.index.sessions.get(id);
		try {
			const detail = await this.plugin.index.getDetail(id);
			if (this.detailId !== id) {
				return;
			}
			renderDetailPane(this.detailEl, row, detail);
		} catch {
			if (this.detailId === id) {
				renderDetailPane(this.detailEl, row, null);
			}
		}
	}

	// ---- ステータスバー -----------------------------------------------------------

	private renderStatusBar(): void {
		if (!this.frontId) {
			this.statusEl.setText("");
			return;
		}
		const rc = this.plugin.index.registry.get(this.frontId)?.rc ?? null;
		const info = this.plugin.index.statusline.get(this.frontId);
		this.statusEl.setText(formatStatus(info, rc));
	}
}
