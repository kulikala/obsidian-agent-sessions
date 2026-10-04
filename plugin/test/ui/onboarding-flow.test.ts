import { describe, expect, it } from "vitest";
import {
	agentInstallHelp,
	canContinue,
	currentStep,
	guideAgent,
	imageFrameNext,
	isLastPage,
	skipIfUnavailable,
	startProgress,
	stepBack,
	stepForward,
} from "../../src/ui/onboarding-flow";
import { completeStep, skipStep, stepState, type OnboardingProgress } from "../../src/ui/onboarding-model";

const first = () => startProgress("first", { backendInstalled: true, whatsNew: false });
const at = (p: OnboardingProgress, step: string): OnboardingProgress => ({ ...p, current: p.steps.indexOf(step as never) });

describe("startProgress", () => {
	it("starts a first run at the language step with nothing done", () => {
		const p = first();
		expect(currentStep(p)).toBe("language");
		expect(p.states).toEqual({});
		expect(p.sessionId).toBeNull();
	});

	it("an update run starts at its first step", () => {
		const p = startProgress("update", { backendInstalled: false, whatsNew: true });
		expect(p.steps).toEqual(["setup", "whats-new"]);
		expect(currentStep(p)).toBe("setup");
	});
});

describe("stepForward / stepBack", () => {
	it("completes a read-and-ask step it leaves and moves on", () => {
		const next = stepForward(first());
		expect(stepState(next, "language")).toBe("done");
		expect(currentStep(next)).toBe("about");
	});

	it("leaves an operation step pending (only doing or skipping it ends it)", () => {
		const next = stepForward(at(first(), "first-session"));
		expect(stepState(next, "first-session")).toBe("pending");
	});

	it("jumps over steps that are already done or skipped", () => {
		let p = at(first(), "first-session");
		p = skipStep(p, "first-session");
		expect(currentStep(stepForward(p))).toBe("more");
	});

	it("stays on the last page", () => {
		const p = at(first(), "more");
		expect(isLastPage(p)).toBe(true);
		expect(currentStep(stepForward(p))).toBe("more");
	});

	it("goes back one step, and not past the first", () => {
		expect(currentStep(stepBack(at(first(), "about")))).toBe("language");
		expect(stepBack(first()).current).toBe(0);
	});

	it("a page with a pending step ahead is not the last", () => {
		expect(isLastPage(at(first(), "tabs"))).toBe(false);
	});
});

describe("skipIfUnavailable", () => {
	it("skips only the step this agent can't do", () => {
		const p = skipIfUnavailable(at(first(), "first-session"), "codex");
		expect(stepState(p, "first-session")).toBe("skipped");
		// Unlike a user's skip, the tab switch stays on the list for an agent that has it.
		expect(stepState(p, "tabs")).toBe("pending");
	});

	it("leaves Claude Code's steps and read-and-ask steps alone", () => {
		const p = at(first(), "rename");
		expect(skipIfUnavailable(p, "claude")).toBe(p);
		const about = at(first(), "about");
		expect(skipIfUnavailable(about, "opencode")).toBe(about);
	});

	it("does not undo a step that is already done", () => {
		const p = completeStep(at(first(), "editor"), "editor");
		expect(skipIfUnavailable(p, "codex")).toBe(p);
	});
});

describe("canContinue", () => {
	it("is true for a run with something pending, false for none or a finished one", () => {
		expect(canContinue(null)).toBe(false);
		expect(canContinue(first())).toBe(true);
		let p = first();
		for (const step of p.steps) {
			p = completeStep(p, step);
		}
		expect(canContinue(p)).toBe(false);
	});
});

describe("guideAgent", () => {
	const all = { claude: true, codex: true, opencode: true };
	it("uses the remembered agent when it is enabled here", () => {
		expect(guideAgent("codex", all, "darwin")).toBe("codex");
	});

	it("falls back to the first enabled agent that works on the platform", () => {
		expect(guideAgent("codex", { claude: false, codex: false, opencode: true }, "linux")).toBe("opencode");
		expect(guideAgent("codex", all, "win32")).toBe("claude");
	});

	it("is Claude Code when nothing is enabled", () => {
		expect(guideAgent("codex", { claude: false, codex: false, opencode: false }, "darwin")).toBe("claude");
	});
});

describe("agentInstallHelp", () => {
	it("gives a command and docs for every agent on macOS and Linux", () => {
		for (const platform of ["darwin", "linux"]) {
			for (const id of ["claude", "codex", "opencode"] as const) {
				const help = agentInstallHelp(id, platform);
				expect(help?.command).toBeTruthy();
				expect(help?.docsUrl).toMatch(/^https:\/\//);
			}
		}
	});

	it("gives none on Windows, which has its own WinGet button", () => {
		expect(agentInstallHelp("claude", "win32")).toBeNull();
	});
});

describe("imageFrameNext", () => {
	it("loads or fails from loading", () => {
		expect(imageFrameNext("loading", "load")).toBe("loaded");
		expect(imageFrameNext("loading", "error")).toBe("failed");
		expect(imageFrameNext("loading", "timeout")).toBe("failed");
	});

	it("a timeout after the picture loaded changes nothing", () => {
		expect(imageFrameNext("loaded", "timeout")).toBe("loaded");
	});

	it("a late load after giving up does not bring the picture back", () => {
		expect(imageFrameNext("failed", "load")).toBe("failed");
	});
});
