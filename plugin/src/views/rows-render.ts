// The DOM-rendering half of `rows.ts`: the status/agent marks, the row menu, and `renderRow`
// itself — split out because all of it needs real `obsidian` exports
// (`setIcon`/`setTooltip`/`Menu`), and `rows.ts` is imported directly by tests that run in a plain
// Node environment where the `obsidian` npm package (no runtime — its `main` is empty) can't be
// resolved. `rows.ts` keeps the pure row-text/timing helpers, the `RowActions`/`RenderRowOptions`
// types this file builds on, and `createRowActions` itself (its routing is covered by tests, and
// only its `rename`/`moveToCategory` closures ever touch `obsidian`, so those stay lazily
// required — see the comment there).

import { Platform, setIcon, setTooltip, Menu } from "obsidian";
import { moreIconId } from "../ui/icons";
import { renderCategoryChip } from "../ui/chip";
import type { Row } from "../sessions/index";
import { t } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { categorizableLabel } from "../sessions/name";
import {
	resolveRowStatus,
	STATUS_GROUP_ICON,
	statusTooltip,
	terminalStatusClass,
	TERMINAL_STATUS_ICON,
} from "../sessions/terminal-status";
import {
	AGENT_ICON,
	AGENT_NAME_KEY,
	categoryOf,
	formatRelativeTime,
	formatTime,
	rowLabel,
	type RenderRowOptions,
	type RowActions,
} from "./rows";

const HOVER_DELAY_MS = 300;

/**
 * Creates and appends a single status marker: the tab's actual status from
 * `plugin.terminalStatuses` if it's open, otherwise whatever can be told from the `Row` alone
 * (`resolveRowStatus`). Uses the same icon (`TERMINAL_STATUS_ICON`), color/motion CSS class, and
 * tooltip as the tab header, so they stay consistent — except once `row.archived` is true, which
 * always shows the archive box instead (the icon Claude's own app uses for its "Archived"
 * bucket), regardless of the session's last-known running state.
 */
export function rowStatusMark(container: HTMLElement, plugin: AgentSessionsPlugin, row: Row): HTMLElement {
	const status = resolveRowStatus(plugin, row);
	const cls = row.archived ? "agent-sessions-status-archived" : terminalStatusClass(status);
	const icon = row.archived ? STATUS_GROUP_ICON.archived : TERMINAL_STATUS_ICON[status];
	const mark = container.createSpan({ cls: `agent-sessions-row-mark ${cls}` });
	setIcon(mark, icon);
	setTooltip(mark, statusTooltip(status, row.archived));
	return mark;
}

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
	const mark = container.createSpan({ cls: "agent-sessions-row-agent-mark" });
	setIcon(mark, icon);
	setTooltip(mark, t(AGENT_NAME_KEY[agent]));
}

/** The row menu (rename, move to category, compact session, archive, end session, session
 * analytics, copy ID). `manager.ts`'s table opens the same menu — shared by both the `⋯` button
 * and right-click. */
export function showRowMenu(evt: MouseEvent, row: Row, actions: RowActions): void {
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
	const el = container.createDiv({ cls: "agent-sessions-row" });
	el.dataset.sessionId = row.id;
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

	const menuBtn = el.createSpan({ cls: "agent-sessions-row-menu-btn" });
	setIcon(menuBtn, moreIconId(Platform.isMacOS));
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

	let hoverTimer: number | null = null;
	el.addEventListener("pointerenter", () => {
		// T-110: cancels a pending, delayed `hideDetail` from the list's own `pointerleave`
		// *before* scheduling this row's own confirm timer — otherwise moving directly from one
		// row to another (never actually leaving the list) could still flash back to the default
		// detail if the previous row's hide-delay happened to fire before this row's 300ms is up.
		opts.actions.cancelHideDetail?.();
		hoverTimer = window.setTimeout(() => opts.actions.showDetail(row.id), HOVER_DELAY_MS);
	});
	el.addEventListener("pointerleave", () => {
		// Only cancels *this row's own* not-yet-confirmed show — does not call `hideDetail` here
		// (T-110): that's wired to the list container's own `pointerleave` instead, so moving
		// between rows (without leaving the list) never reverts to the default detail at all.
		if (hoverTimer) {
			window.clearTimeout(hoverTimer);
			hoverTimer = null;
		}
	});

	return el;
}
