// The session manager: table, folding, filtering, showing the archive, and the detail panel.
// Looks different from the side panel (a ruled table). Row rendering logic (status marker, name,
// time formatting, the `⋯` row menu) is reused from `rows.ts` — the last-updated column shows
// the same relative time as the side panel, re-rendered on the same shared ticker.

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { urgencyByGroupKey, type GroupUrgency } from "../sessions/attention";
import type { Row } from "../sessions/index";
import { stats, usage } from "../backend/backend";
import { paletteHueDeg } from "../sessions/category";
import { getLang, t } from "../i18n";
import { NewSessionModal } from "../ui/modals";
import { AGENT_ICON_ID } from "../ui/icons";
import { AGENT_IDS, type AgentId } from "../settings";
import {
	managerStatusFilterLabelKey,
	MANAGER_STATUS_FILTERS,
	resolveRowStatus,
	STATUS_GROUP_ICON,
	TERMINAL_STATUS_ICON,
	type ManagerStatusFilter,
} from "../sessions/terminal-status";
import { VIEW_TYPE_TERMINAL } from "../sessions/open-session";
import { loadStore } from "../sessions/store";
import { sessionDisplayName } from "../sessions/name";
import { buildManagerTree } from "../sessions/tree";
import type { StatsResult, StatsWindow } from "../types";
import { formatK } from "../usage/usage";
import { formatCost, renderDetail, type DetailContext } from "./detail";
import { formatCountdown, realWindows } from "./limits";
import {
	ARCHIVED_GROUP,
	categoryKeyOf,
	categoryTotals,
	categoryTotalsForWindow,
	flattenTree,
	formatWeekdayTime,
	isRealCategoryKey,
	matchesStatusFilter,
	moveSelection,
	orderedWindows,
	sessionCostForRow,
	shortModelName,
	sortRows,
	topCategoryTotals,
	weeklyPace,
	windowLabel,
	windowSummary,
	windowsForAgent,
	type CategoryTotal,
	type ManagerRow,
	type SortKey,
} from "./manager-model";
import {
	AGENT_NAME_KEY,
	categoryOf,
	createRowActions,
	formatRelativeTime,
	formatTime,
	RelativeTimeTicker,
	renderAgentMark,
	renderCategoryChip,
	rowLabel,
	rowStatusMark,
	showRowMenu,
	type RowActions,
} from "./rows";

const STATS_FETCH_INTERVAL_MS = 60000;
const STATS_TICK_INTERVAL_MS = 1000;

const COLUMN_COUNT = 7;
/** The number of top categories shown in the per-category horizontal bar. */
const CATEGORY_BAR_TOP_N = 8;
/** `terminal-status` fires on every busy/idle change, so redraws are batched at this interval. */
const TERMINAL_STATUS_DEBOUNCE_MS = 200;
/** The lower bound (px) the bottom analytics area can be dragged down to. */
const MIN_ANALYSIS_HEIGHT = 120;

export const VIEW_TYPE_MANAGER = "agent-sessions-manager";

export class ManagerView extends ItemView {
	private plugin: AgentSessionsPlugin;

	private wrapEl!: HTMLElement;
	private headEls: Partial<Record<SortKey, HTMLElement>> = {};
	private tableBodyEl!: HTMLTableSectionElement;
	private detailEl!: HTMLElement;
	private filterEl!: HTMLInputElement;
	private statusFilterBtn!: HTMLElement;

	private filterText = "";
	private showArchived = false;
	private sortKey: SortKey = "updated";
	private statsResult: StatsResult | null = null;
	private statsFetchTimer: ReturnType<typeof setInterval> | null = null;
	private statsTickTimer: ReturnType<typeof setInterval> | null = null;
	private rows: ManagerRow[] = [];
	private rowEls: HTMLTableRowElement[] = [];
	private cursor = -1;
	private detailId: string | null = null;
	private actions!: RowActions;
	/** The frontmost terminal tab's session (used for the detail panel's default display). */
	private frontId: string | null = null;
	/** Group heading rows' 5h/7d cost totals (rebuilt in `render()`, keyed by `categoryKeyOf`). */
	private categoryTotalsByWindow: Record<"5h" | "7d", Map<string, CategoryTotal>> = {
		"5h": new Map(),
		"7d": new Map(),
	};
	/** Whether each group key has an asking/waiting row (rebuilt in `render()`). */
	private groupUrgency: Map<string, GroupUrgency> = new Map();
	/**
	 * The agents shown as separate analytics sections (T-104) — every enabled agent, falling
	 * back to `["claude"]` alone if somehow none is (so there's always at least one section to
	 * render into). Only actually split into headed sections when there's more than one;
	 * with 0 or 1 it's today's single, headingless section. Rebuilt in `buildAnalysisSections`
	 * (called from `buildSkeleton`, so a settings change re-splits/re-merges via the existing
	 * full-skeleton rebuild `refreshLanguage` already does on `settings-changed`).
	 */
	private analysisAgents: AgentId[] = [];
	private statsBarEls: Partial<Record<AgentId, HTMLElement>> = {};
	/** Each agent section's per-category-bars wrapper — the individual bars inside it (one per
	 * window, T-104 addendum) are rebuilt fresh on every `renderCategoryBars()` call, same as
	 * the stat cards, so no per-window element needs tracking here. */
	private categoryBarWrapEls: Partial<Record<AgentId, HTMLElement>> = {};
	/** The section element itself (T-104 additional feature: per-agent fold), its caret, and the
	 * small "primary window usage%" summary shown next to the heading only while folded — `null`
	 * when there's no summary to show (nothing tracked yet for that agent). Only populated when
	 * `split` (more than one agent, so there's a heading to fold at all). */
	private agentSectionEls: Partial<Record<AgentId, HTMLElement>> = {};
	private agentCaretEls: Partial<Record<AgentId, HTMLElement>> = {};
	private agentSummaryEls: Partial<Record<AgentId, HTMLElement>> = {};
	/** Debounce timer for `terminal-status`. */
	private statusRenderTimer: ReturnType<typeof setTimeout> | null = null;
	/** The bottom analytics area (the usage bar plus the per-category bar). Clicking its heading
	 * folds it, and its handle resizes it — both are saved to `plugin.settings`. */
	private analysisEl!: HTMLElement;
	private analysisCaretEl!: HTMLElement;
	private analysisBodyEl!: HTMLElement;
	private analysisHandleEl!: HTMLElement;
	private analysisHeight = 240;
	/** Guards `refreshStatsFromClick()` against overlapping calls from rapid clicks. */
	private refreshingStats = false;
	/** The last-updated column's cells, re-rendered in place once a minute (shared with `SideView`). */
	private timeTicker = new RelativeTimeTicker();

	constructor(leaf: WorkspaceLeaf, plugin: AgentSessionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_MANAGER;
	}

	getDisplayText(): string {
		return t("action.sessionManager");
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-manager");
		this.buildSkeleton();

		// Rebuild the per-category bars, not just the table, whenever the session list changes —
		// this way, even if `stats()` (daemon) resolves before the session scan does, it catches
		// up as soon as the scan finishes (previously, if `refreshStats()` resolved before the
		// scan completed, the bars stayed empty).
		this.register(this.plugin.index.onChange(() => {
			this.renderCategoryBars();
			this.render();
		}));
		this.register(this.plugin.index.onError((message) => new Notice(t("notice.scanFailed", { message }))));
		this.register(this.plugin.index.registry.onChange(() => this.render()));
		this.register(this.plugin.index.statusline.onChange(() => this.refreshDetail()));
		this.register(this.plugin.index.addVisible());
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveLeafChange()));
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.refreshLanguage()));
		this.registerEvent(this.plugin.events.on("terminal-status", () => this.scheduleStatusRender()));

		this.statsFetchTimer = setInterval(() => void this.refreshStats(), STATS_FETCH_INTERVAL_MS);
		this.statsTickTimer = setInterval(() => this.renderStatsBar(), STATS_TICK_INTERVAL_MS);
		this.register(() => {
			if (this.statsFetchTimer) clearInterval(this.statsFetchTimer);
			if (this.statsTickTimer) clearInterval(this.statsTickTimer);
			if (this.statusRenderTimer) clearTimeout(this.statusRenderTimer);
		});
		this.timeTicker.start();
		this.register(() => this.timeTicker.stop());

		void this.plugin.index.rescan();
		void this.refreshStats();
		this.render();
		this.wrapEl.focus();
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

	/**
	 * When the language changes: redraws the tab header and the skeleton (heading, toolbar,
	 * usage bar). The skeleton's fixed strings (tooltips, column headings, placeholders) are
	 * only built once when it's opened, so rebuilding it from scratch is faster than patching it
	 * in place (`statsResult`, selection, and fold state are preserved).
	 */
	private refreshLanguage(): void {
		const leaf = this.leaf as unknown as { updateHeader?: () => void };
		if (typeof leaf.updateHeader === "function") {
			leaf.updateHeader();
		}
		this.contentEl.empty();
		this.buildSkeleton();
		this.render();
	}

	/** `json stats`: re-read on open, on rescan, and every 60 seconds. Shows "—" on the bar if it fails. */
	private async refreshStats(): Promise<void> {
		try {
			this.statsResult = await stats(this.plugin.agentSessionsPath(), this.plugin.vaultPath());
		} catch {
			this.statsResult = null;
		}
		this.renderStatsBar();
		this.renderCategoryBars();
		this.render();
	}

	/**
	 * Clicking the analytics area re-fetches `json stats` right away, rather than waiting for the
	 * next scheduled fetch. Rapid clicks collapse into one (ignored while a fetch is already in
	 * progress), and `is-refreshing` gives visible feedback while the request is in flight —
	 * unlike `views/limits.ts`'s equivalent, this is a real async round trip, not just a flash.
	 */
	private async refreshStatsFromClick(): Promise<void> {
		if (this.refreshingStats) {
			return;
		}
		this.refreshingStats = true;
		this.analysisBodyEl.addClass("is-refreshing");
		try {
			await this.refreshStats();
		} finally {
			this.refreshingStats = false;
			this.analysisBodyEl.removeClass("is-refreshing");
		}
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

	// ---- Skeleton -----------------------------------------------------------------

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
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-model" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-effort" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-5h" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-7d" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-folder" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-menu" });
		this.buildHead(table);
		this.tableBodyEl = table.createEl("tbody");

		this.detailEl = body.createDiv({ cls: "agent-sessions-manager-detail" });

		// The bottom analytics area (list on top, analytics below — the list is the main focus,
		// and the analytics are supplementary information you can glance back at anytime).
		this.analysisHandleEl = this.contentEl.createDiv({ cls: "agent-sessions-drag-handle" });
		this.bindAnalysisHandle();

		this.analysisEl = this.contentEl.createDiv({ cls: "agent-sessions-manager-analysis" });
		this.buildAnalysisHeader();
		this.analysisBodyEl = this.analysisEl.createDiv({ cls: "agent-sessions-manager-analysis-body" });
		this.registerDomEvent(this.analysisBodyEl, "click", () => void this.refreshStatsFromClick());
		setTooltip(this.analysisBodyEl, t("action.clickToRefresh"));
		this.buildAnalysisSections();

		this.applyAnalysisHeight(this.plugin.settings.managerAnalysisHeight);
		this.applyAnalysisCollapsed(this.plugin.settings.managerAnalysisCollapsed);
	}

	/** The analytics area's heading: click to fold (a caret plus "Analysis"). Saves state to settings. */
	private buildAnalysisHeader(): void {
		const header = this.analysisEl.createDiv({ cls: "agent-sessions-manager-analysis-header" });
		this.analysisCaretEl = header.createSpan({ cls: "agent-sessions-manager-analysis-caret" });
		header.createSpan({ cls: "agent-sessions-manager-analysis-title", text: t("manager.analysis.title") });
		this.registerDomEvent(header, "click", () => this.toggleAnalysisCollapsed());
	}

	private toggleAnalysisCollapsed(): void {
		const collapsed = !this.plugin.settings.managerAnalysisCollapsed;
		this.plugin.settings.managerAnalysisCollapsed = collapsed;
		void this.plugin.saveSettings();
		this.applyAnalysisCollapsed(collapsed);
	}

	private applyAnalysisCollapsed(collapsed: boolean): void {
		this.analysisEl.toggleClass("is-collapsed", collapsed);
		this.analysisCaretEl.setText(collapsed ? "▸" : "▾");
		this.analysisHandleEl.toggleClass("is-hidden", collapsed);
	}

	private applyAnalysisHeight(px: number): void {
		this.analysisHeight = px;
		this.contentEl.style.setProperty("--as-manager-analysis-h", `${px}px`);
	}

	/** The drag handle between the list and the analytics area (built the same way as `views/side.ts`'s detail pane). */
	private bindAnalysisHandle(): void {
		let dragging = false;
		let startY = 0;
		let startHeight = 0;

		const onMouseMove = (evt: MouseEvent) => {
			if (!dragging) {
				return;
			}
			const delta = evt.clientY - startY;
			this.applyAnalysisHeight(Math.max(MIN_ANALYSIS_HEIGHT, Math.round(startHeight - delta)));
		};
		const onMouseUp = () => {
			if (!dragging) {
				return;
			}
			dragging = false;
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
			this.plugin.settings.managerAnalysisHeight = this.analysisHeight;
			void this.plugin.saveSettings();
		};
		this.registerDomEvent(this.analysisHandleEl, "mousedown", (evt) => {
			dragging = true;
			startY = evt.clientY;
			startHeight = this.analysisHeight;
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
			evt.preventDefault();
		});
	}

	/** The heading row. "Last updated", "5h", "7d" sort the table when clicked. */
	private buildHead(table: HTMLTableElement): void {
		const thead = table.createEl("thead");
		const tr = thead.createEl("tr", { cls: "agent-sessions-manager-row" });
		tr.createEl("th", { cls: "agent-sessions-manager-col-mark" });
		tr.createEl("th", { cls: "agent-sessions-manager-col-name", text: t("table.name") });
		this.headEls.updated = this.buildSortHead(tr, "agent-sessions-manager-col-time", t("table.updated"), "updated");
		tr.createEl("th", { cls: "agent-sessions-manager-col-model", text: t("table.model") });
		tr.createEl("th", { cls: "agent-sessions-manager-col-effort", text: t("table.effort") });
		this.headEls["5h"] = this.buildSortHead(tr, "agent-sessions-manager-col-5h", "5h", "5h");
		this.headEls["7d"] = this.buildSortHead(tr, "agent-sessions-manager-col-7d", "7d", "7d");
		tr.createEl("th", { cls: "agent-sessions-manager-col-folder", text: t("table.folder") });
		tr.createEl("th", { cls: "agent-sessions-manager-col-menu" });
		this.applySortHighlight();
	}

	private buildSortHead(tr: HTMLTableRowElement, cls: string, label: string, key: SortKey): HTMLElement {
		const th = tr.createEl("th", { cls: `${cls} agent-sessions-manager-th-sort`, text: label });
		this.registerDomEvent(th, "click", () => {
			this.sortKey = key;
			this.applySortHighlight();
			this.render();
		});
		return th;
	}

	private applySortHighlight(): void {
		for (const [key, el] of Object.entries(this.headEls)) {
			el?.toggleClass("is-sorted", key === this.sortKey);
		}
	}

	/**
	 * Builds one analytics section per agent in `analysisAgents` (T-104): a heading (icon+name)
	 * when there's more than one, then that agent's own usage bar (5-hour/7-day cards) and
	 * per-category bars. With 0 or 1 agent enabled, `analysisAgents` is a single-item array
	 * (falling back to `["claude"]`), so this renders exactly one section with no heading —
	 * unchanged from before T-104. Called from `buildSkeleton`, so a settings change re-splits
	 * or re-merges the sections via the existing full-skeleton rebuild on `settings-changed`.
	 */
	private buildAnalysisSections(): void {
		const enabled = AGENT_IDS.filter((id) => this.plugin.settings.agents[id].enabled);
		this.analysisAgents = enabled.length > 0 ? enabled : ["claude"];
		this.statsBarEls = {};
		this.categoryBarWrapEls = {};
		this.agentSectionEls = {};
		this.agentCaretEls = {};
		this.agentSummaryEls = {};
		const split = this.analysisAgents.length > 1;
		for (const agent of this.analysisAgents) {
			const sectionEl = this.analysisBodyEl.createDiv({ cls: "agent-sessions-manager-analysis-section" });
			if (split) {
				this.agentSectionEls[agent] = sectionEl;
				this.buildAgentSectionHeading(sectionEl, agent);
			}
			this.statsBarEls[agent] = sectionEl.createDiv({ cls: "agent-sessions-manager-stats" });
			this.categoryBarWrapEls[agent] = sectionEl.createDiv({ cls: "agent-sessions-manager-category-bars" });
			if (split) {
				this.applyAgentFolded(agent, this.plugin.settings.managerAnalysisFolded[agent] ?? false);
			}
		}
		this.renderStatsBar();
		this.renderCategoryBars();
	}

	/**
	 * The agent-section heading: icon (`ui/icons.ts`, T-102) + display name + a caret — only
	 * built when more than one agent is enabled (`buildAnalysisSections`'s `split`; a single
	 * section is never foldable, there'd be nothing to fold it down to). Clicking it folds/unfolds
	 * just this section, saved per-agent to `managerAnalysisFolded` — independent of the whole
	 * analysis area's own fold (`toggleAnalysisCollapsed`). `stopPropagation` keeps this click from
	 * also triggering the analysis body's click-to-refresh.
	 */
	private buildAgentSectionHeading(container: HTMLElement, agent: AgentId): void {
		const heading = container.createDiv({ cls: "agent-sessions-manager-analysis-agent-heading" });
		this.agentCaretEls[agent] = heading.createSpan({ cls: "agent-sessions-manager-analysis-agent-caret" });
		const icon = AGENT_ICON_ID[agent];
		if (icon) {
			setIcon(heading.createSpan({ cls: "agent-sessions-manager-analysis-agent-icon" }), icon);
		}
		heading.createSpan({ text: t(AGENT_NAME_KEY[agent]) });
		this.agentSummaryEls[agent] = heading.createSpan({ cls: "agent-sessions-manager-analysis-agent-summary" });
		this.registerDomEvent(heading, "click", (evt) => {
			evt.stopPropagation();
			this.toggleAgentFolded(agent);
		});
	}

	private toggleAgentFolded(agent: AgentId): void {
		const folded = !this.plugin.settings.managerAnalysisFolded[agent];
		this.plugin.settings.managerAnalysisFolded = { ...this.plugin.settings.managerAnalysisFolded, [agent]: folded };
		void this.plugin.saveSettings();
		this.applyAgentFolded(agent, folded);
	}

	/** Folds/unfolds one agent's section: the heading stays, everything below it (usage bar,
	 * category bars) hides via CSS, and the caret and summary next to the heading update. */
	private applyAgentFolded(agent: AgentId, folded: boolean): void {
		this.agentSectionEls[agent]?.toggleClass("is-folded", folded);
		this.agentCaretEls[agent]?.setText(folded ? "▸" : "▾");
		this.updateAgentSummary(agent);
	}

	/**
	 * The small "primary window usage%" text shown next to a folded section's heading (my own
	 * design call for T-104's per-agent-fold request, so a folded section still tells you
	 * something at a glance instead of going completely silent): that agent's shortest real
	 * window (`realWindows(...)[0]` — 5-hour for Claude; for an account with no 5h/7d quota
	 * tracked at all, whichever non-standard window it does track, e.g. 30-day). Empty when
	 * nothing is tracked yet. Only meaningful while folded (CSS hides it otherwise), but kept
	 * up to date regardless so it's already correct the moment a section folds.
	 */
	private updateAgentSummary(agent: AgentId): void {
		const el = this.agentSummaryEls[agent];
		if (!el) {
			return;
		}
		const primary = realWindows(windowsForAgent(this.statsResult, agent))[0];
		el.setText(primary?.used_percentage != null ? `${Math.round(primary.used_percentage)}%` : "");
	}

	/** The usage bar (5-hour and 7-day windows) for every agent section: usage bar, countdown, cost, tokens, call count, session count. */
	private renderStatsBar(): void {
		for (const agent of this.analysisAgents) {
			const el = this.statsBarEls[agent];
			if (!el) {
				continue;
			}
			el.empty();
			const windows = orderedWindows(windowsForAgent(this.statsResult, agent));
			if (windows.length === 0) {
				// Not fetched yet (or nothing at all for this agent) — the two well-known
				// windows as "—" placeholders, matching the pre-T-104 loading look, rather than
				// an empty section.
				this.renderStatsCard(el, t("stats.fiveHour"), null);
				this.renderStatsCard(el, t("stats.sevenDay"), null);
			} else {
				for (const w of windows) {
					this.renderStatsCard(el, windowLabel(w.minutes), w);
				}
			}
			this.updateAgentSummary(agent);
		}
	}

	/** "Resets in…" next to the card's heading, a labeled 2×2 grid below it. The pace line is
	 * shown for every window now (T-104 addendum — `weeklyPace`'s "too early" threshold scales
	 * with the window's own length, so a short window just settles into "too early" rather than
	 * needing to be excluded here). */
	private renderStatsCard(container: HTMLElement, label: string, w: StatsWindow | null): void {
		const card = container.createDiv({ cls: "agent-sessions-manager-stats-card" });

		const head = card.createDiv({ cls: "agent-sessions-manager-stats-head" });
		head.createSpan({ cls: "agent-sessions-manager-stats-title", text: label });
		const countdown = w ? formatCountdown(w.end - Date.now() / 1000) : null;
		head.createSpan({
			cls: "agent-sessions-manager-stats-countdown",
			text: countdown != null ? t("stats.resetsIn", { countdown }) : "—",
		});

		const barWrap = card.createDiv({ cls: "agent-sessions-manager-stats-bar" });
		const pct = w?.used_percentage != null ? Math.min(100, Math.max(0, w.used_percentage)) : 0;
		barWrap.createDiv({ cls: "agent-sessions-manager-stats-bar-fill" }).style.width = `${pct}%`;

		const pctText = w?.used_percentage != null ? `${Math.round(w.used_percentage)}%` : "—";
		card.createDiv({ cls: "agent-sessions-manager-stats-pct", text: pctText });

		this.renderPaceLine(card, w);

		const summary = w ? windowSummary(w) : null;
		const metrics = card.createDiv({ cls: "agent-sessions-manager-stats-metrics" });
		this.renderMetric(metrics, t("stats.metric.cost"), w ? formatCost(w.total.cost) : "—", t("stats.metric.costTip"));
		this.renderMetric(
			metrics,
			t("stats.metric.tokens"),
			summary ? formatK(summary.tokens) : "—",
			t("stats.metric.tokensTip")
		);
		this.renderMetric(metrics, t("stats.metric.calls"), w ? formatK(w.total.calls) : "—", t("stats.metric.callsTip"));
		this.renderMetric(
			metrics,
			t("stats.metric.sessions"),
			summary ? String(summary.sessionCount) : "—",
			t("stats.metric.sessionsTip")
		);
	}

	/**
	 * One line below a card's usage bar: whether that window will last at the current pace
	 * (`weeklyPace`, T-104 addendum — every window gets this line now, not just a fixed 7-day
	 * one). Green if on track, orange with a daily-cap estimate (second line) if it'll run out,
	 * or muted gray with the reason if it can't be judged yet. The tooltip explains the judgment
	 * (elapsed % and used %).
	 */
	private renderPaceLine(card: HTMLElement, w: StatsWindow | null): void {
		const lineEl = card.createDiv({ cls: "agent-sessions-manager-stats-pace" });
		if (!w || w.used_percentage == null) {
			lineEl.addClass("is-muted");
			lineEl.setText(t("stats.pace.unknown"));
			return;
		}
		const now = Date.now() / 1000;
		const pace = weeklyPace(w.used_percentage, w.start, w.end, now, w.total.cost);
		const tooltipText = (elapsedPct: number, usedPct: number) =>
			t("stats.pace.tooltip", { elapsedPct: String(Math.round(elapsedPct)), usedPct: String(Math.round(usedPct)) });

		if (pace.kind === "unknown" || pace.kind === "too-early") {
			lineEl.addClass("is-muted");
			lineEl.setText(t("stats.pace.tooEarly"));
			if (pace.kind === "too-early") {
				setTooltip(lineEl, tooltipText(pace.elapsedPct, w.used_percentage));
			}
			return;
		}
		if (pace.kind === "on-track") {
			lineEl.addClass("is-good");
			lineEl.setText(t("stats.pace.onTrack", { pct: `${Math.round(pace.projectedPct)}%` }));
			setTooltip(lineEl, tooltipText(pace.elapsedPct, pace.usedPct));
			return;
		}
		lineEl.addClass("is-warn");
		const when = formatWeekdayTime(pace.exhaustAt, getLang());
		lineEl.createDiv({
			cls: "agent-sessions-manager-stats-pace-main",
			text: t("stats.pace.overPace", {
				when,
				days: String(pace.daysBeforeReset),
				hours: String(pace.hoursBeforeReset),
			}),
		});
		const pctText = `${pace.maxDailyPct.toFixed(1)}%`;
		lineEl.createDiv({
			cls: "agent-sessions-manager-stats-pace-guide",
			text:
				pace.maxDailyCost != null
					? t("stats.pace.overPaceGuide", { pct: pctText, cost: formatCost(pace.maxDailyCost) })
					: t("stats.pace.overPaceGuideNoCost", { pct: pctText }),
		});
		setTooltip(lineEl, tooltipText(pace.elapsedPct, pace.usedPct));
	}

	/** A cell of a faint label plus a bold value. The tooltip defines what the value means. */
	private renderMetric(container: HTMLElement, label: string, value: string, tooltip: string): void {
		const cell = container.createDiv({ cls: "agent-sessions-manager-stats-metric" });
		cell.createDiv({ cls: "agent-sessions-manager-stats-metric-label", text: label });
		cell.createDiv({ cls: "agent-sessions-manager-stats-metric-value", text: value });
		setTooltip(cell, tooltip);
	}

	/** Below each agent section's usage bar: one "by category" horizontal bar per window in that
	 * section (T-104 addendum — not just a fixed 5-hour/7-day pair), side by side when there's
	 * room and stacked when there isn't (each is `topCategoryTotals` up to 8 by cost) — counting
	 * only that agent's own sessions. */
	private renderCategoryBars(): void {
		for (const agent of this.analysisAgents) {
			const wrapEl = this.categoryBarWrapEls[agent];
			if (!wrapEl) {
				continue;
			}
			wrapEl.empty();
			const rows = [...this.plugin.index.sessions.values()].filter((r) => r.agent === agent);
			const windows = orderedWindows(windowsForAgent(this.statsResult, agent));
			if (windows.length === 0) {
				// Not fetched yet — match renderStatsBar's placeholder pair.
				this.renderCategoryBar(wrapEl, t("stats.categoryBar.title", { window: t("stats.fiveHour") }), rows, null);
				this.renderCategoryBar(wrapEl, t("stats.categoryBar.title", { window: t("stats.sevenDay") }), rows, null);
				continue;
			}
			for (const w of windows) {
				this.renderCategoryBar(wrapEl, t("stats.categoryBar.title", { window: windowLabel(w.minutes) }), rows, w);
			}
		}
	}

	private renderCategoryBar(container: HTMLElement, title: string, rows: Row[], window: StatsWindow | null): void {
		const el = container.createDiv({ cls: "agent-sessions-manager-category-bar" });
		el.createDiv({ cls: "agent-sessions-manager-category-bar-title", text: title });

		const totals = categoryTotalsForWindow(rows, window);
		// Categories with 0 cost (inactive in this window) aren't listed.
		const top = topCategoryTotals(totals, CATEGORY_BAR_TOP_N);
		if (top.length === 0) {
			el.createDiv({ cls: "agent-sessions-manager-category-bar-empty", text: t("stats.categoryBar.empty") });
			return;
		}

		const windowCost = window?.total.cost ?? 0;
		const maxCost = Math.max(...top.map((c) => c.cost), 0);
		const list = el.createDiv({ cls: "agent-sessions-manager-category-bar-list" });
		for (const entry of top) {
			this.renderCategoryBarItem(list, entry, maxCost, windowCost);
		}
	}

	private renderCategoryBarItem(container: HTMLElement, entry: CategoryTotal, maxCost: number, windowCost: number): void {
		const item = container.createDiv({ cls: "agent-sessions-manager-category-bar-item" });
		const labelWrap = item.createDiv({ cls: "agent-sessions-manager-category-bar-label" });
		const isReal = isRealCategoryKey(entry.key);
		const hueDeg = isReal ? paletteHueDeg(this.plugin.index.categoryColorIndex(entry.key)) : null;
		if (hueDeg !== null) {
			// A real category is represented by its chip alone — the chip's text already is the
			// category name, so no separate text is layered on top of it (avoids duplication).
			renderCategoryChip(labelWrap, entry.key, this.plugin.index.categoryColorIndex(entry.key));
		} else {
			// "No category"/"No name" have no chip color to show, so they're shown as plain text.
			labelWrap.createSpan({ cls: "agent-sessions-manager-category-bar-label-text", text: entry.label });
		}
		const track = item.createDiv({ cls: "agent-sessions-manager-category-bar-track" });
		const barPct = maxCost > 0 ? (entry.cost / maxCost) * 100 : 0;
		// The bar's color matches its chip's hue. "No category"/"No name" have no chip, so their
		// bar stays gray to set them apart.
		const fill = track.createDiv({ cls: "agent-sessions-manager-category-bar-fill" });
		if (hueDeg !== null) {
			fill.style.setProperty("--as-chip-hue", String(hueDeg));
		} else {
			fill.addClass("is-neutral");
		}
		fill.style.width = `${barPct}%`;
		const share = windowCost > 0 ? Math.round((entry.cost / windowCost) * 100) : 0;
		item.createDiv({
			cls: "agent-sessions-manager-category-bar-value",
			text: t("stats.categoryBar.itemCost", { cost: formatCost(entry.cost), share }),
		});
		this.registerDomEvent(item, "click", (evt) => {
			// Keep this from also triggering the analysis area's click-to-refresh.
			evt.stopPropagation();
			this.scrollToCategory(entry.key);
		});
	}

	/** Clicking the per-category bar: scrolls to and opens that group. For a category with no
	 * heading of its own (a standalone one), selects and scrolls to that category's first session row instead. */
	private scrollToCategory(key: string): void {
		const groupIdx = this.rows.findIndex((r) => r.kind === "group" && r.key === key);
		if (groupIdx >= 0) {
			const group = this.rows[groupIdx] as Extract<ManagerRow, { kind: "group" }>;
			if (group.folded) {
				this.toggleFold(group);
			}
			const idx = this.rows.findIndex((r) => r.kind === "group" && r.key === key);
			this.rowEls[idx]?.scrollIntoView({ block: "nearest" });
			return;
		}
		const sessionIdx = this.rows.findIndex((r) => r.kind === "session" && categoryKeyOf(r.row) === key);
		if (sessionIdx >= 0) {
			this.selectIndex(sessionIdx);
		}
	}

	private buildToolbar(): void {
		const toolbarEl = this.contentEl.createDiv({ cls: "agent-sessions-manager-toolbar" });
		this.iconButton(toolbarEl, "plus", t("action.newSession"), () => this.openNewSessionModal());
		this.iconButton(toolbarEl, "rotate-cw", t("action.rescan"), () => {
			void this.plugin.index.rescan();
			void this.refreshStats();
		});

		this.filterEl = toolbarEl.createEl("input", {
			type: "text",
			placeholder: t("toolbar.filterPlaceholder"),
			cls: "agent-sessions-manager-filter",
		});
		this.filterEl.value = this.filterText;
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

		this.statusFilterBtn = this.iconButton(toolbarEl, "filter", t("toolbar.filterByStatus"), (evt) =>
			this.showStatusFilterMenu(evt)
		);
		this.applyStatusFilterButtonState();

		const moreBtn = this.iconButton(toolbarEl, "more-horizontal", t("action.more"), (evt) => this.showMoreMenu(evt));
		moreBtn.addClass("agent-sessions-nav-more");
	}

	/** The toolbar's status-filter menu (next to the name filter): "all" plus every status group
	 * except `error` (which has no filter bucket of its own — see `ManagerStatusFilter`), each
	 * with the same icon Claude's own app uses for that bucket, checked on the current selection.
	 * The choice persists in settings. */
	private showStatusFilterMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const filter of MANAGER_STATUS_FILTERS) {
			menu.addItem((item) => {
				item
					.setTitle(t(managerStatusFilterLabelKey(filter)))
					.setChecked(this.plugin.settings.managerStatusFilter === filter)
					.onClick(() => {
						this.plugin.settings.managerStatusFilter = filter;
						void this.plugin.saveSettings();
						this.applyStatusFilterButtonState();
						this.render();
					});
				if (filter !== "all") {
					item.setIcon(STATUS_GROUP_ICON[filter]);
				}
			});
		}
		menu.showAtMouseEvent(evt);
	}

	/** Highlights the status-filter button while a specific filter (anything but "all") is active. */
	private applyStatusFilterButtonState(): void {
		this.statusFilterBtn.toggleClass("is-active", this.plugin.settings.managerStatusFilter !== "all");
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
				.setTitle(t("action.showArchived"))
				.setChecked(this.showArchived)
				.onClick(() => {
					this.showArchived = !this.showArchived;
					this.render();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	// ---- Table ---------------------------------------------------------------------

	private render(): void {
		const store = loadStore(this.plugin.storePath());
		let sessionRows = [...this.plugin.index.sessions.values()];
		if (this.filterText.trim()) {
			const needle = this.filterText.trim().toLowerCase();
			sessionRows = sessionRows.filter((r) => (r.name || r.label || r.id).toLowerCase().includes(needle));
		}
		const statusFilter = this.plugin.settings.managerStatusFilter;
		sessionRows = sessionRows.filter((r) =>
			matchesStatusFilter(r, resolveRowStatus(this.plugin, r), statusFilter, this.showArchived)
		);
		// "archived" narrows sessionRows to archived rows only, so the tree's active/other
		// sections come out empty and only its (always-shown-when-requested) archive section has
		// anything in it — flattenTree still needs `showArchived: true` to actually reveal that
		// section. "all" defers to the toolbar's separate "Show archive" checkbox, same as before
		// this filter existed. Any other specific filter already excludes archived rows
		// (`matchesStatusFilter`), so whether the tree's archive section shows is moot for those.
		const showArchivedSection = statusFilter === "archived" || (statusFilter === "all" && this.showArchived);
		const tree = buildManagerTree(sessionRows, store);
		this.rows = sortRows(flattenTree(tree, showArchivedSection), this.sortKey, this.statsResult);
		this.cursor = moveSelection(this.rows, this.cursor, 0);
		this.actions = createRowActions(this.plugin, (id) => this.selectById(id));
		// Group heading rows' 5h/7d cost totals: only counts rows shown in the table (post-filter)
		// — matches the heading's `count` (`flattenTree`'s `group.rows.length`).
		this.categoryTotalsByWindow = {
			"5h": new Map(categoryTotals(sessionRows, this.statsResult, "5h").map((c) => [c.key, c])),
			"7d": new Map(categoryTotals(sessionRows, this.statsResult, "7d").map((c) => [c.key, c])),
		};
		// Group headings' asking/waiting marker: counted from all post-filter sessions (before
		// building the tree passed to `flattenTree`), so it reflects state even while folded.
		this.groupUrgency = urgencyByGroupKey(this.plugin, sessionRows, categoryKeyOf);

		this.timeTicker.reset();
		this.tableBodyEl.empty();
		this.rowEls = this.rows.map((mrow, index) => this.renderRow(mrow, index));
		this.applySelectionHighlight();
		this.refreshDetail();
	}

	private renderRow(mrow: ManagerRow, index: number): HTMLTableRowElement {
		if (mrow.kind === "group") {
			const tr = this.tableBodyEl.createEl("tr", { cls: "agent-sessions-manager-row is-group" });
			// The heading, fold triangle, and count span the mark/name/last-updated columns (3
			// columns; no time value). 5h/7d line up with that category's totals in their own column positions.
			const headTd = tr.createEl("td", { cls: "agent-sessions-manager-col-name", attr: { colspan: "3" } });
			const head = headTd.createDiv({ cls: "agent-sessions-manager-group-head" });
			head.createSpan({ cls: "agent-sessions-manager-caret", text: mrow.folded ? "▸" : "▾" });
			// A real category has `mrow.label === mrow.key` (the group name itself), so showing
			// that same text alongside the chip would duplicate it — use the chip alone.
			// "No category"/"No name" have no chip color, so those keep the plain text label as before.
			if (isRealCategoryKey(mrow.key)) {
				renderCategoryChip(head, mrow.key, this.plugin.index.categoryColorIndex(mrow.key));
			} else {
				head.createSpan({ cls: "agent-sessions-manager-group-label", text: mrow.label });
			}
			const urgency = this.groupUrgency.get(mrow.key);
			if (urgency) {
				this.renderGroupUrgencyMark(head, urgency);
			}
			head.createSpan({ cls: "agent-sessions-manager-group-count", text: String(mrow.count) });
			// Model and effort are per-session values, so the heading row leaves those cells empty.
			tr.createEl("td", { cls: "agent-sessions-manager-col-model" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-effort" });
			this.renderGroupCostCell(tr, "agent-sessions-manager-col-5h", "5h", mrow.key);
			this.renderGroupCostCell(tr, "agent-sessions-manager-col-7d", "7d", mrow.key);
			tr.createEl("td", { cls: "agent-sessions-manager-col-folder" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-menu" });
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
			tr.createEl("td", {
				cls: "agent-sessions-manager-col-name",
				text: mrow.name || sessionDisplayName({ name: null, label: null, agent: mrow.agent, id: mrow.id }),
			});
			tr.createEl("td", { cls: "agent-sessions-manager-col-time" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-model" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-effort" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-5h" });
			tr.createEl("td", { cls: "agent-sessions-manager-col-7d" });
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
		// Makes rows that are asking (waiting for an answer) or waiting (idle since busy, not yet seen) stand out.
		const attentionStatus = resolveRowStatus(this.plugin, row);
		if (attentionStatus === "asking") {
			tr.addClass("is-asking");
		} else if (attentionStatus === "waiting") {
			tr.addClass("is-waiting");
		}

		const markTd = tr.createEl("td", { cls: "agent-sessions-manager-col-mark" });
		rowStatusMark(markTd, this.plugin, row);
		const nameTd = tr.createEl("td", { cls: "agent-sessions-manager-col-name" });
		const nameWrap = nameTd.createDiv({ cls: "agent-sessions-manager-name-cell" });
		renderAgentMark(nameWrap, row.agent);
		const category = categoryOf(row);
		// A row under a heading (group, no-category, or no-name — `indent` is true) doesn't get
		// its own chip, since the heading above it already shows the category once. Only rows in
		// an unheaded list (sorted by 5h/7d) get a chip on the row itself.
		if (category && !mrow.indent) {
			renderCategoryChip(nameWrap, category, this.plugin.index.categoryColorIndex(category));
		}
		nameWrap.createSpan({ cls: "agent-sessions-manager-name-text", text: rowLabel(row) });
		const timeTd = tr.createEl("td", { cls: "agent-sessions-manager-col-time", text: formatRelativeTime(row.last_activity) });
		if (row.last_activity) {
			setTooltip(timeTd, formatTime(row.last_activity));
			this.timeTicker.track(timeTd, row.last_activity);
		}
		const statusInfo = this.plugin.index.statusline.get(row.id);
		this.renderShortValueCell(tr, "agent-sessions-manager-col-model", shortModelName(statusInfo?.model ?? null), statusInfo?.model ?? null);
		this.renderShortValueCell(tr, "agent-sessions-manager-col-effort", statusInfo?.effort ?? "", statusInfo?.effort ?? null);
		this.renderCostCell(tr, "agent-sessions-manager-col-5h", row, "5h");
		this.renderCostCell(tr, "agent-sessions-manager-col-7d", row, "7d");
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

	/** One 5h/7d column cell: blank if that session had no usage within the window. Looks up
	 * `row`'s own agent's windows (`sessionCostForRow`) — a mixed-agent table still attributes
	 * each row's cost to the right agent's data (T-104). */
	private renderCostCell(tr: HTMLTableRowElement, cls: string, row: Row, key: "5h" | "7d"): void {
		const cost = sessionCostForRow(this.statsResult, row, key);
		tr.createEl("td", {
			cls: `${cls} agent-sessions-manager-col-num`,
			text: cost != null ? formatCost(cost) : "",
		});
	}

	/** One model/effort column cell: shows the short form (`short`), with the full value in the
	 * tooltip (`full`, or "Unknown" if absent). The value comes from the same
	 * `statusline.get(id)` the detail panel uses. */
	private renderShortValueCell(tr: HTMLTableRowElement, cls: string, short: string, full: string | null): void {
		const td = tr.createEl("td", { cls, text: short });
		setTooltip(td, full ?? t("common.unknown"));
	}

	/** A small marker on a group heading when it contains an asking/waiting row. Doesn't change
	 * row order — shown only on the heading, so it's visible even while folded. */
	private renderGroupUrgencyMark(head: HTMLElement, urgency: GroupUrgency): void {
		const mark = head.createSpan({ cls: `agent-sessions-group-urgency agent-sessions-status-${urgency}` });
		setIcon(mark, TERMINAL_STATUS_ICON[urgency]);
		setTooltip(mark, urgency === "asking" ? t("attention.askingInGroup") : t("attention.waitingInGroup"));
	}

	/** One 5h/7d column cell on a group heading row: that category's total, blank if there is none. */
	private renderGroupCostCell(tr: HTMLTableRowElement, cls: string, window: "5h" | "7d", key: string): void {
		const entry = this.categoryTotalsByWindow[window].get(key);
		tr.createEl("td", {
			cls: `${cls} agent-sessions-manager-col-num`,
			text: entry && entry.cost > 0 ? formatCost(entry.cost) : "",
		});
	}

	private toggleFold(group: Extract<ManagerRow, { kind: "group" }>): void {
		if (group.key === ARCHIVED_GROUP) {
			// The archive heading doesn't fold — it's shown/hidden via the "show archive" toggle instead.
			return;
		}
		this.plugin.setFolded(group.key, !group.folded);
		this.render();
	}

	// ---- Selection and keyboard controls (same ↑/↓, Enter, `/` as the TUI) -------------------------

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

	// ---- Detail panel -----------------------------------------------------------------

	/**
	 * Shows the selected row if there is one; otherwise falls back to a default (the frontmost
	 * terminal tab's session, or failing that, the table's first session row). Empties the panel if neither is available.
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
			fetchUsage: () => usage(this.plugin.agentSessionsPath(), this.plugin.vaultPath(), id),
			categoryColorIndex: (category) => this.plugin.index.categoryColorIndex(category),
		};
		renderDetail(this.detailEl, ctx);
	}
}
