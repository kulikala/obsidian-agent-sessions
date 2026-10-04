// What the welcome guide's modal does with its progress, kept free of `obsidian` so it can be tested
// in plain Node: starting a run, moving between steps, steps an agent can't do, the install command
// to show for a missing agent, and when a picture counts as not loading.

import type { MessageKey } from "../i18n";
import { AGENT_IDS, agentsSupportedOn, type AgentId } from "../settings";
import {
	completeStep,
	nextIndex,
	onboardingSteps,
	OPERATION_STEPS,
	progressFinished,
	stepAvailableFor,
	stepState,
	type OnboardingProgress,
	type OnboardingStepId,
} from "./onboarding-model";

/** A fresh run of the guide: at its first step, nothing done, no session. */
export function startProgress(
	mode: "first" | "update",
	opts: { backendInstalled: boolean; whatsNew: boolean }
): OnboardingProgress {
	return { version: 1, mode, steps: onboardingSteps(mode, opts), current: 0, states: {}, sessionId: null };
}

/** The step being shown, or `null` once the run is through. */
export function currentStep(p: OnboardingProgress): OnboardingStepId | null {
	return p.steps[p.current] ?? null;
}

/** Whether Next on this page ends the run (Finish takes its place): nothing pending lies ahead. */
export function isLastPage(p: OnboardingProgress): boolean {
	return nextIndex(p) >= p.steps.length;
}

/**
 * Next: the step being left counts as done when it is a read-and-ask step still pending (an
 * operation step is only ever done by the user doing it, or skipped), then the guide moves to the
 * first step still pending. At the end it stays on the last page.
 */
export function stepForward(p: OnboardingProgress): OnboardingProgress {
	const step = currentStep(p);
	const left = step !== null && stepState(p, step) === "pending" && !OPERATION_STEPS.includes(step) ? completeStep(p, step) : p;
	return { ...left, current: Math.min(nextIndex(left), Math.max(p.steps.length - 1, 0)) };
}

/** Back: the step just before the current one, whatever it was left at. */
export function stepBack(p: OnboardingProgress): OnboardingProgress {
	return { ...p, current: Math.max(p.current - 1, 0) };
}

/**
 * Marks the step being shown as skipped when it is an operation step this agent can't do. Only that
 * step: the steps after it that the agent can do (the tab switch with every agent) stay on the
 * list, unlike a skip the user chose on the first session, which takes its dependents along.
 */
export function skipIfUnavailable(p: OnboardingProgress, agent: AgentId): OnboardingProgress {
	const step = currentStep(p);
	if (step === null || stepState(p, step) !== "pending" || stepAvailableFor(step, agent)) {
		return p;
	}
	return { ...p, states: { ...p.states, [step]: "skipped" } };
}

/** Whether there is a run to pick up where it was left. */
export function canContinue(p: OnboardingProgress | null): p is OnboardingProgress {
	return p !== null && !progressFinished(p);
}

/**
 * The agent the guide's session runs: the one the new-session dialog remembers if it is enabled and
 * works on this platform, else the first enabled one that does, else Claude Code.
 */
export function guideAgent(
	last: AgentId,
	enabled: Readonly<Record<AgentId, boolean>>,
	platform: string
): AgentId {
	const usable = AGENT_IDS.filter((id) => enabled[id] && agentsSupportedOn(platform).includes(id));
	if (usable.includes(last)) {
		return last;
	}
	return usable[0] ?? "claude";
}

/** What to show for an agent that isn't installed on macOS or Linux: the vendor's own command, to be
 * pasted into a terminal by the user (the guide never runs it), and where its documentation is. */
export interface AgentInstallHelp {
	command: string;
	docsUrl: string;
}

const INSTALL_HELP: Record<AgentId, AgentInstallHelp> = {
	claude: { command: "curl -fsSL https://claude.ai/install.sh | bash", docsUrl: "https://code.claude.com/docs/en/setup" },
	codex: { command: "npm install -g @openai/codex", docsUrl: "https://github.com/openai/codex#readme" },
	opencode: { command: "curl -fsSL https://opencode.ai/install | bash", docsUrl: "https://opencode.ai/docs/" },
};

/** The install help for `agent` on `platform`, or `null` where the guide has its own button (Windows
 * installs Claude Code with WinGet) or no help to give. */
export function agentInstallHelp(agent: AgentId, platform: string): AgentInstallHelp | null {
	return platform === "darwin" || platform === "linux" ? INSTALL_HELP[agent] : null;
}

// ---- Pictures ----

/** How long a picture may take before the frame gives up on it. */
export const IMAGE_TIMEOUT_MS = 10_000;

export type ImageFrameState = "loading" | "loaded" | "failed";

/** What the picture's frame is at after `event`. A picture that already loaded stays loaded when the
 * timer fires; one that gave up stays given up if the network answers late, so the frame doesn't
 * flip back after the fallback text was read. */
export function imageFrameNext(state: ImageFrameState, event: "load" | "error" | "timeout"): ImageFrameState {
	if (state !== "loading") {
		return state;
	}
	return event === "load" ? "loaded" : "failed";
}

// ---- Text of the steps, shared by the modal and the coach window ----

/** The heading of each step but the language step, which is written in both languages. */
export const STEP_HEADING_KEY: Record<Exclude<OnboardingStepId, "language">, MessageKey> = {
	about: "onboarding.step.about",
	setup: "onboarding.step.setup",
	"first-session": "onboarding.step.first-session",
	tabs: "onboarding.step.tabs",
	rename: "onboarding.step.rename",
	editor: "onboarding.step.editor",
	more: "onboarding.step.more",
	"whats-new": "onboarding.step.whats-new",
};

/** What to do in each operation step (the editor's takes the editor key as `{key}`). */
export const OP_BODY_KEY: Record<string, MessageKey> = {
	"first-session": "onboarding.op.first-session",
	tabs: "onboarding.op.tabs",
	rename: "onboarding.op.rename",
	editor: "onboarding.op.editor",
};
