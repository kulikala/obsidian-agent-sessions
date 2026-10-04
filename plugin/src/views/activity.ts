// The activity calendar: a week of sessions laid out as colored blocks, one lane per agent in each
// day column. The data is `json activity` (spans built from transcript timestamps); this file only
// fetches and draws, and everything it computes lives in `activity-model.ts`.

import { ItemView, Notice, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { activity } from "../backend/backend";
import { getLang, t } from "../i18n";
import { formatDateRange, formatTimeShort, formatWeekdayShort } from "../i18n/datetime";
import type AgentSessionsPlugin from "../main";
import { paletteHueDeg } from "../sessions/category";
import { AGENT_IDS } from "../settings";
import type { ActivityResult, ActivitySession } from "../types";
import {
	addDays,
	clockLabel,
	dayCounts,
	filterSessions,
	firstActiveSeconds,
	fitsLabel,
	layoutOverlaps,
	SECONDS_PER_DAY,
	splitSpansByDay,
	summarizeByAgent,
	weekDays,
	weekRange,
	weekStartOf,
	type DayPiece,
} from "./activity-model";
import { AGENT_NAME_KEY } from "./rows";

export const VIEW_TYPE_ACTIVITY = "agent-sessions-activity";

/** Height of one hour in the grid (also set as `--as-cal-hour` for the stylesheet). */
const HOUR_PX = 40;
/** Blocks shorter than this still get a visible sliver. */
const MIN_BLOCK_PX = 2;

export class ActivityView extends ItemView {
	private readonly plugin: AgentSessionsPlugin;
	private weekStart = weekStartOf(new Date());
	private result: ActivityResult | null = null;
	private filterText = "";
	private loading = false;
	private error: string | null = null;
	/** Bumped per fetch so a slow earlier response can't overwrite a newer week's. */
	private fetchToken = 0;
	private rangeEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private filterEl!: HTMLInputElement;

	constructor(leaf: WorkspaceLeaf, plugin: AgentSessionsPlugin) {
		super(leaf);
		this.plugin = plugin;
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
		void this.fetchWeek(true);
	}

	private refreshLanguage(): void {
		const leaf = this.leaf as unknown as { updateHeader?: () => void };
		leaf.updateHeader?.();
		this.contentEl.empty();
		this.buildSkeleton();
		this.renderBody();
	}

	private buildSkeleton(): void {
		const head = this.contentEl.createDiv({ cls: "agent-sessions-activity-head" });
		head.createEl("h2", { text: t("activity.title") });
		head.createEl("p", { cls: "agent-sessions-activity-subtitle", text: t("activity.subtitle") });

		const nav = head.createDiv({ cls: "agent-sessions-activity-nav" });
		this.navButton(nav, "chevron-left", t("activity.prevWeek"), () => this.go(addDays(this.weekStart, -7)));
		this.rangeEl = nav.createSpan({ cls: "agent-sessions-activity-range" });
		this.navButton(nav, "chevron-right", t("activity.nextWeek"), () => this.go(addDays(this.weekStart, 7)));
		const today = nav.createEl("button", { text: t("activity.thisWeek"), cls: "agent-sessions-activity-today" });
		this.registerDomEvent(today, "click", () => this.go(weekStartOf(new Date())));
		this.navButton(nav, "rotate-cw", t("activity.refresh"), () => void this.fetchWeek(false));
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
		this.renderRange();
	}

	private navButton(container: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLElement {
		const btn = container.createDiv({ cls: "agent-sessions-nav-btn clickable-icon" });
		setIcon(btn, icon);
		setTooltip(btn, tooltip);
		this.registerDomEvent(btn, "click", onClick);
		return btn;
	}

	private go(weekStart: Date): void {
		this.weekStart = weekStart;
		this.renderRange();
		void this.fetchWeek(true);
	}

	private renderRange(): void {
		const { from, to } = weekRange(this.weekStart);
		this.rangeEl.setText(formatDateRange(from, addDays(to, -1), getLang()));
	}

	private async fetchWeek(clear: boolean): Promise<void> {
		const token = ++this.fetchToken;
		this.loading = true;
		this.error = null;
		if (clear) {
			this.result = null;
		}
		this.renderBody();
		const { from, to } = weekRange(this.weekStart);
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
		this.loading = false;
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
		const days = weekDays(this.weekStart);

		this.renderCards(this.bodyEl, sessions, agents);
		if (this.result.sessions.length === 0) {
			this.bodyEl.createDiv({ cls: "agent-sessions-activity-message", text: t("activity.empty") });
			return;
		}

		const pieces = sessions.flatMap((s) => splitSpansByDay(s.spans, days).map((p) => ({ session: s, ...p })));
		const counts = dayCounts(sessions, days);
		const scroll = this.bodyEl.createDiv({ cls: "agent-sessions-activity-scroll" });
		scroll.style.setProperty("--as-cal-hour", `${HOUR_PX}px`);
		scroll.style.setProperty("--as-cal-lanes", String(agents.length));
		const grid = scroll.createDiv({ cls: "agent-sessions-activity-grid" });

		// Header row: a corner cell, then one cell per day with its per-agent counts and lane names.
		const header = grid.createDiv({ cls: "agent-sessions-activity-row agent-sessions-activity-header" });
		header.createDiv({ cls: "agent-sessions-activity-axis-cell" });
		const todayIdx = days.findIndex((d) => Date.now() / 1000 >= d.start && Date.now() / 1000 < d.end);
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
			const lanes = cell.createDiv({ cls: "agent-sessions-activity-lane-names" });
			for (const agent of agents) {
				const name = lanes.createDiv({ cls: `agent-sessions-activity-lane-name is-agent-${agent}` });
				name.createSpan({ cls: "agent-sessions-activity-lane-count", text: String(counts[i][agent] ?? 0) });
				name.createSpan({ text: this.agentName(agent) });
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
			for (const agent of agents) {
				const lane = col.createDiv({ cls: `agent-sessions-activity-lane is-agent-${agent}` });
				const mine = pieces.filter((p) => p.day === i && p.session.agent === agent);
				for (const l of layoutOverlaps(mine)) {
					this.renderBlock(lane, l.item.session, l.item, d.start, l.col, l.cols);
				}
			}
		});

		// Scrolling: to the first active hour of the (filtered) week when the data just changed,
		// otherwise where the user left it.
		scroll.scrollTop = scrollToFirst || !scrollEl
			? (firstActiveSeconds(pieces) / 3600) * HOUR_PX
			: keepTop;
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
		this.registerDomEvent(block, "click", () => {
			const row = this.plugin.index.sessions.get(session.id);
			void this.plugin.openSession(session.id, { agent: session.agent, cwd: row?.cwd });
		});
	}
}
