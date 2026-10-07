// A Claude Code session's `/goal`, as pure functions: which state it is in, its mark's icon, CSS
// class and tooltip. The goal itself comes from `json scan` (`ScanSession.goal`, read from the
// transcript's `goal_status` lines — `agentsessions/sessions/scan.py`'s `apply_goal_status`). The
// mark sits next to the session's state mark (it never replaces it): rows in the side panel and
// the Session Manager, the terminal tab's header, and the detail pane.

import { t, type MessageKey } from "../i18n";
import type { SessionGoal } from "../types";
import type { TerminalStatus } from "./terminal-status";

/** `active` until the evaluator finds the condition met (`met`) or impossible (`failed`). */
export type GoalState = "active" | "met" | "failed";

export function goalState(goal: SessionGoal | null | undefined): GoalState | null {
	if (!goal) {
		return null;
	}
	if (goal.failed) {
		return "failed";
	}
	return goal.met ? "met" : "active";
}

export const GOAL_ICON: Record<GoalState, string> = {
	active: "target",
	met: "trophy",
	failed: "flag-off",
};

export const GOAL_LABEL_KEY: Record<GoalState, MessageKey> = {
	active: "goal.active",
	met: "goal.met",
	failed: "goal.failed",
};

/** Statuses during which an active goal is being worked on right now — the only time its mark moves. */
const LIVE_STATUSES: ReadonlySet<TerminalStatus> = new Set(["connecting", "working", "running-shell"]);

/**
 * The mark's classes: `agent-sessions-goal-<state>`, plus `is-live` for an active goal while the
 * session is running (a slow breathing motion; an active goal on an idle or exited session stays
 * still, since nothing is happening).
 */
export function goalMarkClass(state: GoalState, status: TerminalStatus | null): string {
	const live = state === "active" && status !== null && LIVE_STATUSES.has(status);
	return `agent-sessions-goal-mark agent-sessions-goal-${state}${live ? " is-live" : ""}`;
}

/** Characters kept of the condition and of the evaluator's reason in a tooltip. */
export const GOAL_TOOLTIP_CONDITION_CHARS = 200;
export const GOAL_TOOLTIP_REASON_CHARS = 280;

/** `text` cut to `max` characters (code points), with `…` when it was longer. */
export function truncateText(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * The mark's tooltip: the state, the condition, and (once the evaluator has run) its reason —
 * each cut short, since a reason can run to several paragraphs.
 */
export function goalTooltip(goal: SessionGoal): string {
	const state = goalState(goal) ?? "active";
	const lines = [t(GOAL_LABEL_KEY[state]), truncateText(goal.condition.trim(), GOAL_TOOLTIP_CONDITION_CHARS)];
	if (goal.reason) {
		lines.push(`${t("goal.reason")}: ${truncateText(goal.reason.trim(), GOAL_TOOLTIP_REASON_CHARS)}`);
	}
	return lines.join("\n");
}

/**
 * Whether a registry transition should rescan the session to pick up a goal change sooner than
 * the periodic scan would. Claude Code writes the goal line before the turn it starts (`busy`:
 * worth a look while no goal is active) and the evaluator's verdict before the turn ends (`idle`:
 * worth a look while one is). A verdict mark (met or failed) goes away with the next human prompt,
 * so a turn that begins (`busy`) or ends (`idle`) with one showing is worth a look too.
 * `/goal clear` starts no turn; the periodic scan catches it.
 */
export function goalNeedsRescan(
	transition: "busy" | "idle",
	row: { agent: string; goal?: SessionGoal | null } | undefined
): boolean {
	if (!row || row.agent !== "claude") {
		return false;
	}
	const state = goalState(row.goal);
	return transition === "idle" ? state !== null : state !== "active";
}
