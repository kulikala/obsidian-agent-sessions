// The welcome guide: a run of steps (`onboarding-model.ts`) shown first on install, after an update
// that has something new, and on demand. It only presents; installing, enabling agents and the
// submit key go through the same `AgentSessionsPlugin` methods the install dialog and the settings
// tab use. Progress is saved to the settings after every change, so closing the modal keeps the place.
//
// The operation steps (first session, tabs, rename, editor) hand over to the floating coach window
// (`plugin.onboardingCoach`) when there is one; without it the modal shows them as pages itself.

import { App, getLanguage, Modal, Notice, Platform, Setting, setIcon } from "obsidian";
import { detectAgents } from "../backend/backend";
import { languageOptions, resolveLang, t, type LanguageSetting, type MessageKey } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { agentsSupportedOn, SUBMIT_KEY_LABELS, submitKeyChoices, type AgentId, type SubmitKey } from "../settings";
import { editorKeyLabel } from "../terminal/keys";
import { AGENT_ICON_ID } from "./icons";
import {
	agentInstallHelp,
	currentStep,
	isLastPage,
	OP_BODY_KEY,
	skipIfUnavailable,
	stepBack,
	STEP_HEADING_KEY,
	stepForward,
} from "./onboarding-flow";
import { renderPluginScene } from "./onboarding-image";
import {
	completeStep,
	installPageState,
	OPERATION_STEPS,
	skipStep,
	stepState,
	STEP_SCENES,
	type OnboardingProgress,
	type OnboardingScene,
	type OnboardingStepId,
	type WhatsNewItem,
} from "./onboarding-model";

const AGENT_NAME_KEY: Record<AgentId, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
	opencode: "settings.agents.opencode.name",
};

const MORE_ITEMS: readonly { icon: string; title: MessageKey; body: MessageKey; scene: OnboardingScene }[] = [
	{ icon: "rotate-cw", title: "onboarding.more.restart.title", body: "onboarding.more.restart.body", scene: "restart" },
	{ icon: "folder-input", title: "onboarding.more.organize.title", body: "onboarding.more.organize.body", scene: "organize" },
	{ icon: "gauge", title: "onboarding.more.manager.title", body: "onboarding.more.manager.body", scene: "manager" },
];

export interface OnboardingModalOptions {
	/** The run to show. */
	progress: OnboardingProgress;
	/** Whether changes are saved to the settings. False for an update run shown while an earlier,
	 * unfinished run is kept as it is (its "Continue the guide" button opens that one). */
	persist: boolean;
	/** An earlier unfinished run exists that this one left alone. */
	hasEarlierRun: boolean;
	/** What the `whats-new` step lists. */
	whatsNew: readonly WhatsNewItem[];
}

export class OnboardingModal extends Modal {
	private progress: OnboardingProgress;
	/** The agents' detection results, looked up when the setup step is first reached. */
	private detected: Record<AgentId, string | null> | null = null;
	private detecting = false;
	/** Operation steps started from this page (the coach, when there is one, does the rest). */
	private started = new Set<OnboardingStepId>();

	constructor(
		app: App,
		private plugin: AgentSessionsPlugin,
		private options: OnboardingModalOptions
	) {
		super(app);
		this.progress = options.progress;
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-onboarding");
		this.titleEl.setText(t("onboarding.title"));
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private setProgress(next: OnboardingProgress): void {
		this.progress = next;
		if (this.options.persist) {
			void this.plugin.saveOnboardingProgress(next);
		}
	}

	private agent(): AgentId {
		return this.plugin.onboardingAgent();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		// A step the guide's agent can't do is passed over where it is reached (and that is saved).
		const adjusted = skipIfUnavailable(this.progress, this.agent());
		if (adjusted !== this.progress) {
			this.setProgress(adjusted);
		}
		const p = this.progress;
		const step = currentStep(p);
		if (step === null) {
			this.finish();
			return;
		}

		const header = contentEl.createDiv({ cls: "agent-sessions-onboarding-steps" });
		const dots = header.createDiv({ cls: "agent-sessions-onboarding-dots" });
		p.steps.forEach((id, i) => {
			const dot = dots.createSpan({ cls: "agent-sessions-onboarding-dot" });
			dot.toggleClass("is-current", i === p.current);
			dot.toggleClass("is-done", stepState(p, id) !== "pending");
		});
		header.createSpan({ text: t("onboarding.step", { step: p.current + 1, total: p.steps.length }) });

		const heading = t(step === "language" ? "onboarding.language.heading" : STEP_HEADING_KEY[step]);
		contentEl.createEl("h3", { cls: "agent-sessions-onboarding-heading", text: heading });
		const body = contentEl.createDiv({ cls: "agent-sessions-onboarding-body" });
		switch (step) {
			case "language":
				this.renderLanguage(body);
				break;
			case "about":
				this.renderAbout(body);
				break;
			case "setup":
				this.renderSetup(body);
				break;
			case "more":
				this.renderMore(body);
				break;
			case "whats-new":
				this.renderWhatsNew(body);
				break;
			default:
				this.renderOperation(body, step);
		}

		const last = isLastPage(p);
		if (last && (step === "more" || step === "whats-new")) {
			new Setting(contentEl)
				.setName(t("onboarding.afterUpdates"))
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.onboardingOnUpdate).onChange(async (value) => {
						this.plugin.settings.onboardingOnUpdate = value;
						await this.plugin.saveSettings();
					})
				);
		}

		const operation = OPERATION_STEPS.includes(step);
		const pending = stepState(p, step) === "pending";
		const footer = new Setting(contentEl).setClass("agent-sessions-onboarding-footer");
		if (p.current > 0) {
			footer.addButton((button) => button.setButtonText(t("action.back")).onClick(() => this.setStep(stepBack(this.progress))));
		}
		if (operation && pending) {
			footer.addButton((button) =>
				button.setButtonText(t("action.skip")).onClick(() => this.setStep(stepForward(skipStep(this.progress, step))))
			);
		}
		footer.addButton((button) => {
			button.setCta();
			if (last) {
				button.setButtonText(t("action.finishGuide")).onClick(() => this.finish());
				return;
			}
			button.setButtonText(t("action.next")).onClick(() => this.next(step));
			if (operation && pending && (this.plugin.onboardingCoach || !this.hasStarted(step))) {
				button.setDisabled(true);
			}
		});
	}

	private hasStarted(step: OnboardingStepId): boolean {
		return this.started.has(step) || (step === "first-session" && this.progress.sessionId !== null);
	}

	private setStep(next: OnboardingProgress): void {
		this.setProgress(next);
		this.render();
	}

	/** Next. An operation step is done by the user doing it (the coach window watches for that); only
	 * without a coach does starting it count as doing it. */
	private next(step: OnboardingStepId): void {
		let p = this.progress;
		if (!this.plugin.onboardingCoach && OPERATION_STEPS.includes(step) && stepState(p, step) === "pending" && this.hasStarted(step)) {
			p = completeStep(p, step);
		}
		this.setStep(stepForward(p));
	}

	/** The run is through (or the user ended it): its record goes, and so does the modal. */
	private finish(): void {
		if (this.options.persist) {
			void this.plugin.saveOnboardingProgress(null);
		}
		this.close();
	}

	// ---- Pictures ----

	private image(parent: HTMLElement, scene: OnboardingScene): void {
		renderPluginScene(parent, this.plugin, scene, () => this.render());
	}

	// ---- Steps ----

	private renderLanguage(body: HTMLElement): void {
		const options = languageOptions();
		const resolved = resolveLang("auto", getLanguage());
		const choices: [LanguageSetting, string][] = [
			["auto", t("onboarding.language.auto", { language: options[resolved] })],
			["en", options.en],
			["ja", options.ja],
		];
		body.addClass("is-compact");
		body.createEl("p", { text: t("onboarding.language.desc") });
		new Setting(body).setName(t("settings.language.name")).addDropdown((dropdown) => {
			for (const [value, label] of choices) {
				dropdown.addOption(value, label);
			}
			dropdown.setValue(this.plugin.settings.language).onChange((value) => void this.chooseLanguage(value as LanguageSetting));
		});
	}

	private async chooseLanguage(value: LanguageSetting): Promise<void> {
		this.plugin.settings.language = value;
		this.plugin.applyLanguage();
		await this.plugin.saveSettings();
		this.titleEl.setText(t("onboarding.title"));
		this.render();
	}

	private renderAbout(body: HTMLElement): void {
		body.createEl("p", { cls: "agent-sessions-onboarding-lead", text: t("onboarding.about.lead") });
		const list = body.createEl("ul");
		for (const key of ["onboarding.about.tabs", "onboarding.about.daemon", "onboarding.about.panels"] as const) {
			list.createEl("li", { text: t(key) });
		}
		this.image(body, "overview");
	}

	private renderSetup(body: HTMLElement): void {
		body.createEl("p", { text: t("onboarding.install.desc") });
		const state = installPageState(this.plugin.backendAvailable(), this.plugin.agentSessionsPath());
		const program = new Setting(body).setName(t("onboarding.setup.program"));
		if (state.kind === "installed") {
			program.setDesc(t("onboarding.install.installed", { path: state.path }));
			setIcon(program.nameEl.createSpan({ cls: "agent-sessions-onboarding-ok" }), "check");
		} else {
			program.setDesc(t("onboarding.install.missing"));
			program.addButton((button) =>
				button
					.setButtonText(t("action.installBackend"))
					.setCta()
					.onClick(() => this.plugin.openInstallBackend(() => this.render()))
			);
		}
		this.image(body, "install");

		if (process.platform === "win32") {
			void this.renderClaudeOnWindows(body.createDiv());
		}
		if (!this.detected) {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.settings.detecting") });
			void this.detect();
		}
		body.createEl("p", { text: t("onboarding.settings.desc") });
		let anyHelp = false;
		for (const id of agentsSupportedOn(process.platform)) {
			const setting = new Setting(body);
			setIcon(setting.nameEl.createSpan({ cls: "agent-sessions-settings-agent-icon" }), AGENT_ICON_ID[id]);
			setting.nameEl.createSpan({ text: t(AGENT_NAME_KEY[id]) });
			const found = this.detected?.[id];
			if (found !== undefined) {
				setting.setDesc(found ? t("settings.agents.detected.found", { path: found }) : t("settings.agents.detected.notFound"));
			}
			setting.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.agents[id].enabled).onChange(async (value) => {
					if (!(await this.plugin.setAgentEnabled(id, value))) {
						toggle.setValue(true);
						return;
					}
					this.render();
				})
			);
			// Windows has the WinGet button above; elsewhere a missing agent gets the vendor's own command.
			if (found === null && (id === "claude" || this.plugin.settings.agents[id].enabled)) {
				anyHelp = this.renderInstallHelp(body, id) || anyHelp;
			}
		}
		if (anyHelp) {
			new Setting(body).addButton((button) =>
				button.setButtonText(t("onboarding.setup.detectAgain")).onClick(() => {
					this.detected = null;
					this.render();
				})
			);
		}

		const agents = this.plugin.settings.agents;
		const usable = agentsSupportedOn(process.platform).filter((id) => agents[id].enabled);
		if (usable.length > 1) {
			new Setting(body)
				.setName(t("onboarding.setup.agentForGuide"))
				.setDesc(t("onboarding.setup.agentForGuide.desc"))
				.addDropdown((dropdown) => {
					for (const id of usable) {
						dropdown.addOption(id, t(AGENT_NAME_KEY[id]));
					}
					dropdown.setValue(this.agent()).onChange(async (value) => {
						this.plugin.settings.lastNewSessionAgent = value as AgentId;
						await this.plugin.saveSettings();
					});
				});
		}

		const submit = new Setting(body).setName(t("settings.submitKey.name")).setDesc(t("onboarding.settings.submitKey.desc"));
		submit.addDropdown((dropdown) => {
			for (const key of submitKeyChoices(Platform.isMacOS)) {
				dropdown.addOption(key, SUBMIT_KEY_LABELS[key]);
			}
			dropdown.setValue(this.plugin.settings.submitKey);
			dropdown.onChange((value) => {
				const current = this.plugin.settings.submitKey;
				if (!this.plugin.requestSubmitKey(value as SubmitKey, () => this.render())) {
					// Reverted until the confirmation applies it (the page redraws then).
					dropdown.setValue(current);
				}
			});
		});
		this.image(body, "agents");
	}

	/** The official install command for a missing agent (macOS, Linux), with a Copy button and the
	 * docs. Nothing is run. Returns whether anything was shown. */
	private renderInstallHelp(body: HTMLElement, id: AgentId): boolean {
		const help = agentInstallHelp(id, process.platform);
		if (!help) {
			return false;
		}
		const box = body.createDiv({ cls: "agent-sessions-onboarding-install-help" });
		box.createEl("p", { text: t("onboarding.setup.notInstalled", { agent: t(AGENT_NAME_KEY[id]) }) });
		const row = box.createDiv({ cls: "agent-sessions-onboarding-command" });
		row.createEl("code", { text: help.command });
		row.createEl("button", { text: t("action.copy") }).addEventListener("click", () => {
			void navigator.clipboard.writeText(help.command);
			new Notice(t("onboarding.setup.copied"));
		});
		box.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.setup.pasteHint") });
		box.createEl("a", { cls: "external-link", text: t("onboarding.setup.docs"), href: help.docsUrl });
		return true;
	}

	/** Windows: Claude Code found, or a button installing it with WinGet (Python is offered by
	 * the install dialog itself). */
	private async renderClaudeOnWindows(el: HTMLElement): Promise<void> {
		const found = await this.plugin.findClaudeBinary();
		const setting = new Setting(el);
		if (found) {
			setting.setName(t("onboarding.install.claudeFound", { path: found }));
			setIcon(setting.nameEl.createSpan({ cls: "agent-sessions-onboarding-ok" }), "check");
			return;
		}
		setting.setName(t("install.claudeMissing"));
		setting.addButton((button) =>
			button.setButtonText(t("install.winget.claude")).onClick(async () => {
				button.setDisabled(true).setButtonText(t("install.winget.running"));
				try {
					await this.plugin.wingetInstall("claude");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(message === "winget-missing" ? t("install.winget.missing") : t("install.winget.failed", { error: message }));
				}
				this.render();
			})
		);
	}

	/** Looks for the agents, then redraws the page if it is still the setup step. */
	private async detect(): Promise<void> {
		if (this.detecting) {
			return;
		}
		this.detecting = true;
		try {
			this.detected = await detectAgents(Platform.isMacOS);
		} catch {
			this.detected = { claude: null, codex: null, opencode: null };
		} finally {
			this.detecting = false;
		}
		if (currentStep(this.progress) === "setup") {
			this.render();
		}
	}

	/** An operation step as a page: what to do, the picture, and the Start / Skip actions. The coach
	 * window takes over after Start when there is one. */
	private renderOperation(body: HTMLElement, step: OnboardingStepId): void {
		const state = stepState(this.progress, step);
		if (state === "skipped" && !this.hasStarted(step)) {
			body.createEl("p", { text: t("onboarding.op.notAvailable") });
			return;
		}
		const key = editorKeyLabel(this.plugin.settings.editorKey, Platform.isMacOS);
		body.createEl("p", { cls: "agent-sessions-onboarding-lead", text: t(OP_BODY_KEY[step], { key }) });
		if (step === "rename") {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.op.rename.optional") });
		}
		for (const scene of STEP_SCENES[step]) {
			this.image(body, scene);
		}
		if (state !== "pending") {
			return;
		}
		if (step === "first-session") {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.op.startFirst") });
		}
		if (this.hasStarted(step) && !this.plugin.onboardingCoach) {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.op.started") });
			return;
		}
		new Setting(body).addButton((button) =>
			button
				.setButtonText(t("onboarding.op.start"))
				.setCta()
				.onClick(() => this.startOperation(step))
		);
	}

	/** Starts the guide's session if there is none yet (with no name, so nothing is typed into it),
	 * saves it in the progress, then hands the step to the coach or keeps the page. */
	private startOperation(step: OnboardingStepId): void {
		if (this.progress.sessionId === null) {
			const id = this.plugin.newSession(undefined, this.agent());
			if (id === undefined) {
				return;
			}
			this.setProgress({ ...this.progress, sessionId: id });
		}
		this.started.add(step);
		const coach = this.plugin.onboardingCoach;
		if (coach) {
			this.close();
			coach.show(step);
			return;
		}
		this.render();
	}

	private renderMore(body: HTMLElement): void {
		for (const item of MORE_ITEMS) {
			const row = body.createDiv({ cls: "agent-sessions-onboarding-item" });
			setIcon(row.createSpan({ cls: "agent-sessions-onboarding-item-icon" }), item.icon);
			const text = row.createDiv({ cls: "agent-sessions-onboarding-item-text" });
			text.createDiv({ cls: "agent-sessions-onboarding-item-title", text: t(item.title) });
			text.createDiv({ cls: "agent-sessions-onboarding-item-body", text: t(item.body) });
			this.image(text, item.scene);
		}
	}

	private renderWhatsNew(body: HTMLElement): void {
		for (const item of this.options.whatsNew) {
			const row = body.createDiv({ cls: "agent-sessions-onboarding-item" });
			const text = row.createDiv({ cls: "agent-sessions-onboarding-item-text" });
			text.createDiv({ cls: "agent-sessions-onboarding-item-title", text: t(item.title) });
			text.createDiv({ cls: "agent-sessions-onboarding-item-body", text: t(item.body) });
			this.image(text, item.scene);
		}
		if (this.options.hasEarlierRun) {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.whatsNew.continue") });
			new Setting(body).addButton((button) =>
				button
					.setButtonText(t("action.continueGuide"))
					.setCta()
					.onClick(() => {
						this.close();
						this.plugin.openOnboarding("continue");
					})
			);
		}
	}
}
