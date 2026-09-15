import { Events, ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, type FileSystemAdapter } from "obsidian";
import { homedir } from "node:os";
import { join } from "node:path";
import { detail, live, resolveAgentSessionsPath, scan } from "./backend";
import { defaultSockPath } from "./daemon-client";
import { SessionIndex } from "./index";
import { SessionOpener, VIEW_TYPE_TERMINAL, type OpenSessionOptions } from "./open-session";
import { AgentSessionsSettings, DEFAULT_SETTINGS } from "./settings";
import { TerminalView } from "./views/terminal";

export const VIEW_TYPE_SIDE = "agent-sessions-side";
export const VIEW_TYPE_MANAGER = "agent-sessions-manager";
export { VIEW_TYPE_TERMINAL };

const RUNTIME_DIR = join(homedir(), ".agents", "sessions");

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

export default class AgentSessionsPlugin extends Plugin {
	settings: AgentSessionsSettings = DEFAULT_SETTINGS;
	/** プラグイン内のイベント（`settings-changed`）。 */
	events = new Events();
	/** 走査結果＋起動中＋タブの合成。`registry`・`statusline` もこの中に 1 つずつ。 */
	index!: SessionIndex;
	private stopIndex: (() => void) | null = null;
	private opener!: SessionOpener<WorkspaceLeaf>;
	/** `openSession` の進行中の呼出（§6.4）。 */
	get opening(): Map<string, Promise<WorkspaceLeaf>> {
		return this.opener.opening;
	}

	async onload(): Promise<void> {
		await this.loadSettings();

		this.index = new SessionIndex({
			scan: (only) => scan(this.agentSessionsPath(), only),
			live: () => live(this.agentSessionsPath()),
			detail: (id) => detail(this.agentSessionsPath(), id),
			storePath: join(this.vaultPath(), ".agents", "sessions", "sessions.json"),
			eventsLogPath: join(RUNTIME_DIR, "events.log"),
			sessionsDir: join(homedir(), ".claude", "sessions"),
			statusDir: join(RUNTIME_DIR, "status"),
		});
		this.stopIndex = this.index.start();
		this.opener = new SessionOpener<WorkspaceLeaf>(this.app.workspace);

		this.registerView(VIEW_TYPE_SIDE, (leaf) => new SideView(leaf));
		this.registerView(VIEW_TYPE_MANAGER, (leaf) => new ManagerView(leaf));
		this.registerView(VIEW_TYPE_TERMINAL, (leaf) => new TerminalView(leaf, this));

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
		// registerView の leaf は Obsidian が畳む。
		this.stopIndex?.();
		this.stopIndex = null;
		this.index.dispose();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.events.trigger("settings-changed");
	}

	/** セッションのタブを開く（§6.4）。既にあれば前面に出すだけ。 */
	openSession(id: string, opts: OpenSessionOptions = {}): Promise<WorkspaceLeaf> {
		return this.opener.open(id, opts);
	}

	sockPath(): string {
		return defaultSockPath();
	}

	agentSessionsPath(): string {
		return resolveAgentSessionsPath(this.settings.agentSessionsPath);
	}

	vaultPath(): string {
		return (this.app.vault.adapter as FileSystemAdapter).getBasePath();
	}

	/** このプラグインの設定タブを開く。`app.setting` は公開型に無い。 */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
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
