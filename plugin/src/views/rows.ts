// Row rendering, selection, and the row menu — shared by the side panel and the manager. The detail pane is views/detail.ts.

import { renderCategoryChip } from "../ui/chip";
import { AGENT_ICON_ID } from "../ui/icons";
import type { Row } from "../sessions/index";
import { t, type MessageKey } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { categorizableLabel, sessionDisplayName } from "../sessions/name";
import {
	resolveRowStatus,
	STATUS_GROUP_ICON,
	statusTooltip,
	terminalStatusClass,
	TERMINAL_STATUS_ICON,
} from "../sessions/terminal-status";
import { splitName } from "../sessions/tree";

export interface RowActions {
	openSession(id: string): void;
	rename(id: string, currentName: string): void;
	moveToCategory(row: Row): void;
	compact(id: string): void;
	toggleArchive(row: Row): void;
	endSession(id: string): void;
	copyId(id: string): void;
	/** Called after a 300ms hover. */
	showDetail(id: string): void;
	/**
	 * Called when the pointer leaves the list entirely (T-110) — the caller (`SideView`) wires
	 * this to its list container's own `pointerleave`, not to any individual row's, so moving the
	 * pointer directly from one row to another never triggers it. Not called by this file at all;
	 * kept on `RowActions` (rather than as a separate side-panel-only callback) so it lives next
	 * to `cancelHideDetail`, its counterpart.
	 */
	hideDetail?(): void;
	/**
	 * Called immediately on entering any row (T-110), before that row's own 300ms hover-confirm
	 * timer starts — lets the caller cancel a pending, delayed `hideDetail` (if it debounces one)
	 * so a leave/enter landing right on the list/row boundary still can't flash to the default
	 * detail in between.
	 */
	cancelHideDetail?(): void;
	/** Opens the session-analytics modal. */
	showUsage(id: string): void;
	/**
	 * The most recent slash command (`json detail`'s `last_command`, e.g. `/compact`; excludes
	 * arguments). Returns synchronously if already fetched — doesn't call `json detail` itself
	 * (`index.getCachedDetail`). `undefined` if not fetched yet (doesn't disable "compact session" in that case).
	 */
	lastUserPrompt?(id: string): string | undefined;
}

export interface RenderRowOptions {
	/** Highlights the row for the frontmost terminal tab (the side panel's "open tabs"). */
	front?: boolean;
	/** Indents this row like a manager child row. */
	indent?: boolean;
	selection: RowSelection;
	actions: RowActions;
	/** The status marker (`rowStatusMark`) uses this to read `terminalStatuses`. */
	plugin: AgentSessionsPlugin;
}

const HOVER_DELAY_MS = 300;

/**
 * A cancelable, delayed callback (T-110) — `schedule()` (re)starts the delay from scratch,
 * `cancel()` stops it without calling anything. Used for the side panel's "revert to the default
 * detail" trigger (`SideView.onHoverEnd`/`cancelPendingHoverHide`): the delay absorbs a pointer
 * leave/enter landing right on the boundary between the list and a row just inside it — `cancel()`
 * is called from a row's own `pointerenter` (`RowActions.cancelHideDetail`). Kept as its own plain
 * class, with nothing but a `setTimeout`, so it's directly testable with fake timers — unlike
 * `SideView` itself, which imports `obsidian` eagerly.
 */
export class DelayedRevert {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly ms: number,
		private readonly run: () => void
	) {}

	/** (Re)starts the delay — cancels any timer already pending first. */
	schedule(): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = null;
			this.run();
		}, this.ms);
	}

	/** Stops a pending delay without calling `run`. A no-op if nothing is pending. */
	cancel(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Whether a timer is currently pending (for tests). */
	get pending(): boolean {
		return this.timer !== null;
	}
}

/**
 * The side panel's frontmost-tab id, re-derived every time this is called (T-112 follow-up) —
 * never a cached snapshot. `activeSessionId` is expected to be the active leaf's own live
 * `TerminalView.sessionId` getter (`null` when the active leaf isn't one of this plugin's own
 * terminal tabs) — reading that fresh on every call is what actually matters here: a *cached*
 * id (taken once, back when a tab first became the active leaf) goes stale the moment `relinkId`
 * swaps it (a Codex tab's daemon-tracked placeholder id to its real, resolved thread id) while
 * that tab stays in front the whole time, since no new `active-leaf-change` event fires to catch
 * it — `sessionId` itself doesn't have this problem (it's a plain getter over the view's current
 * `id` field), so calling this again with the *same* leaf's view, after its `sessionId` has since
 * changed, correctly picks up the new value. Falls back to `previousFrontId` unchanged when
 * there's no active terminal tab right now (e.g. the user clicked into a note) — the side panel
 * keeps highlighting the last real frontmost terminal tab rather than losing track of it.
 */
export function nextFrontId(previousFrontId: string | null, activeSessionId: string | null): string | null {
	return activeSessionId ?? previousFrontId;
}

/** Holds at most one selected row (highlighting only — `⋯` is always shown, independent of selection). */
export class RowSelection {
	private current: HTMLElement | null = null;

	select(el: HTMLElement, _menuBtn?: HTMLElement): void {
		this.clear();
		el.addClass("is-selected");
		this.current = el;
	}

	clear(): void {
		if (this.current) {
			this.current.removeClass("is-selected");
			this.current = null;
		}
	}
}

/**
 * Creates and appends a single status marker: the tab's actual status from
 * `plugin.terminalStatuses` if it's open, otherwise whatever can be told from the `Row` alone
 * (`resolveRowStatus`). Uses the same icon (`TERMINAL_STATUS_ICON`), color/motion CSS class, and
 * tooltip as the tab header, so they stay consistent — except once `row.archived` is true, which
 * always shows the archive box instead (the icon Claude's own app uses for its "Archived"
 * bucket), regardless of the session's last-known running state.
 */
export function rowStatusMark(container: HTMLElement, plugin: AgentSessionsPlugin, row: Row): HTMLElement {
	// `obsidian`'s `setIcon`/`setTooltip` are required lazily (same reason as `views/detail.ts`'s
	// `makeIconButton`: so importing this file's pure functions in tests doesn't fail trying to
	// resolve `obsidian`).
	const { setIcon, setTooltip } = require("obsidian") as typeof import("obsidian");
	const status = resolveRowStatus(plugin, row);
	const cls = row.archived ? "agent-sessions-status-archived" : terminalStatusClass(status);
	const icon = row.archived ? STATUS_GROUP_ICON.archived : TERMINAL_STATUS_ICON[status];
	const mark = container.createSpan({ cls: `agent-sessions-row-mark ${cls}` });
	setIcon(mark, icon);
	setTooltip(mark, statusTooltip(status, row.archived));
	return mark;
}

/** The icon distinguishing which agent a session belongs to — Claude and Codex's own marks
 * (`ui/icons.ts`, T-102), registered once via `registerAgentIcons()` (`main.ts`'s `onload`). */
export const AGENT_ICON: Record<string, string> = AGENT_ICON_ID;

/** The agent's display-name key (`settings.agents.<id>.name` — the same proper names used in
 * Settings' "Agents" section, so the two stay consistent). */
export const AGENT_NAME_KEY: Record<string, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
};

/**
 * A small icon marking which agent a session belongs to (Claude Code, Codex, …) — shared by the
 * side panel's rows, the manager's rows, and (via the same icon/tooltip) the detail pane's badge.
 * An unrecognized agent id renders nothing rather than a broken icon — forward-compatible with a
 * future third agent this build doesn't know about yet.
 */
export function renderAgentMark(container: HTMLElement, agent: string): void {
	const icon = AGENT_ICON[agent];
	if (!icon) {
		return;
	}
	const { setIcon, setTooltip } = require("obsidian") as typeof import("obsidian");
	const mark = container.createSpan({ cls: "agent-sessions-row-agent-mark" });
	setIcon(mark, icon);
	setTooltip(mark, t(AGENT_NAME_KEY[agent]));
}

export function displayName(row: Row): string {
	return sessionDisplayName(row);
}

/**
 * Names a set of agents for a sentence like "Start {agents} with the button below" (T-106
 * addendum's `empty.desc`, and the settings-fallback messages next to it): "Claude Code",
 * "Codex", or "Claude Code or Codex" (`common.agentsEither`) depending on how many are given.
 * Only handles the pair known today (`ids.length <= 2` in practice, via `AGENT_IDS`) — a third
 * agent would need `common.agentsEither` generalized to a real list join, not attempted here.
 */
export function enabledAgentsText(ids: readonly string[]): string {
	const names = ids.map((id) => t(AGENT_NAME_KEY[id] ?? AGENT_NAME_KEY.claude));
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	return t("common.agentsEither", { a: names[0], b: names[1] });
}

/** `row`'s category (the part of the name before `': '`, same split as `tree.ts`'s `splitName`). `null` if there isn't one. */
export function categoryOf(row: Row): string | null {
	if (!row.name) {
		return null;
	}
	return splitName(row.name)[0];
}

/**
 * The name shown in tables and lists: the part after the category if there is one (`splitName`'s
 * second element), otherwise falls back to `displayName` (`label` / "Untitled"). Shared by the
 * manager's table and lists.
 */
export function rowLabel(row: Row): string {
	if (row.name) {
		return splitName(row.name)[1];
	}
	return displayName(row);
}

export { renderCategoryChip };

/** `MM-DD HH:MM` (local time). The tooltip for both the side panel row's and the manager
 * table's last-updated cell — `formatRelativeTime` is the displayed text in both places. */
export function formatTime(epochSeconds: number): string {
	if (!epochSeconds) {
		return "";
	}
	const d = new Date(epochSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The side panel's row time: "just now" under a minute, "N min ago" under an hour, "N h ago"
 * under a day, "yesterday" under two days, "N d ago" under a week, and "MM-DD" (no time of day)
 * from a week on — a plain duration cascade rather than calendar-day boundaries, so it doesn't
 * depend on timezone edge cases. `now` defaults to the current time; pass it explicitly in tests.
 */
export function formatRelativeTime(epochSeconds: number, now: number = Date.now() / 1000): string {
	if (!epochSeconds) {
		return "";
	}
	const diff = Math.max(0, now - epochSeconds);
	if (diff < 60) {
		return t("time.justNow");
	}
	if (diff < 3600) {
		return t("time.minutesAgo", { n: Math.floor(diff / 60) });
	}
	if (diff < 86400) {
		return t("time.hoursAgo", { n: Math.floor(diff / 3600) });
	}
	if (diff < 172800) {
		return t("time.yesterday");
	}
	if (diff < 604800) {
		return t("time.daysAgo", { n: Math.floor(diff / 86400) });
	}
	const d = new Date(epochSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Tracks a set of relative-time text elements (already showing `formatRelativeTime(epoch)`) and
 * re-renders just their text, once a minute, without touching anything else about the row/cell
 * they're in — no full re-render. Shared by the side panel and the manager (`SideView`,
 * `ManagerView`) so both tick on the same schedule and behave identically.
 */
export class RelativeTimeTicker {
	private entries: { el: HTMLElement; epoch: number }[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	/** Starts the once-a-minute tick. Call once, from `onOpen`. */
	start(): void {
		this.timer = setInterval(() => this.tick(), 60000);
	}

	/** Stops the tick — call from a `register()` cleanup so it doesn't outlive the view. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Forgets every tracked element. Call at the start of a full re-render, before re-tracking. */
	reset(): void {
		this.entries = [];
	}

	/** Tracks `el` so the next tick updates its text. A falsy `epoch` (no `last_activity`) is a
	 * no-op — there's nothing to update since the row shows no time at all in that case. */
	track(el: HTMLElement, epoch: number): void {
		if (epoch) {
			this.entries.push({ el, epoch });
		}
	}

	private tick(): void {
		for (const { el, epoch } of this.entries) {
			el.setText(formatRelativeTime(epoch));
		}
	}
}

/** The row menu (rename, move to category, compact session, archive, end session, session
 * analytics, copy ID). `manager.ts`'s table opens the same menu — shared by both the `⋯` button
 * and right-click. */
export function showRowMenu(evt: MouseEvent, row: Row, actions: RowActions): void {
	// See `rowStatusMark`'s comment on why `obsidian` is required lazily here.
	const { Menu } = require("obsidian") as typeof import("obsidian");
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t("action.rename"))
			.setIcon("pencil")
			.onClick(() => actions.rename(row.id, row.name ?? ""))
	);
	menu.addItem((item) => {
		item
			.setTitle(t("action.moveToCategory"))
			.setIcon("folder-input")
			.onClick(() => actions.moveToCategory(row));
		// Nothing to attach a category to yet — see `categorizableLabel`.
		if (!categorizableLabel(row)) {
			item.setDisabled(true);
		}
	});
	const lastPrompt = actions.lastUserPrompt?.(row.id);
	const alreadyCompacted = lastPrompt != null && lastPrompt.trim() === "/compact";
	menu.addItem((item) => {
		item
			.setTitle(t("action.compact"))
			.setIcon("scissors")
			.onClick(() => actions.compact(row.id));
		if (alreadyCompacted) {
			item.setDisabled(true);
		}
	});
	menu.addItem((item) =>
		item
			.setTitle(row.archived ? t("action.unarchive") : t("action.archive"))
			.setIcon(row.archived ? "archive-restore" : "archive")
			.onClick(() => actions.toggleArchive(row))
	);
	if (row.daemon) {
		menu.addItem((item) =>
			item
				.setTitle(t("action.endSession"))
				.setIcon("square-x")
				.onClick(() => actions.endSession(row.id))
		);
	}
	menu.addItem((item) =>
		item
			.setTitle(t("action.usage"))
			.setIcon("bar-chart-2")
			.onClick(() => actions.showUsage(row.id))
	);
	menu.addItem((item) =>
		item
			.setTitle(t("action.copyId"))
			.setIcon("copy")
			.onClick(() => actions.copyId(row.id))
	);
	menu.showAtMouseEvent(evt);
}

/** Renders one row: `status-marker  name  time  ▣  ⋯`. `⋯` is always shown. */
export function renderRow(container: HTMLElement, row: Row, opts: RenderRowOptions): HTMLElement {
	// See `rowStatusMark`'s comment on why `obsidian` is required lazily here.
	const { setTooltip } = require("obsidian") as typeof import("obsidian");
	const el = container.createDiv({ cls: "agent-sessions-row" });
	if (opts.front) {
		el.addClass("is-front");
	}
	if (opts.indent) {
		el.addClass("is-indented");
	}
	if (row.archived) {
		el.addClass("is-archived");
	}

	rowStatusMark(el, opts.plugin, row);
	renderAgentMark(el, row.agent);
	// Makes rows that are asking (waiting for an answer) or waiting (idle since busy, not yet seen) stand out.
	const attentionStatus = resolveRowStatus(opts.plugin, row);
	if (attentionStatus === "asking") {
		el.addClass("is-asking");
	} else if (attentionStatus === "waiting") {
		el.addClass("is-waiting");
	}
	const category = categoryOf(row);
	if (category) {
		renderCategoryChip(el, category, opts.plugin.index.categoryColorIndex(category));
	}
	el.createSpan({ cls: "agent-sessions-row-name", text: rowLabel(row) });
	const time = formatRelativeTime(row.last_activity);
	if (time) {
		const timeEl = el.createSpan({ cls: "agent-sessions-row-time", text: time });
		setTooltip(timeEl, formatTime(row.last_activity));
	}
	if (row.hasTab) {
		el.createSpan({ cls: "agent-sessions-row-tab-mark", text: "▣" });
	}

	const menuBtn = el.createSpan({ cls: "agent-sessions-row-menu-btn", text: "⋯" });
	menuBtn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		opts.selection.select(el, menuBtn);
		showRowMenu(evt, row, opts.actions);
	});

	el.addEventListener("click", () => {
		opts.selection.select(el, menuBtn);
		opts.actions.openSession(row.id);
	});
	el.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		opts.selection.select(el, menuBtn);
		showRowMenu(evt, row, opts.actions);
	});

	let hoverTimer: ReturnType<typeof setTimeout> | null = null;
	el.addEventListener("pointerenter", () => {
		// T-110: cancels a pending, delayed `hideDetail` from the list's own `pointerleave`
		// *before* scheduling this row's own confirm timer — otherwise moving directly from one
		// row to another (never actually leaving the list) could still flash back to the default
		// detail if the previous row's hide-delay happened to fire before this row's 300ms is up.
		opts.actions.cancelHideDetail?.();
		hoverTimer = setTimeout(() => opts.actions.showDetail(row.id), HOVER_DELAY_MS);
	});
	el.addEventListener("pointerleave", () => {
		// Only cancels *this row's own* not-yet-confirmed show — does not call `hideDetail` here
		// (T-110): that's wired to the list container's own `pointerleave` instead, so moving
		// between rows (without leaving the list) never reverts to the default detail at all.
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
	});

	return el;
}

/** A group heading row (a fold triangle and a count). Clicking it calls `onToggle`. */
export function renderGroupHeader(
	container: HTMLElement,
	name: string,
	count: number,
	folded: boolean,
	onToggle: () => void
): HTMLElement {
	const el = container.createDiv({ cls: "agent-sessions-group-header" });
	if (folded) {
		el.addClass("is-folded");
	}
	el.createSpan({ cls: "agent-sessions-group-caret", text: folded ? "▶" : "▼" });
	el.createSpan({ cls: "agent-sessions-group-name", text: name });
	el.createSpan({ cls: "agent-sessions-group-count", text: String(count) });
	el.addEventListener("click", () => onToggle());
	return el;
}

/**
 * Row actions shared by the side panel and the manager. `openSession`, `rename`, `compact`,
 * `toggleArchive`, `endSession`, and `copyId` behave the same in both views; only
 * `onShowDetail` differs per view (each renders the detail pane somewhere different).
 */
export function createRowActions(
	plugin: AgentSessionsPlugin,
	onShowDetail: (id: string) => void,
	onHideDetail?: () => void,
	onCancelHideDetail?: () => void
): RowActions {
	return {
		openSession: (id) => {
			const row = plugin.index.sessions.get(id);
			void plugin.openSession(id, { agent: row?.agent ?? "claude", cwd: row?.cwd ?? "" });
		},
		rename: (id, currentName) => {
			// `../ui/modals` itself has a top-level `obsidian` import, so it's required lazily here
			// too (same reason as `rowStatusMark`'s comment) — otherwise importing this file's
			// pure functions in tests would drag in `obsidian` transitively through this closure.
			const { RenameSessionModal } = require("../ui/modals") as typeof import("../ui/modals");
			new RenameSessionModal(plugin, currentName, (name) => void plugin.renameSession(id, name)).open();
		},
		moveToCategory: (row) => {
			const label = categorizableLabel(row);
			if (!label) {
				return;
			}
			// See `rename`'s comment on why `../ui/modals` is required lazily here.
			const { MoveToCategoryModal } = require("../ui/modals") as typeof import("../ui/modals");
			const [category] = row.name ? splitName(row.name) : [""];
			new MoveToCategoryModal(plugin, category ?? "", label, (name) => void plugin.renameSession(row.id, name)).open();
		},
		compact: (id) => void plugin.compactSession(id),
		toggleArchive: (row) => {
			if (row.archived) {
				plugin.unarchive(row.id);
			} else {
				plugin.archive(row.id, sessionDisplayName(row), row.agent);
			}
		},
		endSession: (id) => plugin.endSession(id),
		copyId: (id) => {
			void navigator.clipboard.writeText(id);
		},
		showDetail: onShowDetail,
		hideDetail: onHideDetail,
		cancelHideDetail: onCancelHideDetail,
		showUsage: (id) => plugin.showUsage(id),
		lastUserPrompt: (id) => plugin.index.getCachedDetail(id)?.last_command ?? undefined,
	};
}
