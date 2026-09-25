// The side panel: a grid of four areas (nav, list, detail, rate limit). The list and detail
// areas' heights can be adjusted via a drag handle between them (saved to `settings.sideDetailHeight`).

import { ItemView, Menu, Notice, Platform, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { attentionCounts, type AttentionCounts } from "../sessions/attention";
import { resolveAgentBinary, usage } from "../backend/backend";
import { t } from "../i18n";
import { VIEW_TYPE_TERMINAL } from "../sessions/open-session";
import { NewSessionModal } from "../ui/modals";
import type { Row } from "../sessions/index";
import { AGENT_IDS } from "../settings";
import type { SideList } from "../sessions/tree";
import { createRowActions, RelativeTimeTicker, renderRow, RowSelection, type RowActions } from "./rows";
import { computeSideList, leafIdsOf } from "./side-list";
import { renderDetail, type DetailContext } from "./detail";
import { LimitsView } from "./limits";

export const VIEW_TYPE_SIDE = "agent-sessions-side";

/** The lower bound (px) the detail pane can be dragged down to. */
const MIN_DETAIL_HEIGHT = 80;
/** `terminal-status` fires on every busy/idle change, so redraws are batched at this interval. */
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
	/** True while a hover has temporarily swapped in a different detail view (reverts to default when it ends). */
	private hovering = false;
	/** The nav's three buttons (their tooltips are redrawn when the language changes). */
	private navButtons: { newSession?: HTMLElement; manager?: HTMLElement; more?: HTMLElement } = {};
	/** Debounce timer for `terminal-status`. */
	private statusRenderTimer: ReturnType<typeof setTimeout> | null = null;
	/** Row time elements, re-rendered in place once a minute (shared with `ManagerView`). */
	private timeTicker = new RelativeTimeTicker();

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
		this.timeTicker.start();
		this.register(() => this.timeTicker.stop());

		this.onLayoutChange();
		this.onActiveLeafChange();
	}

	/** Batches redraws triggered by `terminal-status`, which fires on every tab state change. */
	private scheduleStatusRender(): void {
		if (this.statusRenderTimer) {
			return;
		}
		this.statusRenderTimer = setTimeout(() => {
			this.statusRenderTimer = null;
			this.render();
		}, TERMINAL_STATUS_DEBOUNCE_MS);
	}

	// ---- Skeleton -----------------------------------------------------------------

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

	/** When the language changes: redraws the nav's tooltips, the list, and the detail pane. */
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
		new NewSessionModal(this.plugin, (name, agent) => this.plugin.newSession(name || undefined, agent)).open();
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

	// ---- Detail pane height (drag handle) -----------------------------------------

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

	// ---- List -------------------------------------------------------------------

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
		this.timeTicker.reset();
		const actions = createRowActions(
			this.plugin,
			(id) => this.onHoverShow(id),
			() => this.onHoverEnd()
		);
		const list = computeSideList(this.plugin.index.sessions, this.terminalLeaves(), this.plugin.settings.recentCount);
		// The needs-attention (asking/waiting) count is tallied across the whole list (open
		// tabs + running + recent), and shown as a badge next to the "open tabs" heading.
		const attention = attentionCounts(this.plugin, [...list.openTabs, ...list.running, ...list.recent]);
		this.renderSection(this.listEl, t("section.openTabs"), list.openTabs, actions, attention);
		this.renderSection(this.listEl, t("section.running"), list.running, actions);
		this.renderSection(this.listEl, t("section.recent"), list.recent, actions);
		if (list.openTabs.length === 0 && list.running.length === 0 && list.recent.length === 0) {
			this.renderEmptyState(this.listEl);
		}
		if (!this.hovering) {
			this.showDefaultDetail(list);
		}
	}

	/**
	 * Shown instead of the (otherwise blank) list when there are no sessions at all yet
	 * (T-104): a wordmark, a short description, and a "New session" button — the same action
	 * as the nav's `+`. If no agent is enabled, that's swapped for a button that opens settings
	 * instead, since there'd be nothing to launch. If at least one is enabled, the button shows
	 * first (optimistically) while a background check (`resolveAgentBinary`) confirms at least
	 * one enabled agent's binary can actually be found; if none can, it's swapped to the same
	 * open-settings fallback (a real click would otherwise just error out) — never awaited, so
	 * it never delays the rest of `render()`. The rate-limit bars (§8's separate `limitsHostEl`)
	 * are unaffected either way — they don't depend on the session list at all.
	 */
	private renderEmptyState(container: HTMLElement): void {
		const box = container.createDiv({ cls: "agent-sessions-empty" });
		box.createDiv({ cls: "agent-sessions-empty-wordmark", text: "Agent Sessions" });
		box.createDiv({ cls: "agent-sessions-empty-desc", text: t("empty.desc") });
		const actionEl = box.createDiv({ cls: "agent-sessions-empty-action" });
		const enabledAgents = AGENT_IDS.filter((id) => this.plugin.settings.agents[id].enabled);
		if (enabledAgents.length === 0) {
			this.renderEmptyFallback(actionEl, t("empty.noAgentEnabled"));
			return;
		}
		const btn = actionEl.createEl("button", { cls: "mod-cta", text: t("action.newSession") });
		this.registerDomEvent(btn, "click", () => this.openNewSessionModal());
		void Promise.allSettled(
			enabledAgents.map((id) => resolveAgentBinary(id, this.plugin.settings.agents[id].path, Platform.isMacOS))
		).then((results) => {
			const found = results.some((r) => r.status === "fulfilled");
			if (!found && actionEl.isConnected) {
				this.renderEmptyFallback(actionEl, t("empty.noAgentFound"));
			}
		});
	}

	private renderEmptyFallback(container: HTMLElement, message: string): void {
		container.empty();
		container.createDiv({ cls: "agent-sessions-empty-desc", text: message });
		const btn = container.createEl("button", { text: t("action.openSettings") });
		this.registerDomEvent(btn, "click", () => this.plugin.openSettings());
	}

	private renderSection(
		container: HTMLElement,
		title: string,
		rows: Row[],
		actions: RowActions,
		attention?: AttentionCounts
	): void {
		const hasAttention = !!attention && (attention.asking > 0 || attention.waiting > 0);
		if (rows.length === 0 && !hasAttention) {
			return;
		}
		const titleEl = container.createDiv({ cls: "agent-sessions-section-title" });
		titleEl.createSpan({ text: title });
		if (attention && hasAttention) {
			this.renderAttentionBadge(titleEl, attention);
		}
		for (const row of rows) {
			const el = renderRow(container, row, {
				front: row.id === this.frontId,
				selection: this.selection,
				actions,
				plugin: this.plugin,
			});
			const timeEl = el.querySelector<HTMLElement>(".agent-sessions-row-time");
			if (timeEl) {
				this.timeTicker.track(timeEl, row.last_activity);
			}
		}
	}

	/** The small "needs input N" / "unread M" badge. Clicking it opens the first asking session
	 * (or the first waiting one if there's no asking session). */
	private renderAttentionBadge(container: HTMLElement, attention: AttentionCounts): void {
		const badge = container.createSpan({ cls: "agent-sessions-attention-badge" });
		if (attention.asking > 0) {
			badge.createSpan({
				cls: "agent-sessions-attention-badge-item is-asking",
				text: t("attention.asking", { count: attention.asking }),
			});
		}
		if (attention.waiting > 0) {
			badge.createSpan({
				cls: "agent-sessions-attention-badge-item is-waiting",
				text: t("attention.waiting", { count: attention.waiting }),
			});
		}
		const jumpToId = attention.jumpToId;
		if (jumpToId) {
			badge.addClass("is-clickable");
			this.registerDomEvent(badge, "click", (evt) => {
				evt.stopPropagation();
				const row = this.plugin.index.sessions.get(jumpToId);
				void this.plugin.openSession(jumpToId, { agent: row?.agent ?? "claude", cwd: row?.cwd ?? "" });
			});
		}
	}

	// ---- Detail pane -----------------------------------------------------------------

	/**
	 * On a `registry`/`statusline` change: redraws the list (`render()` also refreshes the
	 * default detail view when not hovering), reloads the rate-limit view, and — if currently
	 * hovering — keeps that session's detail current too (badge, ctx% values, etc.).
	 */
	private onRegistryOrStatusChange(): void {
		this.render();
		this.limitsView.reload();
		if (this.hovering && this.detailId) {
			void this.renderDetailFor(this.detailId);
		}
	}

	/** Hover started (after 300ms): temporarily switches to that session. */
	private onHoverShow(id: string): void {
		this.hovering = true;
		void this.renderDetailFor(id);
	}

	/** The hover ended: reverts to the default (the frontmost tab, or the top of the list). */
	private onHoverEnd(): void {
		this.hovering = false;
		this.showDefaultDetail();
	}

	/**
	 * The detail shown when nothing is being pointed at: the frontmost terminal tab's session,
	 * or failing that, the top of the list (open tabs → running → recent, in that order).
	 * Empties the panel if neither is available.
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
			fetchUsage: () => usage(this.plugin.agentSessionsPath(), this.plugin.vaultPath(), id),
			categoryColorIndex: (category) => this.plugin.index.categoryColorIndex(category),
		};
		renderDetail(this.detailEl, ctx);
	}
}
