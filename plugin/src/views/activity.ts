// The activity calendar: a week of sessions laid out as colored blocks, one lane per agent in each
// day column. The data is `json activity` (spans built from transcript timestamps); this file only
// fetches and draws, and everything it computes lives in `activity-model.ts`.

import { ItemView, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { activity, stats, usage } from "../backend/backend";
import { getLang, t } from "../i18n";
import { formatDateRange, formatDateTimeShort, formatTimeShort, formatWeekdayShort } from "../i18n/datetime";
import type AgentSessionsPlugin from "../main";
import { paletteHueDeg } from "../sessions/category";
import { ACTIVITY_MODES, AGENT_IDS, type ActivityMode } from "../settings";
import type { ActivityResult, ActivitySession, StatsResult } from "../types";
import {
	canGoNext,
	clockLabel,
	dayCounts,
	filterSessions,
	firstActiveSeconds,
	fitsLabel,
	layoutOverlaps,
	periodContaining,
	periodDays,
	pickResetAnchor,
	SECONDS_PER_DAY,
	shiftPeriod,
	splitSpansByDay,
	summarizeByAgent,
	type DayPiece,
	type Period,
} from "./activity-model";
import { renderDetail } from "./detail-render";
import type { DetailContext } from "./detail";
import { AGENT_ICON, AGENT_NAME_KEY } from "./rows";
import { renderAgentMark } from "./rows-render";

export const VIEW_TYPE_ACTIVITY = "agent-sessions-activity";

/** Height of one hour in the grid (also set as `--as-cal-hour` for the stylesheet). */
const HOUR_PX = 40;
/** Blocks shorter than this still get a visible sliver. */
const MIN_BLOCK_PX = 2;

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
	private selectedId: string | null = null;
	/** Whether the user has picked a period (so the reset arriving late doesn't override it). */
	private navigated = false;
	private rangeEl!: HTMLElement;
	private nextBtn!: HTMLElement;
	private modeBtns = new Map<ActivityMode, HTMLElement>();
	private bodyEl!: HTMLElement;
	private detailEl!: HTMLElement;
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
		this.registerEvent(this.plugin.events.on("settings-changed", () => this.refreshLanguage()));
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

	private refreshLanguage(): void {
		const leaf = this.leaf as unknown as { updateHeader?: () => void };
		leaf.updateHeader?.();
		this.contentEl.empty();
		this.buildSkeleton();
		this.renderBody();
		void this.showDetail(this.selectedId);
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

		this.bodyEl = this.contentEl.createDiv({ cls: "agent-sessions-activity-body" });
		this.detailEl = this.contentEl.createDiv({ cls: "agent-sessions-activity-detail" });
		this.detailEl.hide();
		this.updateNav();
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

	private renderBody(scrollToFirst = false): void {
		const scrollEl = this.bodyEl.querySelector<HTMLElement>(".agent-sessions-activity-scroll");
		const keepTop = scrollEl?.scrollTop ?? 0;
		this.bodyEl.empty();
		if (this.error && !this.result) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.loadFailed", { message: this.error }) });
			return;
		}
		if (!this.result) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.loading") });
			return;
		}
		const sessions = filterSessions(this.result.sessions, this.filterText);
		const agents = this.laneAgents(this.result.sessions);
		const days = periodDays(this.period);

		this.renderCards(this.bodyEl, sessions, agents);
		if (this.result.sessions.length === 0) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.empty") });
			return;
		}

		const pieces = sessions.flatMap((s) => splitSpansByDay(s.spans, days).map((p) => ({ session: s, ...p })));
		const counts = dayCounts(sessions, days);
		const scroll = this.bodyEl.createDiv({ cls: "agent-sessions-activity-scroll" });
		scroll.style.setProperty("--as-cal-hour", `${HOUR_PX}px`);
		scroll.style.setProperty("--as-cal-days", String(days.length));
		const grid = scroll.createDiv({ cls: "agent-sessions-activity-grid" });
		grid.toggleClass("is-single-day", days.length === 1);

		// Header row: a corner cell, then one cell per day with its per-agent counts and lane names.
		const header = grid.createDiv({ cls: "agent-sessions-activity-row agent-sessions-activity-header" });
		header.createDiv({ cls: "agent-sessions-activity-axis-cell" });
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

		// Body row: the hour axis, then each day's lanes.
		const body = grid.createDiv({ cls: "agent-sessions-activity-row agent-sessions-activity-main" });
		const axis = body.createDiv({ cls: "agent-sessions-activity-axis" });
		for (let h = 0; h < 24; h += 2) {
			const tick = axis.createDiv({ cls: "agent-sessions-activity-tick", text: clockLabel(h * 3600) });
			tick.style.top = `${(h / 24) * 100}%`;
		}
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
				for (const l of layoutOverlaps(mine)) {
					this.renderBlock(lane, l.item.session, l.item, d.start, l.col, l.cols);
				}
			}
		});

		// Scrolling: to the first active hour of the (filtered) period when the data just changed,
		// otherwise where the user left it.
		scroll.scrollTop = scrollToFirst || !scrollEl ? (firstActiveSeconds(pieces) / 3600) * HOUR_PX : keepTop;
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

	private renderBlock(
		lane: HTMLElement,
		session: ActivitySession,
		piece: DayPiece,
		dayStart: number,
		col: number,
		cols: number
	): void {
		const block = lane.createDiv({ cls: "agent-sessions-activity-block" });
		block.style.top = `${(piece.start / SECONDS_PER_DAY) * 100}%`;
		block.style.height = `max(${MIN_BLOCK_PX}px, ${((piece.end - piece.start) / SECONDS_PER_DAY) * 100}%)`;
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
		setTooltip(
			block,
			t("activity.blockTooltip", {
				from: formatTimeShort(dayStart + piece.start, getLang()),
				to: formatTimeShort(dayStart + piece.end, getLang()),
				name,
			})
		);
		block.toggleClass("is-selected", session.id === this.selectedId);
		block.dataset.sessionId = session.id;
		this.registerDomEvent(block, "click", () => {
			this.selectedId = session.id;
			this.bodyEl.querySelectorAll(".agent-sessions-activity-block.is-selected").forEach((el) => el.removeClass("is-selected"));
			this.bodyEl.querySelectorAll<HTMLElement>(".agent-sessions-activity-block").forEach((el) => {
				el.toggleClass("is-selected", el.dataset.sessionId === session.id);
			});
			void this.showDetail(session.id);
		});
	}

	/** The detail pane under the grid: the same detail the side panel and the manager show, plus "Open session" and close. */
	private async showDetail(id: string | null): Promise<void> {
		this.detailEl.empty();
		if (!id) {
			this.detailEl.hide();
			return;
		}
		this.detailEl.show();
		const bar = this.detailEl.createDiv({ cls: "agent-sessions-activity-detail-bar" });
		const open = bar.createEl("button", { text: t("activity.openSession") });
		const close = bar.createEl("button", { text: t("activity.closeDetail") });
		const content = this.detailEl.createDiv();
		const row = this.plugin.index.sessions.get(id);
		const summary = this.result?.sessions.find((s) => s.id === id);
		this.registerDomEvent(open, "click", () => {
			void this.plugin.openSession(id, { agent: row?.agent ?? summary?.agent, cwd: row?.cwd });
		});
		this.registerDomEvent(close, "click", () => {
			this.selectedId = null;
			this.bodyEl.querySelectorAll(".agent-sessions-activity-block.is-selected").forEach((el) => el.removeClass("is-selected"));
			void this.showDetail(null);
		});
		if (!row) {
			renderDetail(content, null);
			return;
		}
		let detail = null;
		try {
			detail = await this.plugin.index.getDetail(id);
		} catch {
			detail = null;
		}
		if (this.selectedId !== id) {
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
		renderDetail(content, ctx);
	}
}
