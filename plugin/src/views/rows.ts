// Row selection and the pure row-text/timing helpers — shared by the side panel and the manager.
// Kept free of any `obsidian` import (its npm package has no runtime — see `rows-render.ts`'s own
// note) since tests import this module directly for its pure exports. The DOM-rendering half
// (row markup, the `⋯` menu, `createRowActions`) lives in `rows-render.ts`. The detail pane is
// `views/detail.ts`.

import { renderCategoryChip } from "../ui/chip";
import { AGENT_ICON_ID } from "../ui/icons";
import type { Row } from "../sessions/index";
import { getLang, t, type MessageKey } from "../i18n";
import { formatDateShort, formatDateTimeShort } from "../i18n/datetime";
import type AgentSessionsPlugin from "../main";
import { categorizableLabel, sessionDisplayName } from "../sessions/name";
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
	private timer: number | null = null;

	constructor(
		private readonly ms: number,
		private readonly run: () => void
	) {}

	/** (Re)starts the delay — cancels any timer already pending first. */
	schedule(): void {
		this.cancel();
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.run();
		}, this.ms);
	}

	/** Stops a pending delay without calling `run`. A no-op if nothing is pending. */
	cancel(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
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

/** The icon distinguishing which agent a session belongs to — each agent's own mark
 * (`ui/icons.ts`, T-102), registered once via `registerAgentIcons()` (`main.ts`'s `onload`). */
export const AGENT_ICON: Record<string, string> = AGENT_ICON_ID;

/** The agent's display-name key (`settings.agents.<id>.name` — the same proper names used in
 * Settings' "Agents" section, so the two stay consistent). */
export const AGENT_NAME_KEY: Record<string, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
	opencode: "settings.agents.opencode.name",
};

export function displayName(row: Row): string {
	return sessionDisplayName(row);
}

/**
 * Names a set of agents for a sentence like "Start {agents} with the button below" (T-106
 * addendum's `empty.desc`, and the settings-fallback messages next to it): "Claude Code",
 * "Codex", "Claude Code or Codex" (`common.agentsEither`), or "Claude Code, Codex, or OpenCode"
 * (`common.agentsSeparator` between all but the last, `common.agentsEitherLast` before it),
 * depending on how many are given.
 */
export function enabledAgentsText(ids: readonly string[]): string {
	const names = ids.map((id) => t(AGENT_NAME_KEY[id] ?? AGENT_NAME_KEY.claude));
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	if (names.length === 2) {
		return t("common.agentsEither", { a: names[0], b: names[1] });
	}
	return t("common.agentsEitherLast", {
		head: names.slice(0, -1).join(t("common.agentsSeparator")),
		last: names[names.length - 1],
	});
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

/** Locale-short date + time (T-115) — ja "2026/09/25 14:05", en "9/25/26, 2:05 PM" (year omitted
 * when it's the current year). The tooltip for both the side panel row's and the manager table's
 * last-updated cell — `formatRelativeTime` is the displayed text in both places. */
export function formatTime(epochSeconds: number): string {
	if (!epochSeconds) {
		return "";
	}
	return formatDateTimeShort(epochSeconds, getLang());
}

/**
 * The side panel's row time: "just now" under a minute, "N min ago" under an hour, "N h ago"
 * under a day, "yesterday" under two days, "N d ago" under a week, and a locale-short date (no
 * time of day, T-115) from a week on — a plain duration cascade rather than calendar-day
 * boundaries, so it doesn't depend on timezone edge cases. `now` defaults to the current time;
 * pass it explicitly in tests.
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
	return formatDateShort(epochSeconds, getLang(), now);
}

/**
 * Tracks a set of relative-time text elements (already showing `formatRelativeTime(epoch)`) and
 * re-renders just their text, once a minute, without touching anything else about the row/cell
 * they're in — no full re-render. Shared by the side panel and the manager (`SideView`,
 * `ManagerView`) so both tick on the same schedule and behave identically.
 */
export class RelativeTimeTicker {
	private entries: { el: HTMLElement; epoch: number }[] = [];
	private timer: number | null = null;

	/** Starts the once-a-minute tick. Call once, from `onOpen`. */
	start(): void {
		this.timer = window.setInterval(() => this.tick(), 60000);
	}

	/** Stops the tick — call from a `register()` cleanup so it doesn't outlive the view. */
	stop(): void {
		if (this.timer) {
			window.clearInterval(this.timer);
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
			// `../ui/modals` itself has a top-level `obsidian` import, and `obsidian` has no runtime
			// outside the real app (its npm package's `main` is empty) — so it's required lazily
			// here, deferred until a rename is actually requested, rather than imported at the top of
			// this file. That keeps this file's pure exports (tested directly, in Node) importable
			// without touching `obsidian` at all, since this closure is never invoked by those tests.
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above
			const { RenameSessionModal } = require("../ui/modals") as typeof import("../ui/modals");
			new RenameSessionModal(plugin, currentName, (name) => void plugin.renameSession(id, name)).open();
		},
		moveToCategory: (row) => {
			const label = categorizableLabel(row);
			if (!label) {
				return;
			}
			// See `rename`'s comment on why `../ui/modals` is required lazily here.
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- see rename's comment above
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
