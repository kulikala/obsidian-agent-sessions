// サイドパネル（D-7・D-43・§6.1）：4 領域（ナビ・一覧・詳細・セッション制限）の grid。
// 一覧と詳細の間はドラッグハンドルで高さを変える（`settings.sideDetailHeight` に保存）。

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { usage } from "../backend";
import { t } from "../i18n";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import { NewSessionModal } from "../modals";
import type { Row } from "../index";
import type { SideList } from "../tree";
import { createRowActions, renderRow, RowSelection, type RowActions } from "./rows";
import { computeSideList, leafIdsOf } from "./side-list";
import { renderDetail, type DetailContext } from "./detail";
import { LimitsView } from "./limits";

export const VIEW_TYPE_SIDE = "agent-sessions-side";

/** ドラッグで詰められる詳細欄の下限（px）。 */
const MIN_DETAIL_HEIGHT = 80;
/** `terminal-status`（D-66 追補）は busy/idle のたびに飛んでくるので、まとめて描き直す間隔。 */
const TERMINAL_STATUS_DEBOUNCE_MS = 200;

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
	/** ホバーで一時的に詳細を差し替えている間は真（外れたら既定に戻す）。 */
	private hovering = false;
	/** ナビの 3 ボタン（言語が変わったら tooltip を描き直す。§6.9・D-56）。 */
	private navButtons: { newSession?: HTMLElement; manager?: HTMLElement; more?: HTMLElement } = {};
	/** `terminal-status` のデバウンス用タイマー（D-66 追補）。 */
	private statusRenderTimer: ReturnType<typeof setTimeout> | null = null;

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
		return "list-tree";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-side");
		this.buildSkeleton();

		this.register(this.plugin.index.onChange(() => this.render()));
		this.register(this.plugin.index.onError((message) => new Notice(t("notice.scanFailed", { message }))));
		this.register(this.plugin.index.registry.onChange(() => this.onRegistryOrStatusChange()));
		this.register(this.plugin.index.statusline.onChange(() => this.onRegistryOrStatusChange()));
		this.register(this.plugin.index.addVisible());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onLayoutChange()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.refreshLanguage()));
		this.registerEvent(this.plugin.events.on("terminal-status", () => this.scheduleStatusRender()));
		this.register(() => this.limitsView.dispose());
		this.register(() => {
			if (this.statusRenderTimer) {
				clearTimeout(this.statusRenderTimer);
			}
		});

		this.onLayoutChange();
		this.onActiveLeafChange();
	}

	/** タブの状態が変わるたびに来る `terminal-status` をまとめて描き直す（D-66 追補）。 */
	private scheduleStatusRender(): void {
		if (this.statusRenderTimer) {
			return;
		}
		this.statusRenderTimer = setTimeout(() => {
			this.statusRenderTimer = null;
			this.render();
		}, TERMINAL_STATUS_DEBOUNCE_MS);
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

		this.limitsHostEl = this.contentEl.createDiv({ cls: "agent-sessions-limits-host" });
		this.limitsView = new LimitsView(this.limitsHostEl, this.plugin.index.statusline.dir);
	}

	private buildNav(): void {
		const navEl = this.contentEl.createDiv({ cls: "agent-sessions-nav" });
		this.navButtons.newSession = this.iconButton(navEl, "plus", t("action.newSession"), () => this.openNewSessionModal());
		this.navButtons.manager = this.iconButton(navEl, "layout-grid", t("action.sessionManager"), () =>
			void this.plugin.openManagerTab()
		);
		const moreBtn = this.iconButton(navEl, "more-horizontal", t("action.more"), (evt) => this.showMoreMenu(evt));
		moreBtn.addClass("agent-sessions-nav-more");
		this.navButtons.more = moreBtn;
	}

	/** 言語が変わったとき（§6.9・D-56）：ナビの tooltip と一覧・詳細を描き直す。 */
	private refreshLanguage(): void {
		if (this.navButtons.newSession) {
			setTooltip(this.navButtons.newSession, t("action.newSession"));
		}
		if (this.navButtons.manager) {
			setTooltip(this.navButtons.manager, t("action.sessionManager"));
		}
		if (this.navButtons.more) {
			setTooltip(this.navButtons.more, t("action.more"));
		}
		this.render();
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
		new NewSessionModal(this.plugin, (name) => this.plugin.newSession(name || undefined)).open();
	}

	private showMoreMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("action.rescan"))
				.setIcon("refresh-cw")
				.onClick(() => void this.plugin.index.rescan())
		);
		menu.addItem((item) =>
			item
				.setTitle(t("action.openSettings"))
				.setIcon("settings")
				.onClick(() => this.plugin.openSettings())
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
		const actions = createRowActions(
			this.plugin,
			(id) => this.onHoverShow(id),
			() => this.onHoverEnd()
		);
		const list = computeSideList(this.plugin.index.sessions, this.terminalLeaves(), this.plugin.settings.recentCount);
		this.renderSection(this.listEl, t("section.openTabs"), list.openTabs, actions);
		this.renderSection(this.listEl, t("section.running"), list.running, actions);
		this.renderSection(this.listEl, t("section.recent"), list.recent, actions);
		if (!this.hovering) {
			this.showDefaultDetail(list);
		}
	}

	private renderSection(container: HTMLElement, title: string, rows: Row[], actions: RowActions): void {
		if (rows.length === 0) {
			return;
		}
		container.createDiv({ cls: "agent-sessions-section-title", text: title });
		for (const row of rows) {
			renderRow(container, row, {
				front: row.id === this.frontId,
				selection: this.selection,
				actions,
				plugin: this.plugin,
			});
		}
	}

	// ---- 詳細欄 -----------------------------------------------------------------

	/**
	 * `registry`・`statusline` の変化：一覧を描き直し（`render()` が非ホバー時の既定表示も
	 * 更新する）、制限ビューを読み直し、ホバー中ならそのセッションのバッジ等も生かして
	 * おく（badge・ctx% の値を最新にする）。
	 */
	private onRegistryOrStatusChange(): void {
		this.render();
		this.limitsView.reload();
		if (this.hovering && this.detailId) {
			void this.renderDetailFor(this.detailId);
		}
	}

	/** ホバー開始（300 ms 後）：そのセッションに一時的に切り替える。 */
	private onHoverShow(id: string): void {
		this.hovering = true;
		void this.renderDetailFor(id);
	}

	/** ホバーが外れた：既定（前面のタブ／一覧の先頭）に戻す。 */
	private onHoverEnd(): void {
		this.hovering = false;
		this.showDefaultDetail();
	}

	/**
	 * 何も指していないときの詳細：前面のターミナルタブのセッション、無ければ一覧の先頭
	 * （開いているタブ→起動中→最近の順）。どちらも無ければ空にする。
	 */
	private showDefaultDetail(list?: SideList): void {
		const id = this.defaultDetailId(list);
		if (id) {
			void this.renderDetailFor(id);
		} else {
			this.detailId = null;
			renderDetail(this.detailEl, null);
		}
	}

	private defaultDetailId(list?: SideList): string | null {
		if (this.frontId && this.plugin.index.sessions.has(this.frontId)) {
			return this.frontId;
		}
		const l =
			list ?? computeSideList(this.plugin.index.sessions, this.terminalLeaves(), this.plugin.settings.recentCount);
		return l.openTabs[0]?.id ?? l.running[0]?.id ?? l.recent[0]?.id ?? null;
	}

	private async renderDetailFor(id: string): Promise<void> {
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
