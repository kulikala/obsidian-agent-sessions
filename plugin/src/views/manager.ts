// セッションマネージャー（D-8・D-44・§6.2）：表・折畳・絞込・アーカイブ表示・詳細パネル。
// サイドパネルとは見た目を変える（罫線のある表、等幅の日時列）。行の描画ロジック
// （状態の印・名前・時刻の整形、⋯ の行メニュー）は `rows.ts` を再利用する。

import { ItemView, Menu, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import type AgentSessionsPlugin from "../main";
import { stats, usage } from "../backend";
import { paletteHueDeg } from "../category";
import { t } from "../i18n";
import { NewSessionModal } from "../modals";
import { VIEW_TYPE_TERMINAL } from "../open-session";
import { loadStore } from "../store";
import { buildManagerTree } from "../tree";
import type { StatsResult, StatsWindow } from "../types";
import { formatK } from "../usage";
import { formatCost, renderDetail, type DetailContext } from "./detail";
import { formatCountdown } from "./limits";
import {
	ARCHIVED_GROUP,
	categoryKeyOf,
	categoryTotals,
	flattenTree,
	isRealCategoryKey,
	moveSelection,
	sessionCost,
	sortRows,
	topCategoryTotals,
	windowSummary,
	type CategoryTotal,
	type ManagerRow,
	type SortKey,
} from "./manager-model";
import { categoryOf, createRowActions, formatTime, renderCategoryChip, rowLabel, rowStatusMark, showRowMenu, type RowActions } from "./rows";

const STATS_FETCH_INTERVAL_MS = 60000;
const STATS_TICK_INTERVAL_MS = 1000;

const COLUMN_COUNT = 7;
/** カテゴリ別の横バー（D-64）に出す上位カテゴリの数。 */
const CATEGORY_BAR_TOP_N = 8;
/** `terminal-status`（D-66 追補）は busy/idle のたびに飛んでくるので、まとめて描き直す間隔。 */
const TERMINAL_STATUS_DEBOUNCE_MS = 200;
/** ドラッグで詰められる下部・解析領域の下限（px。T-70 追補）。 */
const MIN_ANALYSIS_HEIGHT = 120;

export const VIEW_TYPE_MANAGER = "agent-sessions-manager";

export class ManagerView extends ItemView {
	private plugin: AgentSessionsPlugin;

	private wrapEl!: HTMLElement;
	private statsBarEl!: HTMLElement;
	private headEls: Partial<Record<SortKey, HTMLElement>> = {};
	private tableBodyEl!: HTMLTableSectionElement;
	private detailEl!: HTMLElement;
	private filterEl!: HTMLInputElement;

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
	/** 前面のターミナルタブのセッション（詳細パネルの既定表示に使う）。 */
	private frontId: string | null = null;
	/** グループ見出し行の 5h／7d コスト合計（`render()` で作り直す。`categoryKeyOf` の鍵。D-64）。 */
	private categoryTotalsByWindow: Record<"5h" | "7d", Map<string, CategoryTotal>> = {
		"5h": new Map(),
		"7d": new Map(),
	};
	private categoryBarEl!: HTMLElement;
	/** `terminal-status` のデバウンス用タイマー（D-66 追補）。 */
	private statusRenderTimer: ReturnType<typeof setTimeout> | null = null;
	/** 下部・解析領域（統計の帯＋カテゴリ別バー。T-70 追補）。見出しクリックで折畳、
	 * ハンドルで高さを変える——どちらも `plugin.settings` に保存する。 */
	private analysisEl!: HTMLElement;
	private analysisCaretEl!: HTMLElement;
	private analysisBodyEl!: HTMLElement;
	private analysisHandleEl!: HTMLElement;
	private analysisHeight = 240;

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

		// セッション一覧が変わるたび、表だけでなくカテゴリ別バーも作り直す（D-64）——
		// `stats()`（daemon）の解決がセッション走査より早く終わっても、走査が終わり次第
		// 追いつく（実機修正：走査未完了のまま `refreshStats()` が先に解決すると空になっていた）。
		this.register(this.plugin.index.onChange(() => {
			this.renderCategoryBar();
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

		void this.plugin.index.rescan();
		void this.refreshStats();
		this.render();
		this.wrapEl.focus();
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

	/**
	 * 言語が変わったとき（§6.9・D-56）：タブ見出しと骨組み（見出し・ツールバー・統計の帯）を
	 * 描き直す。骨組みは固定文言（tooltip・列見出し・placeholder）を開いたときに 1 回だけ組むため、
	 * 描き直すには作り直すのが早い（`statsResult`・選択・折畳は保つ）。
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

	/** `json stats`（D-54・D-55）：開いたとき・再走査・60 秒毎に読み直す。失敗したら帯に「—」。 */
	private async refreshStats(): Promise<void> {
		try {
			this.statsResult = await stats(this.plugin.agentSessionsPath());
		} catch {
			this.statsResult = null;
		}
		this.renderStatsBar();
		this.renderCategoryBar();
		this.render();
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
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-5h" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-7d" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-folder" });
		colgroup.createEl("col", { cls: "agent-sessions-manager-col-menu" });
		this.buildHead(table);
		this.tableBodyEl = table.createEl("tbody");

		this.detailEl = body.createDiv({ cls: "agent-sessions-manager-detail" });

		// 下部・解析領域（T-70 追補：一覧を上、解析を下に入れ替えた——一覧が主役で、
		// 解析はいつでも見返せる補助情報のため）。
		this.analysisHandleEl = this.contentEl.createDiv({ cls: "agent-sessions-drag-handle" });
		this.bindAnalysisHandle();

		this.analysisEl = this.contentEl.createDiv({ cls: "agent-sessions-manager-analysis" });
		this.buildAnalysisHeader();
		this.analysisBodyEl = this.analysisEl.createDiv({ cls: "agent-sessions-manager-analysis-body" });
		this.buildStatsBar();
		this.buildCategoryBar();

		this.applyAnalysisHeight(this.plugin.settings.managerAnalysisHeight);
		this.applyAnalysisCollapsed(this.plugin.settings.managerAnalysisCollapsed);
	}

	/** 解析領域の見出し：クリックで折畳（キャレット＋「解析」）。状態は設定に保存する。 */
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

	/** 一覧と解析の間のドラッグハンドル（`views/side.ts` の詳細欄と同じ作り）。 */
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

	/** 見出し行。「最終更新」「5h」「7d」はクリックで並べ替え（D-54）。 */
	private buildHead(table: HTMLTableElement): void {
		const thead = table.createEl("thead");
		const tr = thead.createEl("tr", { cls: "agent-sessions-manager-row" });
		tr.createEl("th", { cls: "agent-sessions-manager-col-mark" });
		tr.createEl("th", { cls: "agent-sessions-manager-col-name", text: t("table.name") });
		this.headEls.updated = this.buildSortHead(tr, "agent-sessions-manager-col-time", t("table.updated"), "updated");
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

	/** 統計の帯（5 時間枠・7 日枠。D-54）：使用率のバー・カウントダウン・コスト・トークン・呼出数・セッション数。 */
	private buildStatsBar(): void {
		this.statsBarEl = this.analysisBodyEl.createDiv({ cls: "agent-sessions-manager-stats" });
		this.renderStatsBar();
	}

	private renderStatsBar(): void {
		this.statsBarEl.empty();
		this.renderStatsCard(this.statsBarEl, t("stats.fiveHour"), this.statsResult?.windows.five_hour ?? null);
		this.renderStatsCard(this.statsBarEl, t("stats.sevenDay"), this.statsResult?.windows.seven_day ?? null);
	}

	/** カード見出しの横に「リセットまで…」、下段はラベル付き 2×2（D-62）。 */
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

	/** ラベル（薄）＋値（太字）の 1 マス。tooltip にその値の定義（D-62）。 */
	private renderMetric(container: HTMLElement, label: string, value: string, tooltip: string): void {
		const cell = container.createDiv({ cls: "agent-sessions-manager-stats-metric" });
		cell.createDiv({ cls: "agent-sessions-manager-stats-metric-label", text: label });
		cell.createDiv({ cls: "agent-sessions-manager-stats-metric-value", text: value });
		setTooltip(cell, tooltip);
	}

	/** 統計の帯の下：「カテゴリ別（7 日枠）」の横バー（コスト上位 8。D-64）。 */
	private buildCategoryBar(): void {
		this.categoryBarEl = this.analysisBodyEl.createDiv({ cls: "agent-sessions-manager-category-bar" });
		this.renderCategoryBar();
	}

	private renderCategoryBar(): void {
		this.categoryBarEl.empty();
		this.categoryBarEl.createDiv({
			cls: "agent-sessions-manager-category-bar-title",
			text: t("stats.categoryBar.title"),
		});

		const allRows = [...this.plugin.index.sessions.values()];
		const totals = categoryTotals(allRows, this.statsResult, "7d");
		// コスト 0（この枠で動いていない）のカテゴリは並べない（実機修正：D-64 追補）。
		const top = topCategoryTotals(totals, CATEGORY_BAR_TOP_N);
		if (top.length === 0) {
			this.categoryBarEl.createDiv({
				cls: "agent-sessions-manager-category-bar-empty",
				text: t("stats.categoryBar.empty"),
			});
			return;
		}

		const windowCost = this.statsResult?.windows.seven_day.total.cost ?? 0;
		const maxCost = Math.max(...top.map((c) => c.cost), 0);
		const list = this.categoryBarEl.createDiv({ cls: "agent-sessions-manager-category-bar-list" });
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
			// 実際のカテゴリはチップ 1 つだけでラベルを表す——チップの文字＝カテゴリ名なので、
			// 別にテキストを重ねて出さない（文字の重複解消。T-70 追補）。
			renderCategoryChip(labelWrap, entry.key, this.plugin.index.categoryColorIndex(entry.key));
		} else {
			// 「カテゴリなし」「名前なし」はチップに出す色が無いので、地の文字で出す。
			labelWrap.createSpan({ cls: "agent-sessions-manager-category-bar-label-text", text: entry.label });
		}
		const track = item.createDiv({ cls: "agent-sessions-manager-category-bar-track" });
		const barPct = maxCost > 0 ? (entry.cost / maxCost) * 100 : 0;
		// バーの色もチップと同じ色相にする（T-70 追補）。「カテゴリなし」「名前なし」はチップが
		// 無いので、バーも灰色のまま区別する。
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
			text: `${formatCost(entry.cost)}（${share}%）`,
		});
		this.registerDomEvent(item, "click", () => this.scrollToCategory(entry.key));
	}

	/** カテゴリ別バーのクリック：そのグループへスクロールして開く。見出しが無いカテゴリ
	 * （「単独」）は、そのカテゴリの最初のセッション行を選んでスクロールする（D-64）。 */
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

		const moreBtn = this.iconButton(toolbarEl, "more-horizontal", t("action.more"), (evt) => this.showMoreMenu(evt));
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
		new NewSessionModal(this.plugin, (name) => this.plugin.newSession(name || undefined)).open();
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

	// ---- 表 ---------------------------------------------------------------------

	private render(): void {
		const store = loadStore(this.plugin.storePath());
		let sessionRows = [...this.plugin.index.sessions.values()];
		if (this.filterText.trim()) {
			const needle = this.filterText.trim().toLowerCase();
			sessionRows = sessionRows.filter((r) => (r.name || r.label || r.id).toLowerCase().includes(needle));
		}
		const tree = buildManagerTree(sessionRows, store);
		this.rows = sortRows(flattenTree(tree, this.showArchived), this.sortKey, this.statsResult);
		this.cursor = moveSelection(this.rows, this.cursor, 0);
		this.actions = createRowActions(this.plugin, (id) => this.selectById(id));
		// グループ見出し行の 5h／7d コスト合計（D-64）：表に出ている行（絞込後）だけを数える
		// ——見出しの `count`（`flattenTree` が渡す `group.rows.length`）と揃える。
		this.categoryTotalsByWindow = {
			"5h": new Map(categoryTotals(sessionRows, this.statsResult, "5h").map((c) => [c.key, c])),
			"7d": new Map(categoryTotals(sessionRows, this.statsResult, "7d").map((c) => [c.key, c])),
		};

		this.tableBodyEl.empty();
		this.rowEls = this.rows.map((mrow, index) => this.renderRow(mrow, index));
		this.applySelectionHighlight();
		this.refreshDetail();
	}

	private renderRow(mrow: ManagerRow, index: number): HTMLTableRowElement {
		if (mrow.kind === "group") {
			const tr = this.tableBodyEl.createEl("tr", { cls: "agent-sessions-manager-row is-group" });
			// 見出し・折畳の三角・件数はマーク／名前／最終更新の 3 列分（時刻は持たない）。
			// 5h・7d はそのカテゴリの合計を列の位置に揃える（D-64）。
			const headTd = tr.createEl("td", { cls: "agent-sessions-manager-col-name", attr: { colspan: "3" } });
			const head = headTd.createDiv({ cls: "agent-sessions-manager-group-head" });
			head.createSpan({ cls: "agent-sessions-manager-caret", text: mrow.folded ? "▸" : "▾" });
			// 実カテゴリは `mrow.label === mrow.key`（グループ名そのもの）なので、チップと
			// 同じ文字をテキストでも出すと二重表示になる。チップだけにする——「カテゴリなし」
			// 「名前なし」はチップの色を持たないので、従来どおり文字のラベルを出す
			// （T-70 追補：見出し行の文字の重複解消）。
			if (isRealCategoryKey(mrow.key)) {
				renderCategoryChip(head, mrow.key, this.plugin.index.categoryColorIndex(mrow.key));
			} else {
				head.createSpan({ cls: "agent-sessions-manager-group-label", text: mrow.label });
			}
			head.createSpan({ cls: "agent-sessions-manager-group-count", text: String(mrow.count) });
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
			tr.createEl("td", { cls: "agent-sessions-manager-col-name", text: mrow.name || t("common.untitled", { id: mrow.id.slice(0, 8) }) });
			tr.createEl("td", { cls: "agent-sessions-manager-col-time" });
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

		const markTd = tr.createEl("td", { cls: "agent-sessions-manager-col-mark" });
		rowStatusMark(markTd, this.plugin, row);
		const nameTd = tr.createEl("td", { cls: "agent-sessions-manager-col-name" });
		const nameWrap = nameTd.createDiv({ cls: "agent-sessions-manager-name-cell" });
		const category = categoryOf(row);
		// 見出し（グループ・カテゴリなし・名前なし）の下に居る行（`indent`）は、その見出しが
		// 既にカテゴリを 1 回出しているので行にはチップを付けない（重複表示の解消。T-70 追補）。
		// 見出しの無い並び（5h／7d で並べ替えたとき）だけ、行にチップを付ける。
		if (category && !mrow.indent) {
			renderCategoryChip(nameWrap, category, this.plugin.index.categoryColorIndex(category));
		}
		nameWrap.createSpan({ cls: "agent-sessions-manager-name-text", text: rowLabel(row) });
		tr.createEl("td", { cls: "agent-sessions-manager-col-time", text: formatTime(row.last_activity) });
		this.renderCostCell(tr, "agent-sessions-manager-col-5h", this.statsResult?.windows.five_hour, row.id);
		this.renderCostCell(tr, "agent-sessions-manager-col-7d", this.statsResult?.windows.seven_day, row.id);
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

	/** 5h／7d の列 1 セル：枠内にそのセッションの使用が無ければ空欄（D-54）。 */
	private renderCostCell(tr: HTMLTableRowElement, cls: string, window: StatsWindow | undefined, id: string): void {
		const cost = sessionCost(window ?? null, id);
		tr.createEl("td", {
			cls: `${cls} agent-sessions-manager-col-num`,
			text: cost != null ? formatCost(cost) : "",
		});
	}

	/** グループ見出し行の 5h／7d の列 1 セル：そのカテゴリの合計（無ければ空欄。D-64）。 */
	private renderGroupCostCell(tr: HTMLTableRowElement, cls: string, window: "5h" | "7d", key: string): void {
		const entry = this.categoryTotalsByWindow[window].get(key);
		tr.createEl("td", {
			cls: `${cls} agent-sessions-manager-col-num`,
			text: entry && entry.cost > 0 ? formatCost(entry.cost) : "",
		});
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
			categoryColorIndex: (category) => this.plugin.index.categoryColorIndex(category),
		};
		renderDetail(this.detailEl, ctx);
	}
}
