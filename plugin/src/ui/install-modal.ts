// The "Install agent-sessions" dialog: shows exactly what an install would do — where the
// program goes, which Python runs it, and what changes in Claude Code's settings — before
// anything is written, and runs `AgentSessionsPlugin.installBackend` only on confirmation.

import { App, Modal, Notice, Setting } from "obsidian";
import { skillFolders } from "../backend/agent-skills";
import { MIN_PYTHON, type InstallDirChoice, type PythonInfo, type UnsuitableReason } from "../backend/bundle";
import type { WingetPackage } from "../backend/windows";
import { t, type MessageKey } from "../i18n";
import type AgentSessionsPlugin from "../main";
import { AGENT_IDS } from "../settings";

const REASON_KEY: Record<UnsuitableReason, MessageKey> = {
	characters: "install.reason.characters",
	"in-vault": "install.reason.inVault",
	"not-writable": "install.reason.notWritable",
};

export class InstallBackendModal extends Modal {
	private installing = false;

	constructor(
		app: App,
		private plugin: AgentSessionsPlugin,
		private onDone?: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(t("install.title"));
		void this.check();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Looks for Python and a location (nothing is written), then shows the plan or what's missing. */
	private async check(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: t("install.checking") });
		const plan = await this.plugin.planBackendInstall();
		contentEl.empty();
		contentEl.createEl("p", { text: t("install.intro") });
		if (!plan.python) {
			this.renderNoPython();
			return;
		}
		if (!plan.location.dir) {
			this.renderNoLocation(plan.location);
			return;
		}
		this.renderPlan(plan.python, plan.location.dir);
	}

	private renderPlan(python: PythonInfo, dir: string): void {
		const { contentEl } = this;
		if (process.platform === "win32" && this.plugin.settings.agents.claude.enabled) {
			void this.renderClaudeOnWindows(contentEl.createDiv());
		}
		const list = contentEl.createEl("ul", { cls: "agent-sessions-install-plan" });
		const item = (label: string, value: string) => {
			const li = list.createEl("li");
			li.createSpan({ cls: "agent-sessions-install-label", text: label });
			li.createSpan({ text: value });
		};
		item(t("install.location"), dir);
		item(t("install.python"), t("install.pythonValue", { path: python.path, version: python.version }));
		item(
			t("install.hooks"),
			this.plugin.settings.agents.claude.enabled ? t("install.hooksValue") : t("install.hooksSkipped")
		);
		if (this.plugin.settings.agents.opencode.enabled) {
			item(t("install.opencode"), t("install.opencodeValue"));
		}
		const settings = this.plugin.settings;
		const folders = skillFolders(AGENT_IDS.filter((id) => settings.agents[id].enabled));
		item(
			t("install.skills"),
			folders.length > 0 ? t("install.skillsValue", { folders: folders.join(", ") }) : t("install.skillsSkipped")
		);
		const status = contentEl.createEl("p", { cls: "agent-sessions-install-status" });
		new Setting(contentEl)
			.addButton((button) => button.setButtonText(t("action.cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("action.install"))
					.setCta()
					.onClick(async () => {
						if (this.installing) {
							return;
						}
						this.installing = true;
						button.setDisabled(true);
						status.setText(t("install.running"));
						try {
							await this.plugin.installBackend(python, dir);
						} catch (err) {
							this.installing = false;
							button.setDisabled(false);
							status.setText(t("install.failed", { error: err instanceof Error ? err.message : String(err) }));
							return;
						}
						new Notice(t("install.done", { dir }));
						this.close();
						this.onDone?.();
					})
			);
	}

	private renderNoPython(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: t("install.noPython", { min: MIN_PYTHON.join(".") }) });
		if (process.platform === "win32") {
			contentEl.createEl("p", { text: t("install.noPython.windows") });
			this.renderWingetButton("python", () => void this.check());
			this.renderRetry();
			return;
		}
		contentEl.createEl("p", {
			text: t(process.platform === "darwin" ? "install.noPython.mac" : "install.noPython.linux"),
		});
		this.renderRetry();
	}

	/** Windows: whether Claude Code is there, with a WinGet button when it isn't. */
	private async renderClaudeOnWindows(el: HTMLElement): Promise<void> {
		const found = await this.plugin.findClaudeBinary();
		if (found) {
			return;
		}
		el.createEl("p", { text: t("install.claudeMissing") });
		this.renderWingetButton("claude", () => void this.check(), el);
	}

	/** A button that installs `pkg` with WinGet (per-user, no administrator prompt), then `after`. */
	private renderWingetButton(pkg: WingetPackage, after: () => void, el: HTMLElement = this.contentEl): void {
		const status = el.createEl("p", { cls: "agent-sessions-install-status" });
		new Setting(el).addButton((button) =>
			button
				.setButtonText(t(pkg === "python" ? "install.winget.python" : "install.winget.claude"))
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					status.setText(t("install.winget.running"));
					try {
						await this.plugin.wingetInstall(pkg);
					} catch (err) {
						button.setDisabled(false);
						const message = err instanceof Error ? err.message : String(err);
						status.setText(
							message === "winget-missing" ? t("install.winget.missing") : t("install.winget.failed", { error: message })
						);
						return;
					}
					after();
				})
		);
	}

	private renderNoLocation(location: InstallDirChoice): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: t("install.noLocation") });
		const list = contentEl.createEl("ul");
		for (const { dir, reason } of location.rejected) {
			list.createEl("li", { text: `${dir} — ${t(REASON_KEY[reason])}` });
		}
		contentEl.createEl("p", { text: t("install.noLocation.hint") });
		this.renderRetry();
	}

	private renderRetry(): void {
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("action.cancel")).onClick(() => this.close()))
			.addButton((button) => button.setButtonText(t("action.checkAgain")).onClick(() => void this.check()));
	}
}
