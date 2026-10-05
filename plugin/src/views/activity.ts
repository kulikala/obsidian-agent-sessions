// The activity calendar: sessions' working time laid out as colored blocks. Week and session
// periods have one lane per agent in each day column; day mode has one column per session. A
// click on a block opens a details panel on the right (the block's turns above, the session's
// own details below). The data is `json activity`; this file only fetches and draws, and
// everything it computes lives in `activity-model.ts`.

import { ItemView, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { activity, stats, usage } from "../backend/backend";
import { getLang, t } from "../i18n";
import { formatDateRange, formatDateTimeShort, formatTimeShort, formatWeekdayShort } from "../i18n/datetime";
import type AgentSessionsPlugin from "../main";
import { paletteHueDeg } from "../sessions/category";
import { renderCategoryChip } from "../ui/chip";
import { ACTIVITY_MODES, AGENT_IDS, type ActivityMode } from "../settings";
import type { ActivityResult, ActivitySession, ActivitySpan, ActivityTurn, StatsResult } from "../types";
import {
	canGoNext,
	clockLabel,
	dayColumns,
	dayCounts,
	expandForMinHeight,
	filterSessions,
	firstActiveSeconds,
	fitsLabel,
	layoutOverlaps,
	minBlockSeconds,
	periodContaining,
	periodDays,
	pickResetAnchor,
	SECONDS_PER_DAY,
	shiftPeriod,
	splitDuration,
	splitSpansByDay,
	summarizeByAgent,
	toggleAgent,
	visibleAgents,
	type DayPiece,
	type DayRange,
	type Period,
} from "./activity-model";
import { renderDetail } from "./detail-render";
import type { DetailContext } from "./detail";
import { AGENT_ICON, AGENT_NAME_KEY } from "./rows";
import { renderAgentMark } from "./rows-render";

export const VIEW_TYPE_ACTIVITY = "agent-sessions-activity";

/** Height of one hour in the grid (also set as `--as-cal-hour` for the stylesheet). */
const HOUR_PX = 40;
/** Every block is drawn at least this tall (and at least 10 minutes, see `minBlockSeconds`). */
const MIN_BLOCK_PX = 6;
/** The details panel's width limits, as a % of the view. */
const MIN_DETAIL_PERCENT = 20;
const MAX_DETAIL_PERCENT = 70;

/** A piece being drawn: its true end is kept, `end` may be extended to the minimum block height. */
type DrawPiece = DayPiece<ActivitySpan> & { trueEnd: number };

/** The block shown in the details panel. */
interface SelectedBlock {
	sessionId: string;
	span: ActivitySpan;
}

export class ActivityView extends ItemView {
	private readonly plugin: AgentSessionsPlugin;
	private mode: ActivityMode;
	/** A reset of the usage limit's 7-day window (epoch seconds), when known: what "session" periods align to. */
	private resetAnchor: number | null = null;
	private period: Period;
	private result: ActivityResult | null = null;
	private filterText = "";
	private error: string | null = null;
	/** Bumped per fetch so a slow earlier response can't overwrite a newer period's. */
	private fetchToken = 0;
	private selected: SelectedBlock | null = null;
	private lastLang = getLang();
	/** Whether the user has picked a period (so the reset arriving late doesn't override it). */
	private navigated = false;
	private rangeEl!: HTMLElement;
	private nextBtn!: HTMLElement;
	private modeBtns = new Map<ActivityMode, HTMLElement>();
	private bodyEl!: HTMLElement;
	private splitEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private blockDetailEl!: HTMLElement;
	private sessionDetailEl!: HTMLElement;
	private agentsEl!: HTMLElement;
	private filterEl!: HTMLInputElement;

	constructor(leaf: WorkspaceLeaf, plugin: AgentSessionsPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.mode = plugin.settings.activityMode;
		this.period = periodContaining(this.mode, new Date(), null);
	}

	getViewType(): string {
		return VIEW_TYPE_ACTIVITY;
	}

	getDisplayText(): string {
		return t("activity.title");
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-activity");
		this.buildSkeleton();
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.onSettingsChanged()));
		await this.loadAnchor();
		// Realign to the reset once known, unless the user already moved somewhere.
		if (!this.navigated) {
			this.period = periodContaining(this.mode, new Date(), this.resetAnchor);
			this.updateNav();
			void this.fetchPeriod(true);
		}
	}

	/** The reset to align "session" periods to, from `json stats` (Claude's 7-day window, else Codex's). */
	private async loadAnchor(): Promise<void> {
		let result: StatsResult | null = null;
		try {
			result = await stats(this.plugin.agentSessionsPath(), this.plugin.vaultPath());
		} catch {
			result = null;
		}
		const enabled = AGENT_IDS.filter((id) => this.plugin.settings.agents[id].enabled);
		this.resetAnchor = pickResetAnchor(result, enabled);
	}

	/** A language change rebuilds everything; any other change (including this view's own saves) just redraws the body. */
	private onSettingsChanged(): void {
		if (getLang() !== this.lastLang) {
			this.lastLang = getLang();
			const leaf = this.leaf as unknown as { updateHeader?: () => void };
			leaf.updateHeader?.();
			this.contentEl.empty();
			this.buildSkeleton();
		}
		this.renderBody();
	}

	private buildSkeleton(): void {
		const head = this.contentEl.createDiv({ cls: "agent-sessions-activity-head" });
		head.createEl("h2", { text: t("activity.title") });
		head.createEl("p", { cls: "agent-sessions-activity-subtitle", text: t("activity.subtitle") });

		const nav = head.createDiv({ cls: "agent-sessions-activity-nav" });
		const modes = nav.createDiv({ cls: "agent-sessions-activity-modes" });
		this.modeBtns.clear();
		for (const mode of ACTIVITY_MODES) {
			const btn = modes.createEl("button", { text: t(`activity.mode.${mode}`), cls: "agent-sessions-activity-mode" });
			setTooltip(btn, t(`activity.mode.${mode}.hint`));
			this.registerDomEvent(btn, "click", () => this.setMode(mode, this.period.from));
			this.modeBtns.set(mode, btn);
		}
		this.navButton(nav, "chevron-left", t("activity.prev"), () => this.go(shiftPeriod(this.period, -1)));
		this.rangeEl = nav.createSpan({ cls: "agent-sessions-activity-range" });
		this.nextBtn = this.navButton(nav, "chevron-right", t("activity.next"), () => {
			if (canGoNext(this.period, new Date())) {
				this.go(shiftPeriod(this.period, 1));
			}
		});
		const latest = nav.createEl("button", { text: t("activity.latest"), cls: "agent-sessions-activity-today" });
		this.registerDomEvent(latest, "click", () => this.go(periodContaining(this.mode, new Date(), this.resetAnchor)));
		this.navButton(nav, "rotate-cw", t("activity.refresh"), () => void this.fetchPeriod(false));
		this.filterEl = nav.createEl("input", {
			type: "text",
			placeholder: t("activity.filterPlaceholder"),
			cls: "agent-sessions-activity-filter",
		});
		this.filterEl.value = this.filterText;
		this.registerDomEvent(this.filterEl, "input", () => {
			this.filterText = this.filterEl.value;
			this.renderBody(true);
		});

		this.agentsEl = head.createDiv({ cls: "agent-sessions-activity-agents" });

		this.splitEl = this.contentEl.createDiv({ cls: "agent-sessions-activity-split" });
		this.bodyEl = this.splitEl.createDiv({ cls: "agent-sessions-activity-body" });
		const divider = this.splitEl.createDiv({ cls: "agent-sessions-activity-divider" });
		this.bindDivider(divider);
		this.detailEl = this.splitEl.createDiv({ cls: "agent-sessions-activity-detail" });
		this.applyDetailWidth(this.plugin.settings.activityDetailWidth);
		this.updateNav();
		void this.showDetail();
	}

	private applyDetailWidth(percent: number): void {
		this.splitEl.style.setProperty("--as-detail-w", `${percent}%`);
	}

	/** The draggable divider between the calendar and the details panel; the width is saved on release. */
	private bindDivider(divider: HTMLElement): void {
		this.registerDomEvent(divider, "pointerdown", (evt) => {
			evt.preventDefault();
			const total = this.splitEl.getBoundingClientRect();
			let percent = this.plugin.settings.activityDetailWidth;
			const move = (e: PointerEvent) => {
				percent = Math.min(
					MAX_DETAIL_PERCENT,
					Math.max(MIN_DETAIL_PERCENT, ((total.right - e.clientX) / total.width) * 100)
				);
				this.applyDetailWidth(percent);
			};
			const up = () => {
				document.removeEventListener("pointermove", move);
				document.removeEventListener("pointerup", up);
				this.plugin.settings.activityDetailWidth = Math.round(percent);
				void this.plugin.saveSettings();
			};
			document.addEventListener("pointermove", move);
			document.addEventListener("pointerup", up);
		});
	}

	private navButton(container: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLElement {
		const btn = container.createDiv({ cls: "agent-sessions-nav-btn clickable-icon" });
		setIcon(btn, icon);
		setTooltip(btn, tooltip);
		this.registerDomEvent(btn, "click", onClick);
		return btn;
	}

	/** The range text, the active mode button, and whether "next" is allowed. */
	private updateNav(): void {
		const { from, to } = this.period;
		const lang = getLang();
		if (this.period.mode === "session") {
			this.rangeEl.setText(`${formatDateTimeShort(from.getTime() / 1000, lang)} – ${formatDateTimeShort(to.getTime() / 1000, lang)}`);
		} else if (this.period.mode === "day") {
			this.rangeEl.setText(`${formatDateRange(from, from, lang)} ${formatWeekdayShort(from, lang)}`);
		} else {
			this.rangeEl.setText(formatDateRange(from, new Date(to.getTime() - 1), lang));
		}
		for (const [mode, btn] of this.modeBtns) {
			btn.toggleClass("is-active", mode === this.mode);
		}
		this.nextBtn.toggleClass("is-disabled", !canGoNext(this.period, new Date()));
	}

	private go(period: Period): void {
		this.navigated = true;
		this.period = period;
		this.updateNav();
		void this.fetchPeriod(true);
	}

	/** Switches the mode to the period of that mode containing `at` (never later than now), and remembers it. */
	private setMode(mode: ActivityMode, at: Date): void {
		this.mode = mode;
		this.plugin.settings.activityMode = mode;
		void this.plugin.saveSettings();
		const now = new Date();
		this.go(periodContaining(mode, at.getTime() > now.getTime() ? now : at, this.resetAnchor));
	}

	private async fetchPeriod(clear: boolean): Promise<void> {
		const token = ++this.fetchToken;
		this.error = null;
		if (clear) {
			this.result = null;
		}
		this.renderBody();
		const { from, to } = this.period;
		try {
			const result = await activity(this.plugin.agentSessionsPath(), this.plugin.vaultPath(), from, to);
			if (token !== this.fetchToken) {
				return;
			}
			this.result = result;
		} catch (err) {
			if (token !== this.fetchToken) {
				return;
			}
			this.result = null;
			this.error = err instanceof Error ? err.message : String(err);
			new Notice(t("activity.loadFailed", { message: this.error }));
		}
		this.renderBody(true);
	}

	/** The agents that get a lane: every enabled one, plus any other that has activity in the data. */
	private laneAgents(sessions: readonly ActivitySession[]): string[] {
		const enabled = AGENT_IDS.filter((id) => this.plugin.settings.agents[id].enabled) as string[];
		const extra = [...new Set(sessions.map((s) => s.agent))].filter((a) => !enabled.includes(a));
		return [...enabled, ...extra];
	}

	private agentName(agent: string): string {
		const key = AGENT_NAME_KEY[agent];
		return key ? t(key) : agent;
	}

	/** The per-agent toggles under the controls: icon and name, dimmed when hidden; one always stays on. */
	private renderAgentToggles(all: readonly string[], hidden: readonly string[]): void {
		this.agentsEl.empty();
		for (const agent of all) {
			const off = hidden.includes(agent);
			const btn = this.agentsEl.createEl("button", { cls: `agent-sessions-activity-agent is-agent-${agent}` });
			btn.toggleClass("is-off", off);
			btn.setAttr("aria-pressed", String(!off));
			if (AGENT_ICON[agent]) {
				const icon = btn.createSpan({ cls: "agent-sessions-row-agent-mark" });
				setIcon(icon, AGENT_ICON[agent]);
			}
			btn.createSpan({ text: this.agentName(agent) });
			this.registerDomEvent(btn, "click", () => {
				const next = toggleAgent(this.plugin.settings.activityHiddenAgents, agent, all);
				this.plugin.settings.activityHiddenAgents = next;
				void this.plugin.saveSettings();
			});
		}
	}

	private renderBody(scrollToFirst = false): void {
		const scrollEl = this.bodyEl.querySelector<HTMLElement>(".agent-sessions-activity-scroll");
		const keepTop = scrollEl?.scrollTop ?? 0;
		const keepLeft = scrollEl?.scrollLeft ?? 0;
		this.bodyEl.empty();
		if (this.error && !this.result) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.loadFailed", { message: this.error }) });
			return;
		}
		if (!this.result) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.loading") });
			return;
		}
		const all = this.laneAgents(this.result.sessions);
		const hidden = this.plugin.settings.activityHiddenAgents;
		this.renderAgentToggles(all, hidden);
		const agents = visibleAgents(all, hidden);
		const sessions = filterSessions(this.result.sessions, this.filterText).filter((s) => agents.includes(s.agent));
		const days = periodDays(this.period);

		this.renderCards(this.bodyEl, sessions, agents);
		if (this.result.sessions.length === 0) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.empty") });
			return;
		}

		const dayMode = this.period.mode === "day";
		const columns = dayMode ? dayColumns(sessions, agents, days) : [];
		const scroll = this.bodyEl.createDiv({ cls: "agent-sessions-activity-scroll" });
		scroll.style.setProperty("--as-cal-hour", `${HOUR_PX}px`);
		const columnCount = dayMode ? Math.max(1, columns.length) : days.length;
		scroll.style.setProperty("--as-cal-days", String(columnCount));
		const grid = scroll.createDiv({ cls: "agent-sessions-activity-grid" });
		grid.toggleClass("is-day-mode", dayMode);
		if (dayMode) {
			grid.style.minWidth = `calc(3.4em + ${columnCount} * 9em)`;
		}

		const header = grid.createDiv({ cls: "agent-sessions-activity-row agent-sessions-activity-header" });
		header.createDiv({ cls: "agent-sessions-activity-axis-cell" });
		const body = grid.createDiv({ cls: "agent-sessions-activity-row agent-sessions-activity-main" });
		const axis = body.createDiv({ cls: "agent-sessions-activity-axis" });
		for (let h = 0; h < 24; h += 2) {
			const tick = axis.createDiv({ cls: "agent-sessions-activity-tick", text: clockLabel(h * 3600) });
			tick.style.top = `${(h / 24) * 100}%`;
		}

		const minSeconds = minBlockSeconds(HOUR_PX, MIN_BLOCK_PX);
		const drawn: DrawPiece[] = [];
		if (dayMode) {
			this.renderSessionColumns(header, body, columns, days[0], minSeconds, drawn);
		} else {
			this.renderDayColumns(header, body, sessions, agents, days, minSeconds, drawn);
		}

		// Scrolling: to the first active hour of the (filtered) period when the data just changed,
		// otherwise where the user left it.
		if (scrollToFirst || !scrollEl) {
			scroll.scrollTop = (firstActiveSeconds(drawn) / 3600) * HOUR_PX;
		} else {
			scroll.scrollTop = keepTop;
			scroll.scrollLeft = keepLeft;
		}
	}

	/** Week and session periods: a column per day, a lane per agent in it. */
	private renderDayColumns(
		header: HTMLElement,
		body: HTMLElement,
		sessions: readonly ActivitySession[],
		agents: readonly string[],
		days: readonly DayRange[],
		minSeconds: number,
		drawn: DrawPiece[]
	): void {
		const pieces = sessions.flatMap((s) => splitSpansByDay(s.spans, days).map((p) => ({ session: s, ...p })));
		const counts = dayCounts(sessions, days);
		const nowSec = Date.now() / 1000;
		const todayIdx = days.findIndex((d) => nowSec >= d.start && nowSec < d.end);
		days.forEach((d, i) => {
			const cell = header.createDiv({ cls: "agent-sessions-activity-day-head" });
			if (i === todayIdx) {
				cell.addClass("is-today");
			}
			const wd = d.date.getDay();
			const title = cell.createDiv({ cls: "agent-sessions-activity-day-title" });
			title.createSpan({ text: `${d.date.getMonth() + 1}/${d.date.getDate()} ` });
			title.createSpan({
				cls: wd === 0 ? "is-sunday" : wd === 6 ? "is-saturday" : "",
				text: formatWeekdayShort(d.date, getLang()),
			});
			// Clicking the date opens that day on its own (not for a day that hasn't started).
			if (this.period.mode !== "day" && d.start <= nowSec) {
				title.addClass("is-link");
				setTooltip(title, t("activity.showDay"));
				this.registerDomEvent(title, "click", () => this.setMode("day", d.date));
			}
			const lanes = cell.createDiv({ cls: "agent-sessions-activity-lane-names" });
			for (const agent of agents) {
				const name = lanes.createDiv({ cls: `agent-sessions-activity-lane-name is-agent-${agent}` });
				// The agent's icon and the day's count; the name is the icon's tooltip (it never fits a narrow lane).
				if (AGENT_ICON[agent]) {
					renderAgentMark(name, agent);
				} else {
					name.createSpan({ cls: "agent-sessions-activity-lane-fallback", text: this.agentName(agent) });
				}
				name.createSpan({ cls: "agent-sessions-activity-lane-count", text: String(counts[i][agent] ?? 0) });
			}
		});

		days.forEach((d, i) => {
			const col = body.createDiv({ cls: "agent-sessions-activity-day" });
			if (i === todayIdx) {
				col.addClass("is-today");
			}
			// The part of a day outside the period (a "session" period starts and ends mid-day) is dimmed.
			const dayLength = d.end - d.start;
			if (d.activeFrom > 0) {
				this.renderOutside(col, 0, d.activeFrom / SECONDS_PER_DAY);
			}
			if (d.activeTo < dayLength) {
				this.renderOutside(col, d.activeTo / SECONDS_PER_DAY, 1);
			}
			for (const agent of agents) {
				const lane = col.createDiv({ cls: `agent-sessions-activity-lane is-agent-${agent}` });
				const mine = pieces.filter((p) => p.day === i && p.session.agent === agent);
				this.renderLane(lane, mine, d.start, minSeconds, drawn);
			}
		});
	}

	/** Day mode: a column per session active that day, grouped by agent. */
	private renderSessionColumns(
		header: HTMLElement,
		body: HTMLElement,
		columns: ReturnType<typeof dayColumns>,
		day: DayRange,
		minSeconds: number,
		drawn: DrawPiece[]
	): void {
		if (columns.length === 0) {
			header.createDiv({ cls: "agent-sessions-activity-day-head" });
			body.createDiv({ cls: "agent-sessions-activity-day" });
			return;
		}
		for (const column of columns) {
			const { session } = column;
			const name = session.name || session.label || t("activity.untitled");
			const cell = header.createDiv({ cls: `agent-sessions-activity-day-head agent-sessions-activity-session-head is-agent-${session.agent}` });
			if (AGENT_ICON[session.agent]) {
				renderAgentMark(cell, session.agent);
			}
			cell.createSpan({ cls: "agent-sessions-activity-session-name", text: session.label || name });
			setTooltip(cell, name);
			const col = body.createDiv({ cls: "agent-sessions-activity-day" });
			const lane = col.createDiv({ cls: `agent-sessions-activity-lane is-agent-${session.agent}` });
			this.renderLane(lane, column.pieces.map((p) => ({ session, ...p })), day.start, minSeconds, drawn);
		}
	}

	/** One lane's blocks: every block at least `minSeconds` tall, overlapping ones side by side. */
	private renderLane(
		lane: HTMLElement,
		pieces: readonly (DayPiece<ActivitySpan> & { session: ActivitySession })[],
		dayStart: number,
		minSeconds: number,
		drawn: DrawPiece[]
	): void {
		const withTrue = pieces.map((p) => ({ ...p, trueEnd: p.end }));
		for (const l of layoutOverlaps(expandForMinHeight(withTrue, minSeconds))) {
			drawn.push(l.item);
			this.renderBlock(lane, l.item.session, l.item, dayStart, l.col, l.cols);
		}
	}

	private renderOutside(col: HTMLElement, from: number, to: number): void {
		const el = col.createDiv({ cls: "agent-sessions-activity-outside" });
		el.style.top = `${from * 100}%`;
		el.style.height = `${(to - from) * 100}%`;
	}

	private renderCards(container: HTMLElement, sessions: readonly ActivitySession[], agents: readonly string[]): void {
		const cards = container.createDiv({ cls: "agent-sessions-activity-cards" });
		for (const s of summarizeByAgent(sessions, agents)) {
			const card = cards.createDiv({ cls: `agent-sessions-activity-card is-agent-${s.agent}` });
			const title = card.createDiv({ cls: "agent-sessions-activity-card-title" });
			title.createSpan({ cls: "agent-sessions-activity-swatch" });
			title.createSpan({ text: this.agentName(s.agent) });
			card.createDiv({ cls: "agent-sessions-activity-card-hours", text: t("activity.hours", { n: s.hours.toFixed(1) }) });
			card.createDiv({
				cls: "agent-sessions-activity-card-stats",
				text: t("activity.cardStats", { sessions: s.sessions, max: s.maxConcurrent }),
			});
		}
	}

	private isSelected(session: ActivitySession, span: ActivitySpan): boolean {
		return this.selected?.sessionId === session.id && this.selected.span.start === span.start;
	}

	private renderBlock(
		lane: HTMLElement,
		session: ActivitySession,
		piece: DrawPiece,
		dayStart: number,
		col: number,
		cols: number
	): void {
		const block = lane.createDiv({ cls: "agent-sessions-activity-block" });
		block.style.top = `${(piece.start / SECONDS_PER_DAY) * 100}%`;
		block.style.height = `${((piece.end - piece.start) / SECONDS_PER_DAY) * 100}%`;
		block.style.left = `${(col / cols) * 100}%`;
		block.style.width = `${100 / cols}%`;
		if (session.category) {
			block.addClass("has-category");
			block.style.setProperty("--as-chip-hue", String(paletteHueDeg(this.plugin.index.categoryColorIndex(session.category))));
		}
		const name = session.name || session.label || t("activity.untitled");
		if (cols <= 3 && fitsLabel(piece.end - piece.start, HOUR_PX)) {
			block.createSpan({ cls: "agent-sessions-activity-block-label", text: session.label || name });
		}
		// The tooltip carries the true times, not the drawn (minimum-height) ones.
		setTooltip(
			block,
			t("activity.blockTooltip", {
				from: formatTimeShort(dayStart + piece.start, getLang()),
				to: formatTimeShort(dayStart + piece.trueEnd, getLang()),
				name,
			})
		);
		block.toggleClass("is-selected", this.isSelected(session, piece.span));
		block.dataset.sessionId = session.id;
		block.dataset.spanStart = String(piece.span.start);
		this.registerDomEvent(block, "click", () => {
			this.selected = { sessionId: session.id, span: piece.span };
			this.bodyEl.querySelectorAll<HTMLElement>(".agent-sessions-activity-block").forEach((el) => {
				el.toggleClass("is-selected", el.dataset.sessionId === session.id && el.dataset.spanStart === String(piece.span.start));
			});
			void this.showDetail();
		});
	}

	/** "1 h 05 min" / "12 min" / "< 1 min". */
	private durationText(seconds: number): string {
		const { h, m } = splitDuration(seconds);
		if (h === 0 && m === 0) {
			return t("activity.dur.lt1");
		}
		return h === 0 ? t("activity.dur.m", { m }) : t("activity.dur.hm", { h, m: String(m).padStart(2, "0") });
	}

	private rangeText(start: number, end: number): string {
		return `${formatDateTimeShort(start, getLang())} – ${formatTimeShort(end, getLang())}`;
	}

	/**
	 * The details panel on the right: the block (its session, times, and every turn with its
	 * prompt) above, the session's own details (what the side panel shows) below. Closed (the
	 * calendar takes the full width) when nothing is selected.
	 */
	private async showDetail(): Promise<void> {
		const selected = this.selected;
		this.detailEl.empty();
		this.splitEl.toggleClass("has-detail", selected !== null);
		if (!selected) {
			return;
		}
		const id = selected.sessionId;
		const summary = this.result?.sessions.find((s) => s.id === id);
		const row = this.plugin.index.sessions.get(id);
		const bar = this.detailEl.createDiv({ cls: "agent-sessions-activity-detail-bar" });
		const open = bar.createEl("button", { text: t("activity.openSession") });
		const close = bar.createEl("button", { text: t("activity.closeDetail") });
		this.registerDomEvent(open, "click", () => {
			void this.plugin.openSession(id, { agent: row?.agent ?? summary?.agent, cwd: row?.cwd });
		});
		this.registerDomEvent(close, "click", () => {
			this.selected = null;
			this.bodyEl.querySelectorAll(".agent-sessions-activity-block.is-selected").forEach((el) => el.removeClass("is-selected"));
			void this.showDetail();
		});

		this.blockDetailEl = this.detailEl.createDiv({ cls: "agent-sessions-activity-block-detail" });
		this.renderBlockDetail(this.blockDetailEl, summary, selected.span);
		this.sessionDetailEl = this.detailEl.createDiv({ cls: "agent-sessions-activity-session-detail" });
		if (!row) {
			renderDetail(this.sessionDetailEl, null);
			return;
		}
		let detail = null;
		try {
			detail = await this.plugin.index.getDetail(id);
		} catch {
			detail = null;
		}
		if (this.selected?.sessionId !== id) {
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
		renderDetail(this.sessionDetailEl, ctx);
	}

	private renderBlockDetail(container: HTMLElement, session: ActivitySession | undefined, span: ActivitySpan): void {
		const head = container.createDiv({ cls: "agent-sessions-activity-bd-head" });
		if (session) {
			if (AGENT_ICON[session.agent]) {
				renderAgentMark(head, session.agent);
			}
			if (session.category) {
				renderCategoryChip(head, session.category, this.plugin.index.categoryColorIndex(session.category));
			}
			head.createSpan({
				cls: "agent-sessions-activity-bd-name",
				text: session.label || session.name || t("activity.untitled"),
			});
		}
		container.createDiv({
			cls: "agent-sessions-activity-bd-times",
			text: `${this.rangeText(span.start, span.end)} (${this.durationText(span.end - span.start)})`,
		});
		const list = container.createDiv({ cls: "agent-sessions-activity-turns" });
		for (const turn of span.turns) {
			this.renderTurn(list, turn);
		}
	}

	private renderTurn(list: HTMLElement, turn: ActivityTurn): void {
		const item = list.createDiv({ cls: `agent-sessions-activity-turn is-${turn.kind}` });
		const meta = item.createDiv({ cls: "agent-sessions-activity-turn-meta" });
		meta.createSpan({ text: `${formatTimeShort(turn.start, getLang())} – ${formatTimeShort(turn.end, getLang())}` });
		meta.createSpan({ cls: "agent-sessions-activity-turn-dur", text: this.durationText(turn.end - turn.start) });
		if (turn.kind !== "prompt") {
			meta.createSpan({ cls: "agent-sessions-activity-turn-kind", text: t(`activity.kind.${turn.kind}`) });
		}
		if (turn.prompt) {
			item.createDiv({ cls: "agent-sessions-activity-turn-prompt", text: turn.prompt });
		}
	}
}
