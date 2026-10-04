// The welcome guide's logic, kept free of `obsidian` so it can be tested in plain Node: when it is
// shown, which steps it has, how far the user got, what the install page reports, what's new and
// the screenshot scenes. The modal (`ui/onboarding-modal.ts`) only renders what this decides.

import type { MessageKey } from "../i18n";
import type { AgentId } from "../settings";

export type InstallPageState = { kind: "installed"; path: string } | { kind: "missing" };

/**
 * What the install page shows. The one place that decides it, so a platform with more
 * prerequisites (Windows) can extend the states here without touching the page's rendering.
 */
export function installPageState(backendAvailable: boolean, programPath: string): InstallPageState {
	return backendAvailable ? { kind: "installed", path: programPath } : { kind: "missing" };
}

// ---- The guide's steps ----

/** What the floating coach window (`ui/onboarding-coach.ts`) offers the guide: while an operation
 * step is being done the modal gets out of the way and the coach shows that step instead. */
export interface OnboardingCoach {
	/** Shows `step` (an operation step) in the coach. The guide's progress is already saved. */
	show(step: OnboardingStepId): void;
}

/** A step of the guide. `first-session` through `editor` are the ones it walks the user through on
 * its own session; the rest are read-and-ask steps. */
export type OnboardingStepId =
	| "language"
	| "about"
	| "setup"
	| "first-session"
	| "tabs"
	| "rename"
	| "editor"
	| "more"
	| "whats-new";

/** The steps the guide demonstrates on the session it starts: `sessions/onboarding-tracker.ts`
 * watches for these and ticks them off as the user does them. */
export const OPERATION_STEPS: readonly OnboardingStepId[] = ["first-session", "tabs", "rename", "editor"];

/** The steps that only mean something while that session exists: skipping the first session skips
 * them too, and a session that has since gone away puts them back. The same set as the operation
 * steps today, named apart because the two rules are about different things. */
export const SESSION_STEPS: readonly OnboardingStepId[] = OPERATION_STEPS;

/** What a step is at: still to do, done, or deliberately passed over (the guide then moves on to
 * the first step that is still pending). */
export type StepState = "pending" | "done" | "skipped";

/** The first-install run, top to bottom. */
const FIRST_STEPS: readonly OnboardingStepId[] = ["language", "about", "setup", ...OPERATION_STEPS, "more"];

/** Every step id, for validating saved progress. */
const ALL_STEP_IDS: readonly OnboardingStepId[] = [...FIRST_STEPS, "whats-new"];

/**
 * The steps a run of the guide goes through. An update run is only the steps that have something to
 * say: `setup` when agent-sessions isn't installed yet, `whats-new` when the version jumped over
 * something worth reading about. An empty list means there is nothing to open.
 */
export function onboardingSteps(
	mode: "first" | "update",
	opts: { backendInstalled: boolean; whatsNew: boolean }
): OnboardingStepId[] {
	if (mode === "first") {
		return [...FIRST_STEPS];
	}
	const steps: OnboardingStepId[] = [];
	if (!opts.backendInstalled) {
		steps.push("setup");
	}
	if (opts.whatsNew) {
		steps.push("whats-new");
	}
	return steps;
}

/**
 * Whether the guide offers `step` for a session run by `agent`. Only Claude Code has a run-through
 * of every operation step, so with Codex or OpenCode the tab switch — the one every agent has — is
 * kept and the rest is left out. The other steps are text and install checks, so they always apply.
 */
export function stepAvailableFor(step: OnboardingStepId, agent: AgentId): boolean {
	if (agent === "claude" || !OPERATION_STEPS.includes(step)) {
		return true;
	}
	return step === "tabs";
}

// ---- Progress ----

/** How far the guide got, saved in the settings (`onboardingProgress`) so it can pick up again
 * after a restart. `version` is what lets a future change tell an old record from a current one. */
export interface OnboardingProgress {
	version: 1;
	mode: "first" | "update";
	/** The steps of this run, in order. */
	steps: OnboardingStepId[];
	/** The step being shown, as an index into `steps`; `steps.length` once the run is through. */
	current: number;
	/** The state of each step the run has reached. A step with no entry is `pending`. */
	states: Partial<Record<OnboardingStepId, StepState>>;
	/** The session the operation steps are watched on, or `null` when there is none (nothing started
	 * yet, or the first session was skipped). */
	sessionId: string | null;
	/** Set once the guide's session has been moved to a category — the rename step mentions it, but
	 * a name is enough to move on. */
	renameCategoryDone?: boolean;
	/** Set once the startup notice offered to resume this run, so it is offered once, not on every
	 * start; opening the guide clears it. */
	resumeNoticed?: boolean;
	/** The id of the guide's tab when `sessionId` is the id a restarted agent process took over (the
	 * tab's own events are then reported under it). Absent when they are the same. */
	tabSessionId?: string;
}

function isStepId(value: unknown): value is OnboardingStepId {
	return typeof value === "string" && ALL_STEP_IDS.includes(value as OnboardingStepId);
}

function isStepState(value: unknown): value is StepState {
	return value === "pending" || value === "done" || value === "skipped";
}

/** The state of `step`: an unrecorded step is one still to do. */
export function stepState(p: OnboardingProgress, step: OnboardingStepId): StepState {
	return p.states[step] ?? "pending";
}

/** Whether every step of the run is done or skipped — nothing left to come back to. */
export function progressFinished(p: OnboardingProgress): boolean {
	return p.steps.every((step) => stepState(p, step) !== "pending");
}

/**
 * Checks saved progress read back from settings and returns a fresh, well-typed copy, or `null` for
 * anything that isn't a record this version wrote (wrong types, a step id or state that no longer
 * exists, a `current` outside the step list, a wrong `version`). The caller turns `null` into "no
 * progress", which starts the guide from the top — the one safe reading of a record we can't trust.
 * Never throws, whatever the saved JSON turns out to hold.
 */
export function sanitizeProgress(raw: unknown): OnboardingProgress | null {
	try {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return null;
		}
		const saved = raw as Record<string, unknown>;
		if (saved.version !== 1 || (saved.mode !== "first" && saved.mode !== "update")) {
			return null;
		}
		if (!Array.isArray(saved.steps)) {
			return null;
		}
		const steps: OnboardingStepId[] = [];
		for (const step of saved.steps) {
			if (!isStepId(step)) {
				return null;
			}
			steps.push(step);
		}
		const current = saved.current;
		// `steps.length` is in range: it is where the run ends up once every step is done or skipped.
		if (typeof current !== "number" || !Number.isInteger(current) || current < 0 || current > steps.length) {
			return null;
		}
		if (typeof saved.states !== "object" || saved.states === null || Array.isArray(saved.states)) {
			return null;
		}
		const states: Partial<Record<OnboardingStepId, StepState>> = {};
		for (const [step, state] of Object.entries(saved.states as Record<string, unknown>)) {
			if (!isStepId(step) || !isStepState(state)) {
				return null;
			}
			// A state for a step outside this run (left over from a longer list) is kept: nothing
			// reads it, so it costs nothing to leave alone.
			states[step] = state;
		}
		if (typeof saved.sessionId !== "string" && saved.sessionId !== null) {
			return null;
		}
		const progress: OnboardingProgress = {
			version: 1,
			mode: saved.mode,
			steps,
			current,
			states,
			sessionId: saved.sessionId,
		};
		if (typeof saved.tabSessionId === "string") {
			progress.tabSessionId = saved.tabSessionId;
		}
		if (typeof saved.renameCategoryDone === "boolean") {
			progress.renameCategoryDone = saved.renameCategoryDone;
		}
		if (typeof saved.resumeNoticed === "boolean") {
			progress.resumeNoticed = saved.resumeNoticed;
		}
		return progress;
	} catch {
		// Saved settings are arbitrary JSON, so a value that throws on its own property access
		// reads as "no progress" rather than breaking startup.
		return null;
	}
}

/**
 * `step` skipped, as a new record (nothing is mutated). Skipping the first session skips the steps
 * that need that session too, so the guide never asks for a tab switch or a rename on a session the
 * user chose not to start.
 */
export function skipStep(p: OnboardingProgress, step: OnboardingStepId): OnboardingProgress {
	const states: Partial<Record<OnboardingStepId, StepState>> = { ...p.states, [step]: "skipped" };
	if (step === "first-session") {
		for (const dependent of SESSION_STEPS) {
			if ((states[dependent] ?? "pending") === "pending") {
				states[dependent] = "skipped";
			}
		}
	}
	return { ...p, states };
}

/** `step` done, as a new record. */
export function completeStep(p: OnboardingProgress, step: OnboardingStepId): OnboardingProgress {
	return { ...p, states: { ...p.states, [step]: "done" } };
}

/**
 * Puts the guide back on its feet when it is picked up again. A session that has since gone away —
 * a restart, an archived row, a daemon that dropped it — means the steps that watched it have to be
 * asked again, so every step of this run's `SESSION_STEPS` that is neither done nor skipped goes
 * back to pending and the guide returns to `first-session`. Steps the user finished or skipped stay
 * as they are. Progress with no session (nothing started yet, or the first session was skipped) is
 * returned unchanged.
 */
export function resumeProgress(p: OnboardingProgress, sessionExists: (id: string) => boolean): OnboardingProgress {
	if (p.sessionId === null || sessionExists(p.sessionId)) {
		return p;
	}
	const states: Partial<Record<OnboardingStepId, StepState>> = { ...p.states };
	for (const step of SESSION_STEPS) {
		// Only the steps this run has: an update run has none of them, so there is nothing to reset
		// (and nothing to write into `states` for).
		if (p.steps.includes(step) && stepState(p, step) !== "done" && stepState(p, step) !== "skipped") {
			states[step] = "pending";
		}
	}
	// An update run has no first session to go back to, so its cursor stays where it is.
	const index = p.steps.indexOf("first-session");
	return { ...p, states, sessionId: null, current: index >= 0 ? index : p.current };
}

/**
 * Where to go after the step at `current`: the first step after it that is still pending, or
 * `steps.length` once there is none — which is how a finished run reads.
 */
export function nextIndex(p: OnboardingProgress): number {
	for (let i = p.current + 1; i < p.steps.length; i++) {
		if (stepState(p, p.steps[i]) === "pending") {
			return i;
		}
	}
	return p.steps.length;
}

// ---- What's new ----

/** One entry of the "what's new" step: what changed, and the screenshot that shows it. */
export interface WhatsNewItem {
	title: MessageKey;
	body: MessageKey;
	scene: OnboardingScene;
}

/**
 * What each version brought, keyed by the version that introduced it. `whatsNewSince` picks out the
 * entries a user hasn't seen, so an entry is added to the version that introduced the change and
 * left alone afterwards.
 */
export const WHATS_NEW: Record<string, readonly WhatsNewItem[]> = {
	"0.5.0": [{ title: "onboarding.whatsNew.guide.title", body: "onboarding.whatsNew.guide.body", scene: "overview" }],
};

/** `x.y.z` versions compared part by part as numbers, so 0.10.0 sorts above 0.9.0. A part that
 * isn't a number counts as 0, so a manifest version that isn't a plain triple compares rather than
 * throwing. */
function compareVersions(a: string, b: string): number {
	const part = (version: string, i: number): number => {
		const n = Number.parseInt(version.split(".")[i] ?? "", 10);
		return Number.isNaN(n) ? 0 : n;
	};
	for (let i = 0; i < 3; i++) {
		const diff = part(a, i) - part(b, i);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/**
 * The entries of every version after `shownVersion` and up to and including `current`, oldest
 * first. Empty for an empty `shownVersion`: a user who has never seen the guide gets the first-run
 * flow instead of a list of everything that ever changed.
 */
export function whatsNewSince(shownVersion: string, current: string): WhatsNewItem[] {
	if (shownVersion === "") {
		return [];
	}
	const items: WhatsNewItem[] = [];
	for (const version of Object.keys(WHATS_NEW).sort(compareVersions)) {
		if (compareVersions(shownVersion, version) < 0 && compareVersions(version, current) <= 0) {
			items.push(...WHATS_NEW[version]);
		}
	}
	return items;
}

/** What startup should do with the guide: `"first"` runs it from the top, `"update"` runs the
 * update flow for a version that has something to show, `"resume-notice"` asks whether to pick up an
 * unfinished run, and `null` opens nothing. */
export type OnboardingStart = "first" | "update" | "resume-notice" | null;

/**
 * Decides what startup does with the guide. It runs the first time (nothing recorded yet), and
 * after a version jump that has what's-new items to show while the user keeps "show this guide
 * after updates" on. Otherwise an unfinished run is worth a "continue?" and anything else stays
 * closed — including a version jump with nothing new to read, which falls through to the resume
 * notice rather than interrupting with an empty guide.
 */
export function shouldOpenOnStartup(
	shownVersion: string,
	current: string,
	onUpdate: boolean,
	progress: OnboardingProgress | null
): OnboardingStart {
	if (shownVersion === "") {
		return "first";
	}
	if (shownVersion !== current && onUpdate && whatsNewSince(shownVersion, current).length > 0) {
		return "update";
	}
	if (progress !== null && !progressFinished(progress) && !progress.resumeNoticed) {
		return "resume-notice";
	}
	return null;
}

// ---- Scenes and their screenshots ----

/** A screenshot the guide can show — one part of the app, captured per language. */
export type OnboardingScene =
	| "overview"
	| "install"
	| "agents"
	| "new-session"
	| "side-panel"
	| "row-menu"
	| "move-category"
	| "editor"
	| "restart"
	| "organize"
	| "manager";

export const ONBOARDING_SCENES: readonly OnboardingScene[] = [
	"overview",
	"install",
	"agents",
	"new-session",
	"side-panel",
	"row-menu",
	"move-category",
	"editor",
	"restart",
	"organize",
	"manager",
];

/** The scenes each step shows, in order. `language` and `whats-new` have none of their own: the
 * what's-new step shows the scene each of its items carries. */
export const STEP_SCENES: Record<OnboardingStepId, readonly OnboardingScene[]> = {
	language: [],
	about: ["overview"],
	setup: ["install", "agents"],
	"first-session": ["new-session"],
	tabs: ["side-panel"],
	rename: ["row-menu", "move-category"],
	editor: ["editor"],
	more: ["restart", "organize", "manager"],
	"whats-new": [],
};

const IMAGE_REPO_BASE = "https://raw.githubusercontent.com/kulikala/obsidian-agent-sessions";

/**
 * The URL of a scene's screenshot in `lang`. Without `base`, the copy on the plugin's own version
 * tag, so a release always shows the pictures that shipped with it; with one, that folder as it
 * stands, which is what a locally installed copy or a dev build points at.
 */
export function onboardingImageUrl(
	scene: OnboardingScene,
	lang: "en" | "ja",
	version: string,
	base?: string
): string {
	const folder = (base ?? `${IMAGE_REPO_BASE}/${version}/docs/onboarding`).replace(/\/+$/, "");
	return `${folder}/${lang}/${scene}.png`;
}

/**
 * The language the guide picks on its own: Japanese for a Japanese Obsidian, English for anything
 * else — the language step offers the two it has screenshots for.
 */
export function resolveAutoLanguage(obsidianLang: string): "en" | "ja" {
	const lang = obsidianLang.toLowerCase();
	return lang === "ja" || lang === "ja-jp" ? "ja" : "en";
}
