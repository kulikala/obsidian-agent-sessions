import { ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { AgentSessionsSettings, DEFAULT_SETTINGS } from "./settings";

export const VIEW_TYPE_SIDE = "agent-sessions-side";
export const VIEW_TYPE_MANAGER = "agent-sessions-manager";
export const VIEW_TYPE_TERMINAL = "agent-sessions-terminal";

/** サイドパネル（§6.1）。中身は後続タスクで組む。 */
class SideView extends ItemView {
	getViewType(): string {
		return VIEW_TYPE_SIDE;
	}

	getDisplayText(): string {
		return "Agent Sessions";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-side");
		this.contentEl.setText("準備中");
	}
}

/** セッションマネージャー（§6.2）。中身は後続タスクで組む。 */
class ManagerView extends ItemView {
	getViewType(): string {
		return VIEW_TYPE_MANAGER;
	}

	getDisplayText(): string {
		return "セッションマネージャー";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-manager");
		this.contentEl.setText("準備中");
	}
}

/** ターミナル（§6.3）。中身は後続タスクで組む。 */
class TerminalView extends ItemView {
	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return "無題";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("agent-sessions-terminal");
		this.contentEl.setText("準備中");
	}
}

export default class AgentSessionsPlugin extends Plugin {
	settings: AgentSessionsSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_SIDE, (leaf) => new SideView(leaf));
		this.registerView(VIEW_TYPE_MANAGER, (leaf) => new ManagerView(leaf));
		this.registerView(VIEW_TYPE_TERMINAL, (leaf) => new TerminalView(leaf));

		this.addRibbonIcon("bot", "Agent Sessions", () => {
			void this.openSidePanel();
		});

		this.addCommand({
			id: "open-side-panel",
			name: "一覧を開く",
			callback: () => {
				void this.openSidePanel();
			},
		});

		this.addCommand({
			id: "open-manager",
			name: "セッションマネージャーを開く",
			callback: () => {
				void this.openManager();
			},
		});

		this.addCommand({
			id: "new-session",
			name: "新規セッション",
			callback: () => {
				new Notice("準備中");
			},
		});

		this.addCommand({
			id: "insert-note-at",
			name: "現在のノートを @ で挿入",
			callback: () => {
				new Notice("準備中");
			},
		});

		this.addSettingTab(new AgentSessionsSettingTab(this.app, this));
	}

	onunload(): void {
		// registerView の leaf は Obsidian が畳む。ここでは何もしない。
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async openSidePanel(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_SIDE)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_SIDE, active: true });
		workspace.revealLeaf(leaf);
	}

	private async openManager(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_MANAGER)[0];
		if (existing) {
			workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_MANAGER, active: true });
		workspace.revealLeaf(leaf);
	}
}

/** 設定タブの土台（§6.9）。Enter の役割（§6.8）は後続タスクで足す。 */
class AgentSessionsSettingTab extends PluginSettingTab {
	plugin: AgentSessionsPlugin;

	constructor(app: import("obsidian").App, plugin: AgentSessionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("フォント")
			.addText((text) =>
				text.setValue(this.plugin.settings.fontFamily).onChange(async (value) => {
					this.plugin.settings.fontFamily = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("フォントサイズ")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.fontSize)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 0) {
						this.plugin.settings.fontSize = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("余白")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ comfortable: "ゆったり", compact: "コンパクト", none: "なし" })
					.setValue(this.plugin.settings.padding)
					.onChange(async (value) => {
						this.plugin.settings.padding = value as AgentSessionsSettings["padding"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("最近の件数（サイドパネル）")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.recentCount)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 0) {
						this.plugin.settings.recentCount = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("指示待ちの通知")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.notifyOnIdle).onChange(async (value) => {
					this.plugin.settings.notifyOnIdle = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("claude のパス")
			.setDesc("空＝ログインシェルで command -v claude")
			.addText((text) =>
				text.setValue(this.plugin.settings.claudePath).onChange(async (value) => {
					this.plugin.settings.claudePath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("agent-sessions のパス")
			.setDesc("空＝~/bin/agent-sessions")
			.addText((text) =>
				text.setValue(this.plugin.settings.agentSessionsPath).onChange(async (value) => {
					this.plugin.settings.agentSessionsPath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Python のパス")
			.addText((text) =>
				text.setValue(this.plugin.settings.pythonPath).onChange(async (value) => {
					this.plugin.settings.pythonPath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("スクロールバック行数")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.scrollback)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 0) {
						this.plugin.settings.scrollback = n;
						await this.plugin.saveSettings();
					}
				})
			);
	}
}
