import { describe, expect, it } from "vitest";
import {
	completeStep,
	installPageState,
	nextIndex,
	ONBOARDING_SCENES,
	onboardingImageUrl,
	onboardingSteps,
	progressFinished,
	resolveAutoLanguage,
	resumeProgress,
	sanitizeProgress,
	shouldOpenOnStartup,
	skipStep,
	stepAvailableFor,
	stepState,
	STEP_SCENES,
	WHATS_NEW,
	whatsNewSince,
	type OnboardingProgress,
} from "../../src/ui/onboarding-model";

describe("install page", () => {
	it("reports the install state", () => {
		expect(installPageState(true, "/x/agent-sessions")).toEqual({ kind: "installed", path: "/x/agent-sessions" });
		expect(installPageState(false, "/x/agent-sessions")).toEqual({ kind: "missing" });
	});
});

const FIRST_STEPS = onboardingSteps("first", { backendInstalled: true, whatsNew: false });

/** A record of progress in a first run, with only what a test cares about overridden. */
function progress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
	return { version: 1, mode: "first", steps: [...FIRST_STEPS], current: 0, states: {}, sessionId: null, ...overrides };
}

describe("onboardingSteps", () => {
	it("walks the whole guide the first time, whatever else is true", () => {
		expect(FIRST_STEPS).toEqual([
			"language",
			"about",
			"setup",
			"first-session",
			"tabs",
			"rename",
			"editor",
			"more",
		]);
		expect(onboardingSteps("first", { backendInstalled: false, whatsNew: true })).toEqual(FIRST_STEPS);
	});

	it("an update run is only the steps with something to say", () => {
		expect(onboardingSteps("update", { backendInstalled: false, whatsNew: true })).toEqual(["setup", "whats-new"]);
		expect(onboardingSteps("update", { backendInstalled: true, whatsNew: true })).toEqual(["whats-new"]);
		expect(onboardingSteps("update", { backendInstalled: false, whatsNew: false })).toEqual(["setup"]);
	});

	it("is empty when the backend is installed and there is nothing new, so nothing opens", () => {
		expect(onboardingSteps("update", { backendInstalled: true, whatsNew: false })).toEqual([]);
	});
});

describe("stepAvailableFor", () => {
	it("offers every step to Claude Code", () => {
		for (const step of FIRST_STEPS) {
			expect(stepAvailableFor(step, "claude")).toBe(true);
		}
		expect(stepAvailableFor("whats-new", "claude")).toBe(true);
	});

	it("keeps only the tab switch of the operation steps for Codex and OpenCode", () => {
		for (const agent of ["codex", "opencode"] as const) {
			expect(stepAvailableFor("tabs", agent)).toBe(true);
			expect(stepAvailableFor("first-session", agent)).toBe(false);
			expect(stepAvailableFor("rename", agent)).toBe(false);
			expect(stepAvailableFor("editor", agent)).toBe(false);
		}
	});

	it("keeps the steps that don't involve a session, whatever the agent", () => {
		for (const step of ["language", "about", "setup", "more", "whats-new"] as const) {
			expect(stepAvailableFor(step, "codex")).toBe(true);
			expect(stepAvailableFor(step, "opencode")).toBe(true);
		}
	});
});

describe("sanitizeProgress", () => {
	const valid = {
		version: 1,
		mode: "first",
		steps: ["language", "about", "setup"],
		current: 1,
		states: { language: "done", about: "skipped" },
		sessionId: "s1",
		renameCategoryDone: true,
	};

	it("keeps a well-formed record, as a copy", () => {
		expect(sanitizeProgress(valid)).toEqual(valid);
	});

	it("keeps a record with an empty step list, no states and no session", () => {
		expect(sanitizeProgress({ version: 1, mode: "update", steps: [], current: 0, states: {}, sessionId: null })).toEqual({
			version: 1,
			mode: "update",
			steps: [],
			current: 0,
			states: {},
			sessionId: null,
		});
	});

	it("drops the optional category flag rather than the whole record when it is the wrong type", () => {
		expect(sanitizeProgress({ ...valid, renameCategoryDone: "yes" })).toEqual({
			version: 1,
			mode: "first",
			steps: ["language", "about", "setup"],
			current: 1,
			states: { language: "done", about: "skipped" },
			sessionId: "s1",
		});
	});

	it("keeps the tab's own id when it is a string and drops it otherwise", () => {
		expect(sanitizeProgress({ ...valid, tabSessionId: "t1" })?.tabSessionId).toBe("t1");
		expect(sanitizeProgress({ ...valid, tabSessionId: 5 })).toEqual(valid);
	});

	it("returns null for anything that isn't an object", () => {
		for (const raw of [null, undefined, "progress", 3, true, ["language"]]) {
			expect(sanitizeProgress(raw)).toBeNull();
		}
	});

	it("returns null for the wrong version or mode", () => {
		expect(sanitizeProgress({ ...valid, version: 2 })).toBeNull();
		expect(sanitizeProgress({ ...valid, version: "1" })).toBeNull();
		expect(sanitizeProgress({ ...valid, mode: "later" })).toBeNull();
		expect(sanitizeProgress({ ...valid, version: undefined })).toBeNull();
	});

	it("returns null for a step list that isn't a list of known steps", () => {
		expect(sanitizeProgress({ ...valid, steps: ["about", "install-everything"] })).toBeNull();
		expect(sanitizeProgress({ ...valid, steps: "about" })).toBeNull();
		expect(sanitizeProgress({ ...valid, steps: [1] })).toBeNull();
	});

	it("returns null for a current outside the step list (the step count itself is in range)", () => {
		expect(sanitizeProgress({ ...valid, current: 4 })).toBeNull();
		expect(sanitizeProgress({ ...valid, current: -1 })).toBeNull();
		expect(sanitizeProgress({ ...valid, current: 1.5 })).toBeNull();
		expect(sanitizeProgress({ ...valid, current: "1" })).toBeNull();
		expect(sanitizeProgress({ ...valid, current: valid.steps.length })).not.toBeNull();
	});

	it("returns null for an unknown step id or state value in the states", () => {
		expect(sanitizeProgress({ ...valid, states: { language: "finished" } })).toBeNull();
		expect(sanitizeProgress({ ...valid, states: { language: true } })).toBeNull();
		expect(sanitizeProgress({ ...valid, states: { "first-visit": "done" } })).toBeNull();
		expect(sanitizeProgress({ ...valid, states: "done" })).toBeNull();
		expect(sanitizeProgress({ ...valid, states: null })).toBeNull();
	});

	it("returns null for a session id that isn't a string or null", () => {
		expect(sanitizeProgress({ ...valid, sessionId: 7 })).toBeNull();
		expect(sanitizeProgress({ ...valid, sessionId: undefined })).toBeNull();
	});

	it("never throws, whatever the saved JSON holds", () => {
		const hostile = {
			version: 1,
			mode: "first",
			get steps(): string[] {
				throw new Error("boom");
			},
		};
		expect(sanitizeProgress(hostile)).toBeNull();
	});
});

describe("progress: marking steps", () => {
	it("marks a step done, without touching the record it was given", () => {
		const before = progress();
		const done = completeStep(before, "about");
		expect(stepState(done, "about")).toBe("done");
		expect(stepState(before, "about")).toBe("pending");
		expect(done.steps).toBe(before.steps);
	});

	it("skips the steps that need the session when the first session is skipped", () => {
		const skipped = skipStep(progress(), "first-session");
		for (const step of ["first-session", "tabs", "rename", "editor"] as const) {
			expect(stepState(skipped, step)).toBe("skipped");
		}
		expect(stepState(skipped, "language")).toBe("pending");
	});

	it("keeps a dependent step that was already done when the first session is skipped", () => {
		const skipped = skipStep(progress({ states: { tabs: "done" } }), "first-session");
		expect(stepState(skipped, "tabs")).toBe("done");
		expect(stepState(skipped, "rename")).toBe("skipped");
	});

	it("leaves the other steps alone when a single step is skipped", () => {
		const skipped = skipStep(progress(), "rename");
		expect(stepState(skipped, "rename")).toBe("skipped");
		expect(stepState(skipped, "tabs")).toBe("pending");
		expect(stepState(skipped, "first-session")).toBe("pending");
	});
});

describe("resumeProgress", () => {
	const started = progress({
		current: 4,
		states: { language: "done", about: "done", setup: "done", "first-session": "done", tabs: "done" },
		sessionId: "s1",
	});

	it("puts the session steps that were not finished back to pending, at the first session", () => {
		const resumed = resumeProgress(started, () => false);
		expect(resumed.sessionId).toBeNull();
		expect(resumed.current).toBe(FIRST_STEPS.indexOf("first-session"));
		expect(resumed.states).toEqual({
			language: "done",
			about: "done",
			setup: "done",
			// Done stays done: the user already did these, and asking again would be a lie.
			"first-session": "done",
			tabs: "done",
			rename: "pending",
			editor: "pending",
		});
	});

	it("leaves a session that still exists exactly as it is", () => {
		expect(resumeProgress(started, () => true)).toBe(started);
	});

	it("does nothing when there was never a session", () => {
		const none = progress({ current: 2 });
		expect(resumeProgress(none, () => false)).toBe(none);
	});

	it("does not bring back the steps the user skipped", () => {
		const skipped = skipStep(progress({ current: 3, sessionId: "s1" }), "first-session");
		const resumed = resumeProgress(skipped, () => false);
		expect(resumed.states["first-session"]).toBe("skipped");
		expect(resumed.states.tabs).toBe("skipped");
		expect(resumed.states.rename).toBe("skipped");
		expect(resumed.states.editor).toBe("skipped");
		expect(resumed.sessionId).toBeNull();
	});

	it("keeps an update run's cursor where it is: it has no first session to go back to", () => {
		const update = progress({
			mode: "update",
			steps: ["setup", "whats-new"],
			current: 1,
			states: { setup: "done" },
			sessionId: "s1",
		});
		const resumed = resumeProgress(update, () => false);
		expect(resumed.current).toBe(1);
		expect(resumed.sessionId).toBeNull();
		expect(resumed.states).toEqual({ setup: "done" });
	});
});

describe("nextIndex and progressFinished", () => {
	it("goes to the first step after the current one that is still pending", () => {
		const p = progress({ current: 0, states: { language: "done", about: "done", setup: "done" } });
		expect(nextIndex(p)).toBe(FIRST_STEPS.indexOf("first-session"));
	});

	it("skips over the steps that were done or skipped", () => {
		const p = skipStep(progress({ current: 2, states: { "first-session": "done", tabs: "done" } }), "rename");
		expect(nextIndex(p)).toBe(FIRST_STEPS.indexOf("editor"));
	});

	it("is the step count once nothing is left after the current step", () => {
		const p = progress({ steps: ["about", "more"], current: 0, states: { about: "done", more: "skipped" } });
		expect(nextIndex(p)).toBe(2);
		expect(progressFinished(p)).toBe(true);
	});

	it("is unfinished while any step is still pending", () => {
		expect(progressFinished(progress())).toBe(false);
		expect(progressFinished(progress({ steps: [], current: 0 }))).toBe(true);
	});
});

describe("whatsNewSince", () => {
	const item = WHATS_NEW["0.5.0"][0];

	it("is empty for a user who has never seen the guide", () => {
		expect(whatsNewSince("", "0.5.0")).toEqual([]);
		expect(whatsNewSince("", "9.9.9")).toEqual([]);
	});

	it("has the items of every version between what was shown and now, oldest first", () => {
		const older = { title: "onboarding.step.about", body: "onboarding.about.lead", scene: "overview" } as const;
		const newer = { title: "onboarding.step.setup", body: "onboarding.install.desc", scene: "install" } as const;
		WHATS_NEW["0.4.5"] = [older];
		WHATS_NEW["0.6.0"] = [newer];
		try {
			expect(whatsNewSince("0.4.0", "0.6.0")).toEqual([older, item, newer]);
			expect(whatsNewSince("0.4.0", "0.5.0")).toEqual([older, item]);
			// The version shown exactly needs no repeat; nothing newer than `current` either.
			expect(whatsNewSince("0.4.5", "0.4.5")).toEqual([]);
			expect(whatsNewSince("0.5.0", "0.5.0")).toEqual([]);
		} finally {
			delete WHATS_NEW["0.4.5"];
			delete WHATS_NEW["0.6.0"];
		}
	});

	it("compares versions numerically, and leaves out versions older than what was shown", () => {
		expect(whatsNewSince("0.4.0", "0.5.0")).toEqual([item]);
		expect(whatsNewSince("0.6.0", "0.9.0")).toEqual([]);
		expect(whatsNewSince("0.4.10", "0.5.0")).toEqual([item]);
		expect(whatsNewSince("0.5.1", "0.10.0")).toEqual([]);
	});
});

describe("shouldOpenOnStartup", () => {
	const unfinished = progress({ current: 1 });
	const finished = progress({ steps: ["about"], current: 1, states: { about: "done" } });

	it("runs the guide from the top when nothing has been recorded yet", () => {
		expect(shouldOpenOnStartup("", "0.5.0", true, null)).toBe("first");
		expect(shouldOpenOnStartup("", "0.5.0", false, unfinished)).toBe("first");
	});

	it("runs the update flow after a version that has something new to show", () => {
		expect(shouldOpenOnStartup("0.4.0", "0.5.0", true, null)).toBe("update");
		expect(shouldOpenOnStartup("0.4.0", "0.5.0", true, finished)).toBe("update");
	});

	it("offers to resume an unfinished run instead of opening nothing", () => {
		expect(shouldOpenOnStartup("0.5.0", "0.5.0", true, unfinished)).toBe("resume-notice");
	});

	it("falls back to the resume notice for a version jump with nothing new to read", () => {
		expect(shouldOpenOnStartup("0.5.0", "0.6.0", true, unfinished)).toBe("resume-notice");
	});

	it("opens nothing when there is nothing to read and nothing to finish", () => {
		expect(shouldOpenOnStartup("0.5.0", "0.5.0", true, finished)).toBeNull();
		expect(shouldOpenOnStartup("0.5.0", "0.6.0", true, finished)).toBeNull();
		expect(shouldOpenOnStartup("0.5.0", "0.5.0", true, null)).toBeNull();
	});

	it("opens nothing after an update when the user turned the guide off", () => {
		expect(shouldOpenOnStartup("0.4.0", "0.5.0", false, finished)).toBeNull();
		expect(shouldOpenOnStartup("0.4.0", "0.5.0", false, null)).toBeNull();
	});
});

describe("scenes", () => {
	it("has a scene for every step, and lists every scene once", () => {
		expect(Object.keys(STEP_SCENES).sort()).toEqual([...FIRST_STEPS, "whats-new"].sort());
		expect(new Set(ONBOARDING_SCENES).size).toBe(ONBOARDING_SCENES.length);
		for (const scenes of Object.values(STEP_SCENES)) {
			for (const scene of scenes) {
				expect(ONBOARDING_SCENES).toContain(scene);
			}
		}
	});

	it("points the steps at their own scenes", () => {
		expect(STEP_SCENES.about).toEqual(["overview"]);
		expect(STEP_SCENES.setup).toEqual(["install", "agents"]);
		expect(STEP_SCENES["first-session"]).toEqual(["new-session"]);
		expect(STEP_SCENES.tabs).toEqual(["side-panel"]);
		expect(STEP_SCENES.rename).toEqual(["row-menu", "move-category"]);
		expect(STEP_SCENES.editor).toEqual(["editor"]);
		expect(STEP_SCENES.more).toEqual(["restart", "organize", "manager"]);
		// The language step asks a question, and what's-new shows the scene each of its items carries.
		expect(STEP_SCENES.language).toEqual([]);
		expect(STEP_SCENES["whats-new"]).toEqual([]);
	});

	it("gives every what's-new item a scene that exists", () => {
		for (const items of Object.values(WHATS_NEW)) {
			for (const item of items) {
				expect(ONBOARDING_SCENES).toContain(item.scene);
			}
		}
	});
});

describe("onboardingImageUrl", () => {
	it("reads from the plugin's own tag, so a release shows the pictures it shipped with", () => {
		expect(onboardingImageUrl("overview", "en", "0.5.0")).toBe(
			"https://raw.githubusercontent.com/kulikala/obsidian-agent-sessions/0.5.0/docs/onboarding/en/overview.png"
		);
		expect(onboardingImageUrl("side-panel", "ja", "0.5.0")).toBe(
			"https://raw.githubusercontent.com/kulikala/obsidian-agent-sessions/0.5.0/docs/onboarding/ja/side-panel.png"
		);
	});

	it("reads from the given folder instead, with or without a trailing slash", () => {
		expect(onboardingImageUrl("editor", "en", "0.5.0", "file:///tmp/onboarding")).toBe(
			"file:///tmp/onboarding/en/editor.png"
		);
		expect(onboardingImageUrl("editor", "ja", "0.5.0", "file:///tmp/onboarding/")).toBe("file:///tmp/onboarding/ja/editor.png");
		expect(onboardingImageUrl("editor", "en", "0.5.0", "file:///tmp/onboarding///")).toBe("file:///tmp/onboarding/en/editor.png");
	});
});

describe("resolveAutoLanguage", () => {
	it("is Japanese for a Japanese Obsidian", () => {
		expect(resolveAutoLanguage("ja")).toBe("ja");
		expect(resolveAutoLanguage("ja-JP")).toBe("ja");
	});

	it("is English for anything else", () => {
		for (const lang of ["en", "de", "zh", "", "ja-JP-x", "japanese"]) {
			expect(resolveAutoLanguage(lang)).toBe("en");
		}
	});
});
