import { describe, expect, it } from "vitest";
import { initialTracker, track, type TrackerEvent, type TrackerState } from "../../src/sessions/onboarding-tracker";
import type { OnboardingStepId } from "../../src/ui/onboarding-model";

/** Folds a run of events, returning the final state and the steps they completed. */
function run(events: TrackerEvent[], from: TrackerState = initialTracker("s1")): {
	state: TrackerState;
	done: string[];
	categoryDone: boolean;
} {
	let state = from;
	const done: string[] = [];
	let categoryDone = false;
	for (const ev of events) {
		const result = track(state, ev);
		state = result.state;
		if (result.done) {
			done.push(result.done);
		}
		categoryDone ||= result.categoryDone === true;
	}
	return { state, done, categoryDone };
}

const entered = (step: OnboardingStepId): TrackerEvent => ({ kind: "step-entered", step });

describe("initialTracker", () => {
	it("starts with nothing watched and nothing done", () => {
		expect(initialTracker("s1")).toEqual({
			sessionId: "s1",
			step: null,
			leftSession: false,
			nameChanged: false,
			categoryChanged: false,
		});
	});

	it("can start with no session at all", () => {
		expect(initialTracker(null).sessionId).toBeNull();
	});
});

describe("first-session", () => {
	it("is done when the session goes idle", () => {
		const { done, state } = run([entered("first-session"), { kind: "idle", sessionId: "s1" }]);
		expect(done).toEqual(["first-session"]);
		expect(state.step).toBeNull();
	});

	it("is not done by an idle that happened before the step was entered", () => {
		const early = track(initialTracker("s1"), { kind: "idle", sessionId: "s1" });
		expect(early).toEqual({ state: initialTracker("s1"), done: null });
		const { done } = run([{ kind: "idle", sessionId: "s1" }, entered("first-session"), { kind: "idle", sessionId: "s1" }]);
		expect(done).toEqual(["first-session"]);
	});

	it("ignores another session going idle", () => {
		const { done } = run([entered("first-session"), { kind: "idle", sessionId: "other" }]);
		expect(done).toEqual([]);
	});

	it("completes nothing while no session is being watched", () => {
		const { done } = run([entered("first-session"), { kind: "idle", sessionId: "s1" }], initialTracker(null));
		expect(done).toEqual([]);
	});
});

describe("tabs", () => {
	it("needs the user to leave the session's tab and come back to it", () => {
		expect(run([entered("tabs"), { kind: "active-tab", sessionId: "s1" }]).done).toEqual([]);
		expect(run([entered("tabs"), { kind: "active-tab", sessionId: null }]).done).toEqual([]);
		const { done, state } = run([
			entered("tabs"),
			{ kind: "active-tab", sessionId: "s1" },
			{ kind: "active-tab", sessionId: null },
			{ kind: "active-tab", sessionId: "s1" },
		]);
		expect(done).toEqual(["tabs"]);
		expect(state.step).toBeNull();
	});

	it("is done by another session's tab in front as well", () => {
		const { done } = run([
			entered("tabs"),
			{ kind: "active-tab", sessionId: "other" },
			{ kind: "active-tab", sessionId: "s1" },
		]);
		expect(done).toEqual(["tabs"]);
	});

	it("records having left, and forgets it when the step is entered again", () => {
		const left = track(initialTracker("s1"), entered("tabs"));
		expect(left.state.leftSession).toBe(false);
		const away = track(left.state, { kind: "active-tab", sessionId: null });
		expect(away.state.leftSession).toBe(true);
		expect(track(away.state, entered("tabs")).state.leftSession).toBe(false);
	});

	it("does nothing before the step is entered", () => {
		const { done } = run([
			{ kind: "active-tab", sessionId: null },
			{ kind: "active-tab", sessionId: "s1" },
		]);
		expect(done).toEqual([]);
	});

	it("completes only once: a later tab change doesn't do it again", () => {
		const { done } = run([
			entered("tabs"),
			{ kind: "active-tab", sessionId: null },
			{ kind: "active-tab", sessionId: "s1" },
			{ kind: "active-tab", sessionId: null },
			{ kind: "active-tab", sessionId: "s1" },
		]);
		expect(done).toEqual(["tabs"]);
	});
});

describe("rename", () => {
	it("is done by a rename of the guide's session", () => {
		const { done, state } = run([entered("rename"), { kind: "renamed", sessionId: "s1", name: "notes" }]);
		expect(done).toEqual(["rename"]);
		expect(state.nameChanged).toBe(true);
	});

	it("does not count a rename that happened before the step was entered", () => {
		const { done } = run([
			{ kind: "renamed", sessionId: "s1", name: "notes" },
			entered("rename"),
		]);
		expect(done).toEqual([]);
	});

	it("ignores a rename of another session", () => {
		const { done } = run([entered("rename"), { kind: "renamed", sessionId: "other", name: "notes" }]);
		expect(done).toEqual([]);
	});

	it("reports a category move without waiting for it, and a name alone completes the step", () => {
		const moved = track(track(initialTracker("s1"), entered("rename")).state, {
			kind: "category-changed",
			sessionId: "s1",
			category: "work",
		});
		expect(moved.categoryDone).toBe(true);
		expect(moved.done).toBeNull();
		expect(moved.state.categoryChanged).toBe(true);
		expect(track(moved.state, { kind: "renamed", sessionId: "s1", name: "work: notes" }).done).toBe("rename");
	});

	it("reports a category move that lands after the rename is already done", () => {
		const renamed = track(track(initialTracker("s1"), entered("rename")).state, {
			kind: "renamed",
			sessionId: "s1",
			name: "notes",
		});
		const moved = track(renamed.state, { kind: "category-changed", sessionId: "s1", category: "work" });
		expect(moved.categoryDone).toBe(true);
	});

	it("ignores taking the category away again, and another session's move", () => {
		const inStep = track(initialTracker("s1"), entered("rename")).state;
		const cleared = track(inStep, { kind: "category-changed", sessionId: "s1", category: null });
		expect(cleared.categoryDone).toBeUndefined();
		expect(cleared.state.categoryChanged).toBe(false);
		expect(track(inStep, { kind: "category-changed", sessionId: "other", category: "work" }).categoryDone).toBeUndefined();
	});

	it("reports no category move for a rename that happened before the step", () => {
		const early = track(initialTracker("s1"), { kind: "category-changed", sessionId: "s1", category: "work" });
		expect(early.categoryDone).toBeUndefined();
		expect(early.state.categoryChanged).toBe(false);
	});
});

describe("editor", () => {
	it("is done only by a send", () => {
		const inStep = track(initialTracker("s1"), entered("editor")).state;
		for (const result of ["return", "cancel", "no-tab"] as const) {
			const ev = { kind: "editor-result", sessionId: "s1", result } as TrackerEvent;
			expect(track(inStep, ev)).toEqual({ state: inStep, done: null });
		}
		expect(track(inStep, { kind: "editor-result", sessionId: "s1", result: "send" }).done).toBe("editor");
	});

	it("stays open after anything but a send, and closes on the send that follows", () => {
		const { done } = run([
			entered("editor"),
			{ kind: "editor-result", sessionId: "s1", result: "cancel" },
			{ kind: "editor-result", sessionId: "s1", result: "return" },
			{ kind: "editor-result", sessionId: "s1", result: "send" },
		]);
		expect(done).toEqual(["editor"]);
	});

	it("ignores another session's editor", () => {
		const { done } = run([entered("editor"), { kind: "editor-result", sessionId: "other", result: "send" }]);
		expect(done).toEqual([]);
	});

	it("does nothing before the step is entered", () => {
		const { done } = run([{ kind: "editor-result", sessionId: "s1", result: "send" }, entered("editor")]);
		expect(done).toEqual([]);
	});
});

describe("the step being watched", () => {
	it("is only the operation steps: the guide's other steps change nothing", () => {
		const before = track(initialTracker("s1"), { kind: "renamed", sessionId: "s1", name: "notes" });
		for (const step of ["language", "about", "setup", "more", "whats-new"] as const) {
			expect(track(before.state, { kind: "step-entered", step })).toEqual({ state: before.state, done: null });
		}
		expect(track(before.state, entered("first-session")).state.step).toBe("first-session");
	});

	it("starts each step over, so nothing carries over from a previous visit", () => {
		const renamed = track(initialTracker("s1"), { kind: "renamed", sessionId: "s1", name: "notes" }).state;
		const away = track(renamed, { kind: "active-tab", sessionId: null }).state;
		expect(track(away, entered("rename")).state).toEqual({
			sessionId: "s1",
			step: "rename",
			leftSession: false,
			nameChanged: false,
			categoryChanged: false,
		});
	});

	it("only counts events of one session at a time", () => {
		const { done } = run([entered("rename"), { kind: "renamed", sessionId: "s2", name: "other" }], initialTracker("s1"));
		expect(done).toEqual([]);
	});
});