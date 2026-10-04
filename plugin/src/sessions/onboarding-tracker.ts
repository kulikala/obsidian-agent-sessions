// What the welcome guide has seen the user do on its own session. A pure reducer over events: the
// guide tells it which step is showing, and feeds it what the plugin noticed (the session going
// idle, the active tab, a rename, a category move, the editor being sent) — it replies with the step
// that just got done, which is the only thing the guide turns into progress. No `obsidian` here, so
// it is tested in plain Node (test/sessions/onboarding-tracker.test.ts).

import { OPERATION_STEPS, type OnboardingStepId } from "../ui/onboarding-model";

/** What the guide (or the plugin, on the guide's behalf) reports to the tracker. */
export type TrackerEvent =
	/** The guide is now showing `step`. Each operation step starts over, so its flags say what
	 * happened while that step was up. */
	| { kind: "step-entered"; step: OnboardingStepId }
	/** The guide's session went from busy (or still starting) to idle. */
	| { kind: "idle"; sessionId: string }
	/** The session on the active leaf, or `null` for a tab that isn't a session. */
	| { kind: "active-tab"; sessionId: string | null }
	| { kind: "renamed"; sessionId: string; name: string }
	| { kind: "category-changed"; sessionId: string; category: string | null }
	/** What happened in the built-in editor: sent, went back to the prompt, cancelled, or there was
	 * no editor pane to act on. */
	| { kind: "editor-result"; sessionId: string; result: "send" | "return" | "cancel" | "no-tab" };

/** What the tracker has worked out so far. */
export interface TrackerState {
	/** The guide's own session. `null` until it has been started, and after it was skipped — with no
	 * session to watch, no event completes a step. */
	sessionId: string | null;
	/** The operation step being watched, or `null` between steps. */
	step: OnboardingStepId | null;
	/** The tabs step: the user has switched to another tab since entering it. */
	leftSession: boolean;
	/** The rename step: the session has been renamed. */
	nameChanged: boolean;
	/** The rename step: the session has been filed under a category. */
	categoryChanged: boolean;
}

/** What one event did: the state to keep, the step it completed (`null` if it completed none), and
 * — for the rename step's optional second half — that the session was moved to a category. */
export interface TrackerResult {
	state: TrackerState;
	done: OnboardingStepId | null;
	categoryDone?: boolean;
}

export function initialTracker(sessionId: string | null): TrackerState {
	return { sessionId, step: null, leftSession: false, nameChanged: false, categoryChanged: false };
}

/**
 * Folds one event into the state. Only events for the guide's own session count, and only while the
 * matching step is showing — something the user did before the guide asked for it doesn't tick a
 * step off, so the guide still walks them through it. A step that gets completed stops being
 * watched until the guide enters the next one, and an event that changes nothing returns the same
 * state object.
 */
export function track(state: TrackerState, ev: TrackerEvent): TrackerResult {
	if (ev.kind === "step-entered") {
		if (!OPERATION_STEPS.includes(ev.step)) {
			return { state, done: null };
		}
		return {
			state: { ...state, step: ev.step, leftSession: false, nameChanged: false, categoryChanged: false },
			done: null,
		};
	}

	const session = state.sessionId;
	if (session === null) {
		return { state, done: null };
	}

	if (ev.kind === "active-tab") {
		// The one event that isn't about a session: it reports which session is on top.
		if (state.step !== "tabs") {
			return { state, done: null };
		}
		if (ev.sessionId !== session) {
			return { state: { ...state, leftSession: true }, done: null };
		}
		return state.leftSession ? { state: { ...state, step: null }, done: "tabs" } : { state, done: null };
	}

	if (ev.sessionId !== session) {
		return { state, done: null };
	}

	if (ev.kind === "idle" && state.step === "first-session") {
		return { state: { ...state, step: null }, done: "first-session" };
	}

	if (ev.kind === "renamed" && state.step === "rename") {
		return { state: { ...state, nameChanged: true, step: null }, done: "rename" };
	}

	// Moving to a category is the rename step's optional second half: a name is enough to move on,
	// so it is reported but never completes the step on its own. A move that lands after the step is
	// already done still counts (`nameChanged` is what says the rename step was reached), since the
	// guide asks for both while the step is up.
	if (ev.kind === "category-changed" && ev.category !== null && (state.step === "rename" || state.nameChanged)) {
		return { state: { ...state, categoryChanged: true }, done: null, categoryDone: true };
	}

	if (ev.kind === "editor-result" && state.step === "editor" && ev.result === "send") {
		return { state: { ...state, step: null }, done: "editor" };
	}

	return { state, done: null };
}