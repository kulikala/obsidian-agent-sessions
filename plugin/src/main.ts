import { Events, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, type FileSystemAdapter } from "obsidian";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detail, live, resolveAgentSessionsPath, scan } from "./backend";
import { DaemonClient, defaultSockPath, ensureDaemon } from "./daemon-client";
import { EditServer, type EditReply, type EditRequest } from "./edit-server";
import { SessionIndex } from "./index";
import { defaultKeybindingsPath, readEnterMode, setEnterMode } from "./keybindings";
import { buildAtToken, selectionLineRange } from "./links";
import { ConfirmModal, NewSessionModal, RenameSessionModal } from "./modals";
import { SessionOpener, VIEW_TYPE_TERMINAL, type OpenSessionOptions } from "./open-session";
import { AgentSessionsSettings, DEFAULT_SETTINGS } from "./settings";
import { migrateFromMarkdown, StoreLockError, updateStore } from "./store";
import type { ArchivedSession, DaemonSession } from "./types";
import { UsageModal } from "./usage-modal";
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
	/** `agent-sessions edit` からの要求を受けるソケット（D-21）。 */
	private editServer = new EditServer();
	/** 終了済みセッションの後始末（§6.5）のデバウンス。 */
	private cleanupExitedTimer: ReturnType<typeof setTimeout> | null = null;
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

		this.register(this.index.registry.onIdle((id) => this.notifyIdle(id)));
		this.register(
			this.index.onPendingRenameSend((items) => {
				for (const { id, name } of items) {
					void this.sendToPty(id, `/rename ${name}\r`).catch((err) => {
						new Notice(`名前の変更に失敗しました: ${messageOf(err)}`);
					});
				}
			})
		);
		this.register(this.index.onPendingRenameConfirmed((ids) => this.confirmPendingRenames(ids)));

		// 終了済みの後始末（§6.5）：タブの無い終了済みセッションに `forget` を送る。
		this.app.workspace.onLayoutReady(() => this.scheduleCleanupExited());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleCleanupExited()));

		this.editServer.onEdit((req, reply) => this.handleEdit(req, reply));
		this.editServer.start(this.pluginSockPath()).catch((err) => {
			console.warn("agent-sessions: plugin.sock を開けない", err);
		});

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
		// 進行中の編集は元の内容に戻して `cancel` を返し、それからソケットを閉じる（D-21）。
		for (const view of this.terminalViews()) {
			view.cancelEditor();
		}
		this.editServer.stop();
		// registerView の leaf は Obsidian が畳む。
		this.stopIndex?.();
		this.stopIndex = null;
		this.index.dispose();
		if (this.cleanupExitedTimer) {
			clearTimeout(this.cleanupExitedTimer);
			this.cleanupExitedTimer = null;
		}
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

	/** `agent-sessions edit` が繋ぐソケット（D-20）。 */
	pluginSockPath(): string {
		return join(RUNTIME_DIR, "plugin.sock");
	}

	/**
	 * `start` の `env` に入れる `VISUAL`（D-20）：設定 `agentSessionsPath` が空なら
	 * `~/bin/agent-sessions-code`、指定があればその隣の `agent-sessions-code`。
	 */
	visualPath(): string {
		const configured = this.settings.agentSessionsPath;
		return configured ? join(dirname(configured), "agent-sessions-code") : join(homedir(), "bin", "agent-sessions-code");
	}

	/**
	 * `edit` 要求（D-21）：セッションのターミナルビューを探し（無ければ `no-tab`）、編集領域を
	 * 開いて結果で応答する。claude 側が切れたら（`onAbort`）編集領域を閉じ、応答は返さない。
	 */
	private handleEdit(req: EditRequest, reply: EditReply): void {
		const view = this.findTerminalView(req.session);
		if (!view) {
			reply(false, "no-tab");
			return;
		}
		let aborted = false;
		req.onAbort = () => {
			aborted = true;
			view.abortEditor();
		};
		void view
			.openEditor(req.file, req.cwd)
			.then((result) => {
				if (aborted) {
					return;
				}
				if (result === "send") {
					reply(true);
				} else {
					reply(false, result);
				}
			})
			.catch((err) => {
				console.warn("agent-sessions: 編集領域を開けない", err);
				if (!aborted) {
					reply(false, "no-tab");
				}
			});
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

	/** トークン集計のモーダルを開く（D-31）。 */
	showUsage(id: string): void {
		const row = this.index.sessions.get(id);
		const name = row?.pendingRename || row?.name || row?.label || `無題 ${id.slice(0, 8)}`;
		new UsageModal(this.app, this.agentSessionsPath(), id, name).open();
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

	private terminalViews(): TerminalView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.map((leaf) => leaf.view)
			.filter((view): view is TerminalView => view instanceof TerminalView);
	}

	private findTerminalView(id: string): TerminalView | undefined {
		return this.terminalViews().find((view) => view.sessionId === id);
	}

	// ---- 通知・後始末（§6.5） -----------------------------------------------------

	/** `busy|shell → idle` で、そのタブが前面でないか Obsidian が非アクティブなら通知する。 */
	private notifyIdle(id: string): void {
		if (!this.settings.notifyOnIdle) {
			return;
		}
		const front = this.app.workspace.getActiveViewOfType(TerminalView);
		if (front?.sessionId === id && document.hasFocus()) {
			return;
		}
		const name = this.index.sessions.get(id)?.name ?? `無題 ${id.slice(0, 8)}`;
		const notice = new Notice(`${name}：指示待ち`, 8000);
		notice.noticeEl.addEventListener("click", () => void this.openSession(id));
	}

	/** 走査結果の名前が一致した未適用の名前変更を `pendingRenames` から消す（§6.6）。 */
	private confirmPendingRenames(ids: string[]): void {
		try {
			updateStore(this.storePath(), (store) => {
				for (const id of ids) {
					delete store.pendingRenames[id];
				}
			});
			this.index.refreshStore();
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	private scheduleCleanupExited(): void {
		if (this.cleanupExitedTimer) {
			clearTimeout(this.cleanupExitedTimer);
		}
		this.cleanupExitedTimer = setTimeout(() => {
			this.cleanupExitedTimer = null;
			void this.cleanupExited();
		}, 500);
	}

	/**
	 * 終了済み（`exited !== null`）のうちターミナルタブが無いセッションに `forget` を送る。
	 * デーモンに繋がらなければ何もしない（起動しない。§6.5）。
	 */
	private async cleanupExited(): Promise<void> {
		const client = new DaemonClient(this.sockPath());
		try {
			await client.connect();
		} catch {
			return;
		}
		try {
			await client.hello("plugin");
			const list = await client.list();
			const sessions = (list.sessions as DaemonSession[] | undefined) ?? [];
			const openIds = new Set(
				this.app.workspace
					.getLeavesOfType(VIEW_TYPE_TERMINAL)
					.map((leaf) => leaf.view)
					.filter((view): view is TerminalView => view instanceof TerminalView)
					.map((view) => view.sessionId)
			);
			for (const s of sessions) {
				if (s.exited !== null && !openIds.has(s.id)) {
					await client.forget(s.id).catch(() => undefined);
				}
			}
		} catch (err) {
			console.warn("agent-sessions: 終了済みの後始末に失敗", err);
		} finally {
			client.close();
		}
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

		this.renderEnterModeSetting(containerEl);

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
			.setName("編集領域の高さ（%）")
			.setDesc("Ctrl+G で開く内蔵エディタの高さ")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.editorHeight)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n >= 10 && n <= 90) {
						this.plugin.settings.editorHeight = n;
						await this.plugin.saveSettings();
					}
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

	private keybindingsPath(): string {
		return defaultKeybindingsPath(homedir(), process.env.CLAUDE_CONFIG_DIR);
	}

	/** Enter の役割（§6.8）。開くたびに `keybindings.json` を読んで現在値を出す。 */
	private renderEnterModeSetting(containerEl: HTMLElement): void {
		const keybindingsPath = this.keybindingsPath();
		const info = readEnterMode(keybindingsPath);
		const setting = new Setting(containerEl).setName("Enter の役割");

		if (info.mode === "unreadable") {
			setting.setDesc(`${keybindingsPath} が読めません。ここからは変更できません`);
			return;
		}
		if (info.mode === "custom") {
			setting.setDesc(`カスタム（${info.raw}）。ここからは変更できません`);
			return;
		}

		setting.setDesc("実体は keybindings.json。Claude Code 全体（他の端末の claude にも）に効きます。");
		setting.addDropdown((dropdown) => {
			dropdown.addOptions({ submit: "送信", newline: "改行" });
			dropdown.setValue(info.mode);
			dropdown.onChange((value) => {
				const next = value as "submit" | "newline";
				if (next === info.mode) {
					return;
				}
				new ConfirmModal(
					this.app,
					"Claude Code 全体に効きます（iTerm など他の端末の claude にも）。切り替えますか？",
					"切り替える",
					() => {
						const result = setEnterMode(keybindingsPath, next);
						new Notice(result.warning ?? "Enter の役割を切り替えました");
						this.display();
					}
				).open();
				// 確認が済むまでは見た目を戻しておく（確定したら display() で組み直す）。
				dropdown.setValue(info.mode);
			});
		});
	}
}
