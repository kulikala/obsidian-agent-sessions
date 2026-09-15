// セッションマネージャー（D-8・§6.2）：木・折畳・ツールバー・絞込・アーカイブ表示。

import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { Row } from "../index";
import type AgentSessionsPlugin from "../main";
import { NewSessionModal } from "../modals";
import { loadStore } from "../store";
import { buildManagerTree, OTHER_GROUP, type ArchivedEntry } from "../tree";
import { createRowActions, renderDetailPane, renderGroupHeader, renderRow, RowSelection, type RowActions } from "./rows";

export const VIEW_TYPE_MANAGER = "agent-sessions-manager";

export class ManagerView extends ItemView {
	private plugin: AgentSessionsPlugin;

	private treeEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private filterEl!: HTMLInputElement;
	private archiveToggleEl!: HTMLElement;
	private selection = new RowSelection();

	private filterText = "";
	private showArchived = false;
	private detailId: string | null = null;

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
		this.register(this.plugin.index.addVisible());

		void this.plugin.index.rescan();
		this.render();
	}

	// ---- 骨組み -----------------------------------------------------------------

	private buildSkeleton(): void {
		const toolbarEl = this.contentEl.createDiv({ cls: "agent-sessions-toolbar" });
		const newBtn = toolbarEl.createEl("button", { text: "新規セッション" });
		this.registerDomEvent(newBtn, "click", () => this.openNewSessionModal());
		const rescanBtn = toolbarEl.createEl("button", { text: "再走査" });
		this.registerDomEvent(rescanBtn, "click", () => void this.plugin.index.rescan());
		this.filterEl = toolbarEl.createEl("input", { type: "text", placeholder: "絞込" });
		this.registerDomEvent(this.filterEl, "input", () => {
			this.filterText = this.filterEl.value;
			this.render();
		});
		this.archiveToggleEl = toolbarEl.createEl("button", { text: "アーカイブを表示" });
		this.registerDomEvent(this.archiveToggleEl, "click", () => {
			this.showArchived = !this.showArchived;
			this.archiveToggleEl.toggleClass("is-active", this.showArchived);
			this.render();
		});

		this.treeEl = this.contentEl.createDiv({ cls: "agent-sessions-tree" });
		this.detailEl = this.contentEl.createDiv({ cls: "agent-sessions-detail" });
	}

	private openNewSessionModal(): void {
		new NewSessionModal(this.app, (name) => this.plugin.newSession(name || undefined)).open();
	}

	// ---- 木 ---------------------------------------------------------------------

	private render(): void {
		this.treeEl.empty();
		this.selection.clear();
		const store = loadStore(this.plugin.storePath());
		let rows = [...this.plugin.index.sessions.values()];
		if (this.filterText.trim()) {
			const needle = this.filterText.trim().toLowerCase();
			rows = rows.filter((r) => (r.name || r.label || r.id).toLowerCase().includes(needle));
		}
		const tree = buildManagerTree(rows, store);
		const actions = createRowActions(this.app, this.plugin, (id) => void this.showDetail(id));

		for (const group of tree.groups) {
			this.renderGroup(group.name, group.rows, group.folded, actions);
		}
		for (const row of tree.singles) {
			renderRow(this.treeEl, row, { indent: false, selection: this.selection, actions });
		}
		if (tree.others.rows.length > 0) {
			this.renderGroup(OTHER_GROUP, tree.others.rows, tree.others.folded, actions);
		}
		if (this.showArchived && tree.archived.length > 0) {
			this.renderArchived(tree.archived, actions);
		}
	}

	private renderGroup(name: string, rows: Row[], folded: boolean, actions: RowActions): void {
		renderGroupHeader(this.treeEl, name, rows.length, folded, () => {
			this.plugin.setFolded(name, !folded);
			this.render();
		});
		if (folded) {
			return;
		}
		for (const row of rows) {
			renderRow(this.treeEl, row, { indent: true, selection: this.selection, actions });
		}
	}

	private renderArchived(entries: ArchivedEntry[], actions: RowActions): void {
		this.treeEl.createDiv({ cls: "agent-sessions-group-header", text: `アーカイブ（${entries.length}）` });
		for (const entry of entries) {
			if (entry.row) {
				renderRow(this.treeEl, entry.row, { indent: true, selection: this.selection, actions });
				continue;
			}
			const el = this.treeEl.createDiv({ cls: "agent-sessions-row is-indented is-archived" });
			el.createSpan({ cls: "agent-sessions-row-name", text: entry.name || `無題 ${entry.id.slice(0, 8)}` });
		}
	}

	// ---- 詳細欄 -----------------------------------------------------------------

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
}
