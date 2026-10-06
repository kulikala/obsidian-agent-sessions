// The `/goal` mark's DOM (`sessions/goal.ts` holds the pure state/icon/class/tooltip rules): one
// small icon next to a session's name in the side panel's and the manager's rows, and in the
// terminal tab's header. Split out because it needs real `obsidian` exports (`setIcon`/`setTooltip`).

import { setIcon, setTooltip } from "obsidian";
import { GOAL_ICON, goalMarkClass, goalState, goalTooltip } from "../sessions/goal";
import type { TerminalStatus } from "../sessions/terminal-status";
import type { SessionGoal } from "../types";

/** Appends the goal mark to `container`, or nothing when the session has no goal. */
export function renderGoalMark(
	container: HTMLElement,
	goal: SessionGoal | null | undefined,
	status: TerminalStatus | null
): HTMLElement | null {
	const state = goalState(goal);
	if (!goal || !state) {
		return null;
	}
	const mark = container.createSpan({ cls: goalMarkClass(state, status) });
	setIcon(mark, GOAL_ICON[state]);
	setTooltip(mark, goalTooltip(goal));
	return mark;
}

const TAB_MARK_CLS = "agent-sessions-tab-goal";

/**
 * Keeps the goal mark in a terminal tab's header (`leaf.tabHeaderEl`) in step with `goal`: added
 * after the title, updated in place, or removed. Obsidian redraws only the header's icon and
 * title, so an element of our own placed beside them survives those redraws.
 */
export function syncTabGoalMark(
	headerEl: HTMLElement | undefined,
	goal: SessionGoal | null | undefined,
	status: TerminalStatus | null
): void {
	const inner = headerEl?.querySelector<HTMLElement>(".workspace-tab-header-inner");
	if (!inner) {
		return;
	}
	const existing = inner.querySelector<HTMLElement>(`:scope > .${TAB_MARK_CLS}`);
	const state = goalState(goal);
	if (!goal || !state) {
		existing?.remove();
		return;
	}
	const cls = `${TAB_MARK_CLS} ${goalMarkClass(state, status)}`;
	const tooltip = goalTooltip(goal);
	if (existing && existing.dataset.goalKey === `${state}\n${tooltip}`) {
		existing.className = cls;
		return;
	}
	existing?.remove();
	const mark = createSpan({ cls });
	mark.dataset.goalKey = `${state}\n${tooltip}`;
	setIcon(mark, GOAL_ICON[state]);
	setTooltip(mark, tooltip);
	const title = inner.querySelector(".workspace-tab-header-inner-title");
	if (title) {
		title.after(mark);
	} else {
		inner.appendChild(mark);
	}
}
