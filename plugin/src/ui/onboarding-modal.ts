// The welcome guide: a few pages shown on first install and after updates, and on demand
// (command, settings tab). It only presents; installing, enabling agents and the submit key go
// through the same `AgentSessionsPlugin` methods the install dialog and the settings tab use.

import { App, Modal, Platform, Setting, setIcon } from "obsidian";
import { detectAgents } from "../backend/backend";
import { t, type MessageKey } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { AGENT_IDS, SUBMIT_KEY_LABELS, submitKeyChoices, type AgentId, type SubmitKey } from "../settings";
import { editorKeyLabel } from "../terminal/keys";
import { AGENT_ICON_ID } from "./icons";
import {
	installPageState,
	ONBOARDING_PAGES,
	onboardingNav,
	stepPage,
	USAGE_ITEMS,
	type OnboardingPageId,
} from "./onboarding-model";

const AGENT_NAME_KEY: Record<AgentId, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
	opencode: "settings.agents.opencode.name",
};

const PAGE_HEADING_KEY: Record<OnboardingPageId, MessageKey> = {
	about: "onboarding.about.heading",
	usage: "onboarding.usage.heading",
	install: "onboarding.install.heading",
	settings: "onboarding.settings.heading",
};

export class OnboardingModal extends Modal {
	private index = 0;
	/** The agents' detection results, looked up once when the settings page is first reached. */
	private detected: Record<AgentId, string | null> | null = null;
	private detecting = false;

	constructor(
		app: App,
		private plugin: AgentSessionsPlugin
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("agent-sessions-onboarding");
		this.titleEl.setText(t("onboarding.title"));
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const nav = onboardingNav(this.index);
		const page = ONBOARDING_PAGES[this.index];

		const steps = contentEl.createDiv({ cls: "agent-sessions-onboarding-steps" });
		const dots = steps.createDiv({ cls: "agent-sessions-onboarding-dots" });
		ONBOARDING_PAGES.forEach((_, i) => {
			dots.createSpan({ cls: i === this.index ? "agent-sessions-onboarding-dot is-current" : "agent-sessions-onboarding-dot" });
		});
		steps.createSpan({ text: t("onboarding.step", { step: nav.step, total: nav.total }) });

		contentEl.createEl("h3", { cls: "agent-sessions-onboarding-heading", text: t(PAGE_HEADING_KEY[page]) });
		const body = contentEl.createDiv({ cls: "agent-sessions-onboarding-body" });
		switch (page) {
			case "about":
				this.renderAbout(body);
				break;
			case "usage":
				this.renderUsage(body);
				break;
			case "install":
				this.renderInstall(body);
				break;
			case "settings":
				this.renderSettings(body);
				break;
		}

		if (nav.isLast) {
			new Setting(contentEl)
				.setName(t("onboarding.afterUpdates"))
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.onboardingOnUpdate).onChange(async (value) => {
						this.plugin.settings.onboardingOnUpdate = value;
						await this.plugin.saveSettings();
					})
				);
		}

		const footer = new Setting(contentEl).setClass("agent-sessions-onboarding-footer");
		if (nav.hasBack) {
			footer.addButton((button) => button.setButtonText(t("action.back")).onClick(() => this.go(-1)));
		}
		footer.addButton((button) => {
			button.setCta();
			if (nav.isLast) {
				button.setButtonText(t("action.done")).onClick(() => this.close());
			} else {
				button.setButtonText(t("action.next")).onClick(() => this.go(1));
			}
		});
	}

	private go(delta: -1 | 1): void {
		this.index = stepPage(this.index, delta);
		this.render();
	}

	private renderAbout(body: HTMLElement): void {
		body.createEl("p", { cls: "agent-sessions-onboarding-lead", text: t("onboarding.about.lead") });
		const list = body.createEl("ul");
		for (const key of ["onboarding.about.tabs", "onboarding.about.daemon", "onboarding.about.panels"] as const) {
			list.createEl("li", { text: t(key) });
		}
	}

	private renderUsage(body: HTMLElement): void {
		const key = editorKeyLabel(this.plugin.settings.editorKey, Platform.isMacOS);
		for (const item of USAGE_ITEMS) {
			const row = body.createDiv({ cls: "agent-sessions-onboarding-item" });
			setIcon(row.createSpan({ cls: "agent-sessions-onboarding-item-icon" }), item.icon);
			const text = row.createDiv({ cls: "agent-sessions-onboarding-item-text" });
			text.createDiv({ cls: "agent-sessions-onboarding-item-title", text: t(item.title) });
			text.createDiv({ cls: "agent-sessions-onboarding-item-body", text: t(item.body, { key }) });
		}
	}

	private renderInstall(body: HTMLElement): void {
		body.createEl("p", { text: t("onboarding.install.desc") });
		const state = installPageState(this.plugin.backendAvailable(), this.plugin.agentSessionsPath());
		const setting = new Setting(body);
		if (state.kind === "installed") {
			setting.setName(t("onboarding.install.installed", { path: state.path }));
			setIcon(setting.nameEl.createSpan({ cls: "agent-sessions-onboarding-ok" }), "check");
			return;
		}
		setting.setName(t("onboarding.install.missing"));
		setting.addButton((button) =>
			button
				.setButtonText(t("action.installBackend"))
				.setCta()
				.onClick(() => this.plugin.openInstallBackend(() => this.render()))
		);
	}

	private renderSettings(body: HTMLElement): void {
		body.createEl("p", { text: t("onboarding.settings.desc") });
		if (!this.detected) {
			body.createEl("p", { cls: "agent-sessions-onboarding-muted", text: t("onboarding.settings.detecting") });
			void this.detect();
		}
		for (const id of AGENT_IDS) {
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
					}
				})
			);
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
	}

	/** Looks for the agents once, then redraws the page if it is still the one showing. */
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
		if (ONBOARDING_PAGES[this.index] === "settings") {
			this.render();
		}
	}
}
