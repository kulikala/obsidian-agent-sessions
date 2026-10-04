// The small pure pieces that turn what the plugin sees into events for the welcome guide's tracker
// (`onboarding-tracker.ts`) and its coach window: which session a tab or a name belongs to, what a
// change of name means, and when the "answer the question in the terminal" hint is due. No
// `obsidian` here, so it is tested in plain Node (test/sessions/onboarding-watch.test.ts).

import type { TrackerEvent } from "./onboarding-tracker";
import { splitName } from "./tree";

/** How long the guide's session may sit without answering before the coach hints at the terminal. */
export const TERMINAL_HINT_MS = 60_000;

/**
 * The session id the tracker is told is on top, for the active leaf: `null` when the leaf isn't a
 * terminal tab. A tab that the guide's session lives in is reported under the guide's own id even if
 * the tab has since been linked to the agent's real id (Codex and OpenCode start under a placeholder).
 */
export function activeTabSession(
	tab: { sessionId: string; daemonId: string } | null,
	guideSessionId: string | null
): string | null {
	if (tab === null) {
		return null;
	}
	if (guideSessionId !== null && (tab.sessionId === guideSessionId || tab.daemonId === guideSessionId)) {
		return guideSessionId;
	}
	return tab.sessionId;
}

/** The category of a session name (`"Team: Notes"` is in "Team"), or `null` for none. */
export function categoryOf(name: string | null): string | null {
	return name ? splitName(name)[0] : null;
}

/**
 * What changing a session's name from `prev` to `next` tells the tracker: a rename first, then —
 * when the category differs — the category change. Nothing for an unchanged name or one that was
 * cleared.
 */
export function nameEvents(sessionId: string, prev: string | null, next: string | null): TrackerEvent[] {
	if (next === null || next === "" || next === prev) {
		return [];
	}
	const events: TrackerEvent[] = [{ kind: "renamed", sessionId, name: next }];
	const category = categoryOf(next);
	if (category !== categoryOf(prev)) {
		events.push({ kind: "category-changed", sessionId, category });
	}
	return events;
}

/**
 * Since when the guide's session has been unanswered, given its ledger status (`undefined` when the
 * ledger has no entry for it yet). The agent is waiting on the user for a permission or a question
 * (`waiting`), or hasn't reached the prompt at all (no entry: the first-run theme, login and
 * folder-trust questions); `idle`, `busy` and `shell` all mean it is getting on by itself, so the
 * clock stops.
 */
export function unansweredSince(prev: number | null, status: string | undefined, now: number): number | null {
	if (status === undefined || status === "waiting") {
		return prev ?? now;
	}
	return null;
}

/** Whether the hint is due: the session has been unanswered for `TERMINAL_HINT_MS`. */
export function hintDue(since: number | null, now: number): boolean {
	return since !== null && now - since >= TERMINAL_HINT_MS;
}
