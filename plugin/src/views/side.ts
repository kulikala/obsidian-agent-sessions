// サイドパネル（D-7・D-43・§6.1）：4 領域（ナビ・一覧・詳細・セッション制限）の grid。
// 一覧と詳細の間はドラッグハンドルで高さを変える（`settings.sideDetailHeight` に保存）。

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { usage } from "../backend";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import { NewSessionModal } from "../modals";
import type { Row } from "../index";
import { createRowActions, renderRow, RowSelection, type RowActions } from "./rows";
import { computeSideList, leafIdsOf } from "./side-list";
import { renderDetail, type DetailContext } from "./detail";
import { LimitsView } from "./limits";

export const VIEW_TYPE_SIDE = "agent-sessions-side";

/** ドラッグで詰められる詳細欄の下限（px）。 */
const MIN_DETAIL_HEIGHT = 80;

export class SideView extends ItemView {
	private plugin: AgentSessionsPlugin;

	private listEl!: HTMLElement;
	private handleEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private limitsHostEl!: HTMLElement;
	private limitsView!: LimitsView;
	private selection = new RowSelection();

	private frontId: string | null = null;
	private detailId: string | null = null;
	private detailHeight = 220;

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
		this.register(this.plugin.index.registry.onChange(() => this.onRegistryOrStatusChange()));
		this.register(this.plugin.index.statusline.onChange(() => this.onRegistryOrStatusChange()));
		this.register(this.plugin.index.addVisible());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onLayoutChange()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));
		this.register(() => this.limitsView.dispose());

		this.onLayoutChange();
		this.onActiveLeafChange();
	}

	// ---- 骨組み -----------------------------------------------------------------

	private buildSkeleton(): void {
		this.buildNav();

		const listWrap = this.contentEl.createDiv({ cls: "agent-sessions-list-wrap" });
		this.listEl = listWrap.createDiv({ cls: "agent-sessions-list" });
		this.handleEl = listWrap.createDiv({ cls: "agent-sessions-drag-handle" });
		this.bindHandle();

		this.detailEl = this.contentEl.createDiv({ cls: "agent-sessions-detail" });
		this.applyDetailHeight(this.plugin.settings.sideDetailHeight);

		this.limitsHostEl = this.contentEl.createDiv();
		this.limitsView = new LimitsView(this.limitsHostEl, this.plugin.index.statusline.dir);
	}

	private buildNav(): void {
		const navEl = this.contentEl.createDiv({ cls: "agent-sessions-nav" });
		this.iconButton(navEl, "plus", "新規セッション", () => this.openNewSessionModal());
		this.iconButton(navEl, "layout-grid", "セッションマネージャー", () => void this.plugin.openManagerTab());
		const moreBtn = this.iconButton(navEl, "more-horizontal", "その他", (evt) => this.showMoreMenu(evt));
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
		menu.showAtMouseEvent(evt);
	}

	// ---- 詳細欄の高さ（ドラッグハンドル） -----------------------------------------

	private applyDetailHeight(px: number): void {
		this.detailHeight = px;
		this.contentEl.style.setProperty("--as-detail-h", `${px}px`);
	}

	private bindHandle(): void {
		let dragging = false;
		let startY = 0;
		let startHeight = 0;

		const onMouseMove = (evt: MouseEvent) => {
			if (!dragging) {
				return;
			}
			const delta = evt.clientY - startY;
			this.applyDetailHeight(Math.max(MIN_DETAIL_HEIGHT, Math.round(startHeight - delta)));
		};
		const onMouseUp = () => {
			if (!dragging) {
				return;
			}
			dragging = false;
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
			this.plugin.settings.sideDetailHeight = this.detailHeight;
			void this.plugin.saveSettings();
		};
		this.registerDomEvent(this.handleEl, "mousedown", (evt) => {
			dragging = true;
			startY = evt.clientY;
			startHeight = this.detailHeight;
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
			evt.preventDefault();
		});
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

	// ---- 詳細欄 -----------------------------------------------------------------

	/** `registry`・`statusline` の変化：一覧を描き直し、制限ビューを読み直し、開いている詳細も更新する。 */
	private onRegistryOrStatusChange(): void {
		this.render();
		this.limitsView.reload();
		if (this.detailId) {
			void this.showDetail(this.detailId);
		}
	}

	private async showDetail(id: string): Promise<void> {
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
