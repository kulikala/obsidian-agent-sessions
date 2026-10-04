// The welcome guide's floating window: while the user does an operation step (first session, tabs,
// rename, editor) the modal gets out of the way and this small panel stays at the bottom right of the
// main window with what to do. It listens to the tracker (`sessions/onboarding-tracker.ts`) for the
// step to be done, ticks it, and moves on; when the last operation step is through it opens the
// guide's remaining page again. It never takes keyboard focus, so typing into the terminal carries on.

import { Platform, setIcon } from "obsidian";
import { t } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { hintDue, nameEvents, unansweredSince } from "../sessions/onboarding-watch";
import { initialTracker, track, type TrackerEvent, type TrackerState } from "../sessions/onboarding-tracker";
import { editorKeyLabel } from "../terminal/keys";
import { currentStep, OP_BODY_KEY, skipIfUnavailable, STEP_HEADING_KEY } from "./onboarding-flow";
import { renderPluginScene } from "./onboarding-image";
import {
	completeStep,
	nextIndex,
	OPERATION_STEPS,
	skipStep,
	STEP_SCENES,
	stepState,
	type OnboardingCoach,
	type OnboardingProgress,
	type OnboardingStepId,
} from "./onboarding-model";

/** The steps whose instructions point at the side panel. */
const SIDE_PANEL_STEPS: readonly OnboardingStepId[] = ["tabs", "rename"];
/** How long a finished step stays on screen, ticked, before the coach moves on. */
const ADVANCE_MS = 2000;
/** How often the unanswered-session clock is looked at. */
const HINT_POLL_MS = 5000;

export class OnboardingCoachWindow implements OnboardingCoach {
	private el: HTMLElement | null = null;
	private step: OnboardingStepId | null = null;
	private tracker: TrackerState = initialTracker(null);
	/** Kept across steps: whether the window is folded to its title bar. */
	private collapsed = false;
	private pictureOpen = false;
	private done = false;
	private categoryDone = false;
	private hint = false;
	private hintSince: number | null = null;
	private lastName: string | null = null;
	private position: { left: number; top: number } | null = null;
	private pollTimer: number | undefined;
	private advanceTimer: number | undefined;

	constructor(private plugin: AgentSessionsPlugin) {}

	/** Whether the window is up. */
	get visible(): boolean {
		return this.el !== null;
	}

	show(step: OnboardingStepId): void {
		const progress = this.plugin.settings.onboardingProgress;
		if (!progress || !OPERATION_STEPS.includes(step)) {
			return;
		}
		window.clearTimeout(this.advanceTimer);
		this.step = step;
		this.done = false;
		this.categoryDone = progress.renameCategoryDone === true && step === "rename";
		this.pictureOpen = false;
		this.hint = false;
		this.hintSince = null;
		this.startPolling();
		if (!SIDE_PANEL_STEPS.includes(step)) {
			this.begin(step, progress.sessionId);
			return;
		}
		// The steps that point at the side panel need it on screen (a new vault has the right sidebar
		// collapsed). It is revealed before the step is watched, so the leaf change this causes is not
		// taken for the user switching tabs.
		this.render();
		void this.plugin.openSidePanel().finally(() => {
			if (this.step === step) {
				this.begin(step, progress.sessionId);
			}
		});
	}

	private begin(step: OnboardingStepId, sessionId: string | null): void {
		this.watchSession(sessionId);
		this.render();
	}

	/** Starts watching `step` on `sessionId` (a new tracker, as the step starts over). */
	private watchSession(sessionId: string | null): void {
		this.lastName = sessionId ? (this.plugin.index.sessions.get(sessionId)?.name ?? null) : null;
		const base = initialTracker(sessionId);
		this.tracker = this.step ? track(base, { kind: "step-entered", step: this.step }).state : base;
	}

	/** An event the plugin noticed. Ignored unless a step is up. */
	feed(ev: TrackerEvent): void {
		if (this.step === null) {
			return;
		}
		// Once the step is done only a category move still counts: it ticks the optional item.
		if (this.done && !(this.step === "rename" && ev.kind === "category-changed")) {
			return;
		}
		const result = track(this.tracker, ev);
		this.tracker = result.state;
		if (result.categoryDone) {
			this.categoryDone = true;
			this.save((p) => ({ ...p, renameCategoryDone: true }));
			this.render();
		}
		if (result.done !== null && result.done === this.step) {
			this.finishStep(result.done);
		}
	}

	/** The index changed: a rename or category move of the guide's session shows up as a new name. */
	onIndexChange(): void {
		const id = this.tracker.sessionId;
		if (this.step === null || id === null) {
			return;
		}
		const next = this.plugin.index.sessions.get(id)?.name ?? null;
		const events = nameEvents(id, this.lastName, next);
		if (next !== null) {
			this.lastName = next;
		}
		for (const ev of events) {
			this.feed(ev);
		}
	}

	private save(update: (p: OnboardingProgress) => OnboardingProgress): OnboardingProgress | null {
		const progress = this.plugin.settings.onboardingProgress;
		if (!progress) {
			return null;
		}
		const next = update(progress);
		void this.plugin.saveOnboardingProgress(next);
		return next;
	}

	private finishStep(step: OnboardingStepId): void {
		this.done = true;
		this.save((p) => completeStep(p, step));
		this.render();
		window.clearTimeout(this.advanceTimer);
		this.advanceTimer = window.setTimeout(() => this.moveOn(), ADVANCE_MS);
	}

	private skip(): void {
		const step = this.step;
		if (step === null) {
			return;
		}
		this.save((p) => skipStep(p, step));
		this.moveOn();
	}

	/** To the next step that still has to be done: its window here when it is an operation step, else
	 * the guide's page for it. */
	private moveOn(): void {
		window.clearTimeout(this.advanceTimer);
		const progress = this.plugin.settings.onboardingProgress;
		if (!progress) {
			this.hide();
			return;
		}
		const agent = this.plugin.onboardingAgent();
		let p: OnboardingProgress = { ...progress, current: nextIndex(progress) };
		// A step this agent can't do is passed over, as the guide's own pages do.
		for (;;) {
			const step = currentStep(p);
			if (step === null || !OPERATION_STEPS.includes(step)) {
				break;
			}
			const adjusted = skipIfUnavailable(p, agent);
			if (adjusted === p) {
				break;
			}
			p = { ...adjusted, current: nextIndex(adjusted) };
		}
		void this.plugin.saveOnboardingProgress(p);
		const next = currentStep(p);
		if (next !== null && OPERATION_STEPS.includes(next)) {
			this.show(next);
			return;
		}
		this.hide();
		if (next === null) {
			void this.plugin.saveOnboardingProgress(null);
		} else {
			this.plugin.openOnboarding("continue");
		}
	}

	/** Starts the guide's session when a step that needs one comes up with none (the first session
	 * was one an agent can't track). */
	private startSession(): void {
		const id = this.plugin.newSession(undefined, this.plugin.onboardingAgent());
		if (id === undefined) {
			return;
		}
		this.save((p) => ({ ...p, sessionId: id }));
		this.watchSession(id);
		this.render();
	}

	// ---- The unanswered-session hint ----

	private startPolling(): void {
		window.clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.step !== "first-session") {
			return;
		}
		this.pollTimer = window.setInterval(() => this.poll(), HINT_POLL_MS);
	}

	private poll(): void {
		const id = this.tracker.sessionId;
		if (this.step !== "first-session" || this.done || id === null) {
			return;
		}
		const now = Date.now();
		this.hintSince = unansweredSince(this.hintSince, this.plugin.index.registry.get(id)?.status, now);
		const due = hintDue(this.hintSince, now);
		if (due !== this.hint) {
			this.hint = due;
			this.render();
		}
	}

	// ---- The window ----

	hide(): void {
		window.clearTimeout(this.advanceTimer);
		window.clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		this.el?.remove();
		this.el = null;
		this.step = null;
		this.tracker = { ...this.tracker, step: null };
	}

	/** Takes the window away for good (the plugin is unloading). */
	destroy(): void {
		this.hide();
	}

	private mount(): HTMLElement {
		if (this.el) {
			return this.el;
		}
		const el = document.body.createDiv({ cls: "agent-sessions-coach" });
		// Pressing anywhere on the window must not move the keyboard focus off the terminal.
		el.addEventListener("mousedown", (event) => event.preventDefault());
		this.el = el;
		return el;
	}

	private render(): void {
		const step = this.step;
		if (step === null) {
			return;
		}
		const el = this.mount();
		el.empty();
		el.toggleClass("is-collapsed", this.collapsed);
		this.applyPosition(el);

		const header = el.createDiv({ cls: "agent-sessions-coach-header" });
		this.makeDraggable(header, el);
		if (this.done) {
			setIcon(header.createSpan({ cls: "agent-sessions-coach-done-icon" }), "check");
		}
		header.createSpan({ cls: "agent-sessions-coach-title", text: t(STEP_HEADING_KEY[step as keyof typeof STEP_HEADING_KEY]) });
		const fold = header.createEl("button", {
			cls: "agent-sessions-coach-fold clickable-icon",
			attr: { "aria-label": t(this.collapsed ? "onboarding.coach.expand" : "onboarding.coach.collapse") },
		});
		setIcon(fold, this.collapsed ? "chevron-up" : "chevron-down");
		fold.addEventListener("click", () => {
			this.collapsed = !this.collapsed;
			this.render();
		});
		if (this.collapsed) {
			return;
		}

		const body = el.createDiv({ cls: "agent-sessions-coach-body" });
		const key = editorKeyLabel(this.plugin.settings.editorKey, Platform.isMacOS);
		body.createEl("p", { text: t(OP_BODY_KEY[step], { key }) });
		if (step === "first-session") {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.coach.firstRun") });
			if (this.hint && !this.done) {
				body.createEl("p", { cls: "agent-sessions-coach-hint", text: t("onboarding.coach.hint") });
			}
		}
		if (step === "rename") {
			const optional = body.createEl("p", { cls: "agent-sessions-onboarding-muted" });
			if (this.categoryDone) {
				setIcon(optional.createSpan({ cls: "agent-sessions-coach-done-icon" }), "check");
			}
			optional.createSpan({ text: t("onboarding.op.rename.optional") });
		}
		if (this.tracker.sessionId === null && !this.done) {
			new ButtonRow(body).add(t("onboarding.op.start"), () => this.startSession(), true);
		}

		const picture = body.createEl("button", {
			cls: "agent-sessions-coach-picture-toggle",
			text: t(this.pictureOpen ? "onboarding.coach.hidePicture" : "onboarding.coach.showPicture"),
		});
		picture.addEventListener("click", () => {
			this.pictureOpen = !this.pictureOpen;
			this.render();
		});
		if (this.pictureOpen) {
			for (const scene of STEP_SCENES[step]) {
				renderPluginScene(body, this.plugin, scene, () => this.render());
			}
		}

		const footer = el.createDiv({ cls: "agent-sessions-coach-footer" });
		footer.createSpan({
			cls: this.done ? "agent-sessions-coach-status is-done" : "agent-sessions-coach-status",
			text: this.done ? t("onboarding.coach.done") : t("onboarding.coach.waiting"),
		});
		const buttons = new ButtonRow(footer);
		if (!this.done) {
			buttons.add(t("action.skip"), () => this.skip());
		}
		buttons.add(t("onboarding.coach.close"), () => this.hide());
	}

	private applyPosition(el: HTMLElement): void {
		if (this.position) {
			el.style.left = `${this.position.left}px`;
			el.style.top = `${this.position.top}px`;
			el.style.right = "auto";
			el.style.bottom = "auto";
		}
	}

	/** Drag by the title bar; the window stays inside the main window. */
	private makeDraggable(handle: HTMLElement, el: HTMLElement): void {
		handle.addEventListener("pointerdown", (event) => {
			if ((event.target as HTMLElement).closest("button")) {
				return;
			}
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const dx = event.clientX - rect.left;
			const dy = event.clientY - rect.top;
			handle.setPointerCapture(event.pointerId);
			const move = (e: PointerEvent): void => {
				const left = Math.min(Math.max(e.clientX - dx, 0), Math.max(window.innerWidth - rect.width, 0));
				const top = Math.min(Math.max(e.clientY - dy, 0), Math.max(window.innerHeight - 40, 0));
				this.position = { left, top };
				this.applyPosition(el);
			};
			const up = (): void => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.removeEventListener("pointercancel", up);
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
			handle.addEventListener("pointercancel", up);
		});
	}
}

/** A row of small buttons. */
class ButtonRow {
	private row: HTMLElement;

	constructor(parent: HTMLElement) {
		this.row = parent.createDiv({ cls: "agent-sessions-coach-buttons" });
	}

	add(text: string, onClick: () => void, cta = false): void {
		const button = this.row.createEl("button", { text });
		button.toggleClass("mod-cta", cta);
		button.addEventListener("click", onClick);
	}
}
