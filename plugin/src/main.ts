import { Events, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, type FileSystemAdapter } from "obsidian";
import { homedir } from "node:os";
import { join } from "node:path";
import { detail, live, resolveAgentSessionsPath, scan } from "./backend";
import { DaemonClient, defaultSockPath, ensureDaemon } from "./daemon-client";
import { SessionIndex } from "./index";
import { buildAtToken, selectionLineRange } from "./links";
import { ConfirmModal, NewSessionModal, RenameSessionModal } from "./modals";
import { SessionOpener, VIEW_TYPE_TERMINAL, type OpenSessionOptions } from "./open-session";
import { AgentSessionsSettings, DEFAULT_SETTINGS } from "./settings";
import { migrateFromMarkdown, StoreLockError, updateStore } from "./store";
import type { ArchivedSession } from "./types";
import { ManagerView, VIEW_TYPE_MANAGER } from "./views/manager";
import { SideView, VIEW_TYPE_SIDE } from "./views/side";
import { TerminalView } from "./views/terminal";

export { VIEW_TYPE_SIDE, VIEW_TYPE_MANAGER, VIEW_TYPE_TERMINAL };

const RUNTIME_DIR = join(homedir(), ".agents", "sessions");

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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

		// 旧 `claude-sessions.md` の取り込み（§3）。`sessions.json` が既にあれば何もしない。
		try {
			migrateFromMarkdown(join(this.vaultPath(), "claude-sessions.md"), this.storePath());
		} catch (err) {
			console.warn("agent-sessions: claude-sessions.md の取り込みに失敗", err);
		}

		this.index = new SessionIndex({
			scan: (only) => scan(this.agentSessionsPath(), only),
			live: () => live(this.agentSessionsPath()),
			detail: (id) => detail(this.agentSessionsPath(), id),
			storePath: this.storePath(),
			eventsLogPath: join(RUNTIME_DIR, "events.log"),
			sessionsDir: join(homedir(), ".claude", "sessions"),
			statusDir: join(RUNTIME_DIR, "status"),
		});
		this.app.workspace.onLayoutReady(() => {
			this.stopIndex = this.index.start();
		});
		this.opener = new SessionOpener<WorkspaceLeaf>(this.app.workspace);

		this.registerView(VIEW_TYPE_SIDE, (leaf) => new SideView(leaf, this));
		this.registerView(VIEW_TYPE_MANAGER, (leaf) => new ManagerView(leaf, this));
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
				void this.openManagerTab();
			},
		});

		this.addCommand({
			id: "new-session",
			name: "新規セッション",
			callback: () => {
				new NewSessionModal(this.app, (name) => this.newSession(name || undefined)).open();
			},
		});

		this.addCommand({
			id: "insert-note-at",
			name: "現在のノートを @ で挿入",
			callback: () => {
				this.insertNoteAt();
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

	/**
	 * アクティブなノートを `@path[#Lx-y] ` として、対象のターミナルへ書く（§6.7）。
	 * 対象は前面のターミナルビュー、無ければ開いているタブの最初。
	 */
	insertNoteAt(): void {
		const info = this.app.workspace.activeEditor;
		if (!info || !info.file) {
			new Notice("開いているノートがありません");
			return;
		}
		const file = info.file;
		const view = this.frontTerminalView();
		if (!view) {
			new Notice("開いているターミナルがありません");
			return;
		}
		const abs = join(this.vaultPath(), file.path);
		const range = info.editor ? selectionLineRange(info.editor) : undefined;
		const token = buildAtToken(abs, view.getCwd(), range);
		view.sendCommand(`@${token} `);
		view.focusTerminal();
	}

	/** 前面のターミナルビュー（タブが見えているもの）。無ければ開いているタブの最初。 */
	private frontTerminalView(): TerminalView | undefined {
		const views = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.map((leaf) => leaf.view)
			.filter((view): view is TerminalView => view instanceof TerminalView);
		return views.find((view) => view.containerEl.isShown()) ?? views[0];
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

	storePath(): string {
		return join(this.vaultPath(), ".agents", "sessions", "sessions.json");
	}

	/** マネージャーのタブを開く（無ければメインエリアに作る。あれば前面へ）。 */
	async openManagerTab(): Promise<WorkspaceLeaf> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_MANAGER)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return existing;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_MANAGER, active: true });
		await workspace.revealLeaf(leaf);
		return leaf;
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

	// ---- セッションの操作（§6.6）。`updateStore` の `StoreLockError` はここで Notice にする（§7）。 --------

	/** 新規セッション：uuid を作り `sessions.json` に控えてからタブを開く。 */
	newSession(name?: string): void {
		const id = crypto.randomUUID();
		const cwd = this.vaultPath();
		try {
			updateStore(this.storePath(), (store) => {
				store.sessions[id] = { agent: "claude", cwd };
				if (name) {
					store.pendingRenames[id] = name;
				}
			});
		} catch (err) {
			this.notifyLockError(err);
			return;
		}
		this.index.refreshStore();
		void this.openSession(id, { agent: "claude", cwd, fresh: true });
	}

	/** 名前を変更：待機中なら PTY へ `/rename`、そうでなければ `pendingRenames`（§6.6）。 */
	async renameSession(id: string, name: string): Promise<void> {
		const row = this.index.sessions.get(id);
		if (row && row.daemon && row.status === "idle") {
			try {
				await this.sendToPty(id, `/rename ${name}\r`);
			} catch (err) {
				new Notice(`名前の変更に失敗しました: ${messageOf(err)}`);
			}
			return;
		}
		try {
			updateStore(this.storePath(), (store) => {
				store.pendingRenames[id] = name;
			});
			this.index.refreshStore();
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	/** 圧縮：待機中でなければ送らず `Notice`（§6.6）。 */
	async compactSession(id: string): Promise<void> {
		const row = this.index.sessions.get(id);
		if (!row || !row.daemon || row.status !== "idle") {
			new Notice("圧縮は待機中でないと送れません");
			return;
		}
		try {
			await this.sendToPty(id, "/compact\r");
		} catch (err) {
			new Notice(`圧縮に失敗しました: ${messageOf(err)}`);
		}
	}

	/** セッションを終了：確認 → `kill`。 */
	endSession(id: string): void {
		new ConfirmModal(this.app, "このセッションを終了しますか？", "終了する", () => {
			void (async () => {
				let client: DaemonClient | null = null;
				try {
					client = await ensureDaemon(this.sockPath(), this.agentSessionsPath());
					await client.hello("plugin");
					await client.kill(id);
				} catch (err) {
					new Notice(`終了に失敗しました: ${messageOf(err)}`);
				} finally {
					client?.close();
				}
			})();
		}).open();
	}

	archive(id: string, name: string, agent: string): void {
		try {
			updateStore(this.storePath(), (store) => {
				if (!store.archived.some((a) => a.id === id)) {
					const entry: ArchivedSession = { id, name, agent };
					store.archived.push(entry);
				}
			});
			this.index.refreshStore();
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	unarchive(id: string): void {
		try {
			updateStore(this.storePath(), (store) => {
				store.archived = store.archived.filter((a) => a.id !== id);
			});
			this.index.refreshStore();
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	setFolded(group: string, folded: boolean): void {
		try {
			updateStore(this.storePath(), (store) => {
				const has = store.folded.includes(group);
				if (folded && !has) {
					store.folded.push(group);
				} else if (!folded && has) {
					store.folded = store.folded.filter((g) => g !== group);
				}
			});
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	/** そのセッションのターミナルビューがあればその `sendCommand`、無ければ一時的に attach して書く（§6.6）。 */
	private async sendToPty(id: string, text: string): Promise<void> {
		const view = this.findTerminalView(id);
		if (view) {
			view.sendCommand(text);
			return;
		}
		const client = await ensureDaemon(this.sockPath(), this.agentSessionsPath());
		try {
			await client.hello("plugin");
			const res = await client.attach(id, 80, 24);
			if (!res.ok) {
				throw new Error(`attach に失敗: ${res.error ?? "unknown"}`);
			}
			client.writeInput(Buffer.from(text, "utf8"));
			await client.detach();
		} finally {
			client.close();
		}
	}

	private findTerminalView(id: string): TerminalView | undefined {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.map((leaf) => leaf.view)
			.filter((view): view is TerminalView => view instanceof TerminalView)
			.find((view) => view.sessionId === id);
	}

	private notifyLockError(err: unknown): void {
		if (err instanceof StoreLockError) {
			new Notice("sessions.json のロックが取れません。少し待って再試行してください");
			return;
		}
		new Notice(`sessions.json の更新に失敗しました: ${messageOf(err)}`);
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
