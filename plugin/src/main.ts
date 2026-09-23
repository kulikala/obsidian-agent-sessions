import {
	Events,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
	setTooltip,
	WorkspaceLeaf,
	type FileSystemAdapter,
} from "obsidian";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detail, live, loginEnv, resolveAgentSessionsPath, resolveClaude, scan } from "./backend";
import { DaemonClient, defaultSockPath, ensureDaemon } from "./daemon-client";
import { EditServer, editReplyFor, submitsAfterEdit, type EditReply, type EditRequest } from "./edit-server";
import { SessionIndex } from "./index";
import { readObsidianLang, resolveLang, setLang, t } from "./i18n";
import { applySubmitKey, defaultKeybindingsPath, readChatBindings, readEnterMode } from "./keybindings";
import { reconcileSubmitKey, sendSequence } from "./keys";
import { buildAtToken, selectionLineRange } from "./links";
import { ConfirmModal, NewSessionModal, RenameSessionModal } from "./modals";
import { sessionDisplayName } from "./name";
import { SessionOpener, VIEW_TYPE_TERMINAL, type OpenSessionOptions } from "./open-session";
import { AgentSessionsSettings, DEFAULT_SETTINGS, mergeSettings, SUBMIT_KEYS, type SubmitKey } from "./settings";
import { migrateFromMarkdown, StoreLockError, updateStore } from "./store";
import {
	ALL_TERMINAL_STATUSES,
	higherPriorityStatus,
	rowTerminalStatus,
	STATUS_LABEL_KEY,
	TERMINAL_STATUS_ICON,
	terminalStatusClass,
	type TerminalStatus,
} from "./terminal-status";
import { claudeSettingsPath, readFullscreenTui } from "./tui-mode";
import type { ArchivedSession, DaemonSession } from "./types";
import { writeUiState } from "./ui-state";
import { UsageModal } from "./usage-modal";
import { ManagerView, VIEW_TYPE_MANAGER } from "./views/manager";
import { SideView, VIEW_TYPE_SIDE } from "./views/side";
import { TerminalView } from "./views/terminal";

export { VIEW_TYPE_SIDE, VIEW_TYPE_MANAGER, VIEW_TYPE_TERMINAL };

const RUNTIME_DIR = join(homedir(), ".agents", "sessions");
/** Ctrl+S＝Claude Code の `chat:stash`（下書きの退避。次の送信の後に Claude が自動で戻す。D-42）。 */
const STASH = "\x13";
/** bracketed paste の囲み。コマンドをこれで入れると `/` の補完が開かず一括で入る。 */
const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** 内蔵エディタの「送る」から送信列までの間（Claude が一時ファイルを読み戻すのを待つ。D-51）。 */
const SUBMIT_AFTER_EDIT_MS = 300;
/** `registry` の状態を待つ上限（D-42）。 */
const WAIT_IDLE_MS = 60000;
/** 送信後に `busy` を経るのを待つ上限。`/rename` のように busy にならないコマンドはここで諦める。 */
const WAIT_BUSY_MS = 10000;
/** 裏で起動したセッションの `/exit` から `exit` イベントまでの上限。 */
const WAIT_EXIT_MS = 30000;
/** 裏で起動するときの端末の大きさ（画面は無い）。 */
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 40;

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 送信列（§6.8・D-50）。`submitKey === 'enter'` なら `\r`、それ以外は Enter が改行に回って
 * いるので `\x1b\r`（meta+enter＝送信）。`views/terminal.ts` の `sendSubmit()`・D-42 の
 * コマンド送信・内蔵エディタの「送る」（D-51）から使う純関数。
 */
export function submitSequence(settings: AgentSessionsSettings): string {
	return sendSequence("submit", settings.submitKey);
}

export default class AgentSessionsPlugin extends Plugin {
	settings: AgentSessionsSettings = DEFAULT_SETTINGS;
	/** プラグイン内のイベント（`settings-changed`・`terminal-status`）。 */
	events = new Events();
	/** 走査結果＋起動中＋タブの合成。`registry`・`statusline` もこの中に 1 つずつ。 */
	index!: SessionIndex;
	/**
	 * 各セッションのターミナルタブの状態（D-66 追補）。行の印（サイド・マネージャー）が
	 * `resolveRowStatus` で読む。タブが無い id はここに無い（`refreshTerminalStatus` が消す）。
	 */
	terminalStatuses = new Map<string, TerminalStatus>();
	private stopIndex: (() => void) | null = null;
	private opener!: SessionOpener<WorkspaceLeaf>;
	/** `agent-sessions edit` からの要求を受けるソケット（D-21）。 */
	private editServer = new EditServer();
	/** 終了済みセッションの後始末（§6.5）のデバウンス。 */
	private cleanupExitedTimer: ReturnType<typeof setTimeout> | null = null;
	/** 最後に前面だった Markdown ビュー（§6.7・D-42）。ターミナルにフォーカスがあると `activeEditor` は null になるため。 */
	private lastMarkdown: MarkdownView | null = null;
	/** 裏で起動中のセッション（D-42 経路③）。`notifyIdle` の対象から外す。 */
	private headless = new Set<string>();
	/** Claude Code の `tui` が `fullscreen` か（起動時と `settings-changed` のたびに読み直す）。 */
	private fullscreenTui = false;
	/** `openSession` の進行中の呼出（§6.4）。 */
	get opening(): Map<string, Promise<WorkspaceLeaf>> {
		return this.opener.opening;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyLanguage();
		this.refreshTuiMode();
		this.registerEvent(this.events.on("settings-changed", () => this.refreshTuiMode()));
		// keybindings.json が既に改行キーを持っていれば（他のツール・ユーザーが手で書いた場合を
		// 含む）、プラグインの設定をそれに合わせる（§6.8・D-41 追補。keybindings.json 自体は書かない）。
		await this.syncSubmitKeyFromKeybindings();
		this.syncUiState();

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

		// 最後に前面だった Markdown ビューを覚える（`@` 挿入の対象。§6.7・D-42）。
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.lastMarkdown = leaf.view;
				}
			})
		);

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

		// deferred（復元直後などでまだ前面にしていない、TerminalView が読み込まれていない）
		// タブのアイコン・題名（D-66 追補 2・T-72）：ビューが無い間は `updateIcon()`・`updateHeader()`
		// が届かないので、ここでタブ見出しの DOM を直接、分かる範囲（`rowTerminalStatus`・
		// `Row.name`。台帳が無ければ `detached`・「無題」）で直す。`TerminalView` が読み込まれれば
		// `updateIcon()`・`refreshName()` が引き継ぐ。
		this.app.workspace.onLayoutReady(() => this.refreshDeferredTerminalTabs());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshDeferredTerminalTabs()));
		this.register(this.index.onChange(() => this.refreshDeferredTerminalTabs()));
		this.register(this.index.registry.onChange(() => this.refreshDeferredTerminalTabs()));

		this.addRibbonIcon("list-tree", "Agent Sessions", () => {
			void this.openSidePanel();
		});

		this.registerCommands();
		// コマンド名は言語が変わるたびに描き直す（同じ id で `addCommand` し直すと上書きされる）。
		this.registerEvent(this.events.on("settings-changed", () => this.registerCommands()));

		this.addSettingTab(new AgentSessionsSettingTab(this.app, this));
	}

	/** コマンドパレットの項目（§6.9・D-56）。言語が変わるたびに同じ id で呼び直し、名前を描き直す。 */
	private registerCommands(): void {
		this.addCommand({
			id: "open-side-panel",
			name: t("action.openSidePanel"),
			callback: () => {
				void this.openSidePanel();
			},
		});

		this.addCommand({
			id: "open-manager",
			name: t("action.sessionManager"),
			callback: () => {
				void this.openManagerTab();
			},
		});

		this.addCommand({
			id: "new-session",
			name: t("action.newSession"),
			callback: () => {
				new NewSessionModal(this, (name) => this.newSession(name || undefined)).open();
			},
		});

		this.addCommand({
			id: "insert-note-at",
			name: t("action.insertNoteAt"),
			callback: () => {
				this.insertNoteAt();
			},
		});
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
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.syncUiState();
		this.events.trigger("settings-changed");
	}

	/**
	 * 送信キーの記号を `ui.json` へ書く（T-71）。statusLine（Python 側の `format_status_line`）が
	 * 読む。`AGENT_SESSIONS_ID` で起動したセッションだけが付ける対象なので、ここでは無条件に書く。
	 */
	private syncUiState(): void {
		try {
			writeUiState(RUNTIME_DIR, this.settings.submitKey);
		} catch (err) {
			console.warn("agent-sessions: ui.json を書けない", err);
		}
	}

	/**
	 * 表示言語（§6.9・D-56）：設定の `language` と Obsidian の言語（`localStorage.language`）から
	 * `t()` の現在値を決める。`onload` の最初と、設定タブで言語を変えたときに呼ぶ
	 * （呼んだ後に `saveSettings()` すれば `settings-changed` で各ビューが描き直す）。
	 */
	applyLanguage(): void {
		setLang(resolveLang(this.settings.language, readObsidianLang()));
	}

	/** `keybindings.json` の置き場（§6.8）。`AgentSessionsSettingTab` もここを使う。 */
	keybindingsPath(): string {
		return defaultKeybindingsPath(homedir(), process.env.CLAUDE_CONFIG_DIR);
	}

	/**
	 * `keybindings.json` の `Chat` を読んで、設定の `submitKey` をそれに合わせる（§6.8・D-50）。
	 * `keybindings.json` 自体は書かない。変更したら `true` を返す（設定タブの「ファイルに
	 * 合わせる」ボタンからも呼ぶ）。
	 */
	async syncSubmitKeyFromKeybindings(): Promise<boolean> {
		const next = reconcileSubmitKey(readChatBindings(this.keybindingsPath()), this.settings.submitKey);
		if (next === this.settings.submitKey) {
			return false;
		}
		this.settings.submitKey = next;
		await this.saveSettings();
		return true;
	}

	/** セッションのタブを開く（§6.4）。既にあれば前面に出すだけ。 */
	openSession(id: string, opts: OpenSessionOptions = {}): Promise<WorkspaceLeaf> {
		return this.opener.open(id, opts);
	}

	/**
	 * Claude Code が全画面レイアウト（`~/.claude/settings.json` の `tui: "fullscreen"`）か。
	 * ターミナルのジャンプは、これが真ならマーカーではなく Claude のスクロールキーで動く（D-42）。
	 */
	isFullscreenTui(): boolean {
		return this.fullscreenTui;
	}

	private refreshTuiMode(): void {
		this.fullscreenTui = readFullscreenTui(claudeSettingsPath(homedir(), process.env.CLAUDE_CONFIG_DIR));
	}

	/**
	 * 最後に前面だった Markdown ビュー（§6.7・D-42）。閉じられていれば `null`。
	 * まだ何も前面になっていなければ、今アクティブな Markdown ビュー。
	 */
	lastMarkdownView(): MarkdownView | null {
		const alive = (view: MarkdownView | null): view is MarkdownView =>
			!!view && this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === view);
		if (alive(this.lastMarkdown)) {
			return this.lastMarkdown;
		}
		this.lastMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
		return this.lastMarkdown;
	}

	/**
	 * 最後に前面だったノートを `@path[#Lx-y] ` として、対象のターミナルへ書く（§6.7）。
	 * 対象は前面のターミナルビュー、無ければ開いているタブの最初。
	 */
	insertNoteAt(): void {
		const md = this.lastMarkdownView();
		if (!md || !md.file) {
			new Notice(t("notice.noActiveNote"));
			return;
		}
		const file = md.file;
		const view = this.frontTerminalView();
		if (!view) {
			new Notice(t("notice.noActiveTerminal"));
			return;
		}
		const abs = join(this.vaultPath(), file.path);
		const range = selectionLineRange(md.editor);
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
	 * `edit` 要求（D-21・D-51）：セッションのターミナルビューを探し（無ければ `no-tab`）、編集領域を
	 * 開いて結果で応答する。送る／入力欄に戻るは `ok`、取消（タブを閉じた）は `cancel`。
	 * 送るでプロンプト編集（`claude-prompt-*`）なら、Claude が読み戻すのを待って送信列を送る。
	 * claude 側が切れたら（`onAbort`）編集領域を閉じ、応答は返さない。
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
				const { ok, error } = editReplyFor(result);
				reply(ok, error);
				if (result === "send" && submitsAfterEdit(req.file)) {
					window.setTimeout(() => view.submitPrompt(), SUBMIT_AFTER_EDIT_MS);
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

	/**
	 * 新規セッション：uuid を作り `sessions.json` に控えてからタブを開く。名前があれば、
	 * タブの `start` で claude が `idle` になってから `/rename` を送る（D-42。未適用の控えは持たない）。
	 * 送った後は `index.waitForName` で `Row.name` に反映されるまで待つ（T-72。タブの題名は
	 * 反映され次第、購読側が自分で描き直す）。
	 */
	newSession(name?: string): void {
		const id = crypto.randomUUID();
		const cwd = this.vaultPath();
		try {
			updateStore(this.storePath(), (store) => {
				store.sessions[id] = { agent: "claude", cwd };
			});
		} catch (err) {
			this.notifyLockError(err);
			return;
		}
		this.index.refreshStore();
		const opened = this.openSession(id, { agent: "claude", cwd, fresh: true });
		if (!name) {
			return;
		}
		void opened
			.then(async () => {
				if (!(await this.index.registry.waitFor(id, "idle", WAIT_IDLE_MS))) {
					new Notice(t("notice.renameWaitFailed"));
					return;
				}
				await this.sendCommand(id, `/rename ${name}`);
				void this.index.waitForName(id, name);
			})
			.catch((err) => {
				new Notice(t("notice.renameFailed", { error: messageOf(err) }));
			});
	}

	/** 名前を変更：`/rename` を今すぐ送る（タブが無くても。§6.6・D-42）。 */
	async renameSession(id: string, name: string): Promise<void> {
		try {
			await this.sendCommand(id, `/rename ${name}`, t("progress.renaming"));
			// `/rename` はモデルを呼ばず events.log にも来ないので、`rescan` を明示的に
			// 繰り返して待つ（T-72）。タブの題名は `Row.name` が変わり次第、購読側が描き直す。
			void this.index.waitForName(id, name);
		} catch (err) {
			new Notice(t("notice.renameFailed", { error: messageOf(err) }));
		}
	}

	/**
	 * 直近の指示が `/compact` か（`json detail` の `last_command`。transcript を読むのは Python だけ、R-C5）。
	 * `index.getDetail` のキャッシュがあればそれ、無ければ取得する。
	 */
	async lastInstructionIsCompact(id: string): Promise<boolean> {
		try {
			return (await this.index.getDetail(id)).last_command === "/compact";
		} catch {
			return false;
		}
	}

	/** 圧縮：直近の指示が `/compact` なら何もしない。それ以外は `/compact` を送る（タブが無くても。D-42）。 */
	async compactSession(id: string): Promise<void> {
		if (await this.lastInstructionIsCompact(id)) {
			new Notice(t("notice.compactAlready"));
			return;
		}
		try {
			await this.sendCommand(id, "/compact", t("progress.compacting"));
		} catch (err) {
			new Notice(t("notice.compactFailed", { error: messageOf(err) }));
		}
	}

	// ---- コマンドの送信（D-42） ------------------------------------------------------
	//
	// `text`（`/rename NAME`・`/compact`）を、セッションの置かれ方に応じて 3 経路で送る。
	// 送り方はどの経路も同じ 1 列（`commandBytes`）：Ctrl+S（`chat:stash`。下書きがあれば退避、
	// 空なら何も起きない）→ bracketed paste でコマンド（`/` の補完を開かせず一括で入れる）→ 送信列。
	// 退避した下書きは、次の送信の後に Claude Code が自動で戻す（「Draft restored」）ので復元は送らない
	// ——送るとまた退避されてしまう。
	// ① タブがあり attach 済み：そのタブへ書く。
	// ② タブは無いがデーモンにある：一時的に attach して書く。
	// ③ デーモンに無い：裏で `start`（`--resume`）→ `idle` を待って書く → 応答が済んだら `/exit` → `forget`。

	/**
	 * コマンドを送る。`progress` は経路③（裏で起動）のときだけ `Notice` に出す。
	 * 失敗は例外（呼出側が `Notice` にする）。
	 */
	async sendCommand(id: string, text: string, progress = t("progress.sending")): Promise<void> {
		const view = this.findTerminalView(id);
		if (view?.isAttached()) {
			this.sendViaView(view, text);
			return;
		}
		const client = await ensureDaemon(this.sockPath(), this.agentSessionsPath());
		client.on("error", (err: Error) => console.warn("agent-sessions: socket", err));
		try {
			await client.hello("plugin");
			const list = await client.list();
			const sessions = (list.sessions as DaemonSession[] | undefined) ?? [];
			const existing = sessions.find((s) => s.id === id);
			if (existing && existing.exited === null) {
				await this.sendViaAttach(client, id, text);
			} else {
				if (existing) {
					await client.forget(id).catch(() => undefined);
				}
				await this.sendHeadless(client, id, text, progress);
			}
		} finally {
			client.close();
		}
	}

	/** 退避 → bracketed paste でコマンド → 送信列（`\r`、`submitKey !== 'enter'` なら `\x1b\r`）。 */
	private commandBytes(text: string): Buffer {
		return Buffer.from(STASH + PASTE_BEGIN + text + PASTE_END + submitSequence(this.settings), "utf8");
	}

	/** 経路①：そのタブへ書く。 */
	private sendViaView(view: TerminalView, text: string): void {
		view.sendBytes(this.commandBytes(text));
	}

	/** 経路②：一時的に attach して書く。 */
	private async sendViaAttach(client: DaemonClient, id: string, text: string): Promise<void> {
		const res = await client.attach(id, HEADLESS_COLS, HEADLESS_ROWS);
		if (!res.ok) {
			throw new Error(t("error.attachFailed", { error: res.error ?? "unknown" }));
		}
		try {
			client.writeInput(this.commandBytes(text));
		} finally {
			await client.detach().catch(() => undefined);
		}
	}

	/**
	 * 経路③：裏で起動して送り、済んだら終了する。進行は `Notice`。
	 * `idle` → 送信 → `busy` を経て `idle`（busy にならないコマンドは `WAIT_BUSY_MS` で見切る）
	 * → `/exit` → `exit` イベント → `forget`。
	 */
	private async sendHeadless(client: DaemonClient, id: string, text: string, progress: string): Promise<void> {
		const row = this.index.sessions.get(id);
		if (!row) {
			throw new Error(t("error.sessionNotFound"));
		}
		const notice = new Notice(progress, 0);
		this.headless.add(id);
		const exited = new Promise<void>((resolve) => {
			client.on("exit", (exitedId: string) => {
				if (exitedId === id) {
					resolve();
				}
			});
		});
		try {
			const claude = await resolveClaude(this.settings.claudePath);
			const env = { ...(await loginEnv()), VISUAL: this.visualPath() };
			const res = await client.start({
				id,
				agent: row.agent || "claude",
				cwd: row.cwd || this.vaultPath(),
				argv: [claude, "--resume", id],
				env,
				cols: HEADLESS_COLS,
				rows: HEADLESS_ROWS,
			});
			if (!res.ok) {
				throw new Error(t("error.startFailed", { error: res.error ?? "unknown" }));
			}
			const attached = await client.attach(id, HEADLESS_COLS, HEADLESS_ROWS);
			if (!attached.ok) {
				throw new Error(t("error.attachFailed", { error: attached.error ?? "unknown" }));
			}
			const registry = this.index.registry;
			if (!(await registry.waitFor(id, "idle", WAIT_IDLE_MS))) {
				throw new Error(t("error.claudeStartWaitFailed"));
			}
			client.writeInput(this.commandBytes(text));
			await registry.waitFor(id, "busy", WAIT_BUSY_MS);
			if (!(await registry.waitFor(id, "idle", WAIT_IDLE_MS))) {
				throw new Error(t("error.replyWaitFailed"));
			}
			client.writeInput(this.commandBytes("/exit"));
			const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), WAIT_EXIT_MS));
			if ((await Promise.race([exited, timeout])) === "timeout") {
				await client.kill(id).catch(() => undefined);
				await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
			}
			await client.detach().catch(() => undefined);
			await client.forget(id).catch(() => undefined);
			void this.index.rescan([id]);
		} finally {
			this.headless.delete(id);
			notice.hide();
		}
	}

	/** セッションを終了：確認 → `kill`。 */
	endSession(id: string): void {
		new ConfirmModal(this.app, t("confirm.endSession.message"), t("action.endSession"), () => {
			void (async () => {
				let client: DaemonClient | null = null;
				try {
					client = await ensureDaemon(this.sockPath(), this.agentSessionsPath());
					await client.hello("plugin");
					await client.kill(id);
				} catch (err) {
					new Notice(t("notice.endFailed", { error: messageOf(err) }));
				} finally {
					client?.close();
				}
			})();
		}).open();
	}

	/** セッション解析結果のモーダルを開く（D-31）。 */
	showUsage(id: string): void {
		const row = this.index.sessions.get(id);
		const name = row?.name || row?.label || t("common.untitled", { id: id.slice(0, 8) });
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

	private terminalViews(): TerminalView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_TERMINAL)
			.map((leaf) => leaf.view)
			.filter((view): view is TerminalView => view instanceof TerminalView);
	}

	private findTerminalView(id: string): TerminalView | undefined {
		return this.terminalViews().find((view) => view.sessionId === id);
	}

	/**
	 * `TerminalView` が状態を変えるたび（`updateIcon()`）・閉じたとき（`onClose()`）に呼ぶ
	 * （D-66 追補）。`id` の全ビュー（分割で複数あり得る）を見て、優先順の高い方を
	 * `terminalStatuses` に残す。ビューが 1 つも無ければ消す。行の印（サイド・
	 * マネージャー）はこの `terminal-status` イベントで更新する。
	 */
	refreshTerminalStatus(id: string): void {
		let combined: TerminalStatus | null = null;
		for (const view of this.terminalViews()) {
			if (view.sessionId !== id || !view.isOpen()) {
				continue;
			}
			const status = view.currentStatus();
			combined = combined ? higherPriorityStatus(combined, status) : status;
		}
		if (combined) {
			this.terminalStatuses.set(id, combined);
		} else {
			this.terminalStatuses.delete(id);
		}
		this.events.trigger("terminal-status", id);
	}

	/**
	 * deferred なタブ（`leaf.view` が `TerminalView` ではなく Obsidian の `DeferredView`。
	 * 復元直後でまだ前面にしていないタブがこれ）のアイコン・題名を直す（D-66 追補 2・T-72）。
	 * `TerminalView` はまだ無いので `updateIcon()`・`refreshName()` は使えず、
	 * `plugin.index.sessions` の `Row` から分かる範囲（状態は `rowTerminalStatus`・台帳すら
	 * 無ければ `detached`。名前は `Row.name`・無ければ `sessionDisplayName` の「無題 <id8>」）で決める。
	 *
	 * 直す先はそれぞれ 2 つ：
	 * 1. `leaf.view.icon`・`leaf.view.title`——`DeferredView` も `View`（公開型）のインスタンスで、
	 *    `icon: IconName` は公開のフィールド（`getIcon()` はこれを返すだけ）。`title` は公開の
	 *    型には無いが実際に持っている値で、`getDisplayText()` の代わりにここから読まれる。
	 *    どちらも古いままだと、`lucide-ghost`（Obsidian の既定）や「agent-sessions-terminal」
	 *    （`TerminalView` の `getViewType()`。最後に描かれたときの値が Obsidian の側で保存され、
	 *    `DeferredView` 生成時にそのまま入る）を返し続ける。
	 * 2. タブ見出しの DOM（アイコンは `agent-sessions-status-<status>` のクラス・tooltip・実際の
	 *    `<svg>`、題名は `.workspace-tab-header-inner-title` の文字）——1 を直すだけでは
	 *    Obsidian が自分から再描画してくれるとは限らないので、こちらも直接合わせておく。
	 */
	private refreshDeferredTerminalTabs(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			if (!leaf.isDeferred) {
				continue;
			}
			const state = leaf.getViewState().state as { id?: string } | undefined;
			const id = typeof state?.id === "string" ? state.id : "";
			const row = id ? this.index.sessions.get(id) : undefined;
			const status: TerminalStatus = row ? rowTerminalStatus(row) : "detached";
			const iconName = TERMINAL_STATUS_ICON[status];
			const name = sessionDisplayName(row?.name, id);

			leaf.view.icon = iconName;
			(leaf.view as unknown as { title?: string }).title = name;

			const headerEl = (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
			const titleEl = headerEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-title");
			if (titleEl) {
				titleEl.setText(name);
			}
			const iconEl = headerEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon");
			if (!iconEl) {
				continue;
			}
			setIcon(iconEl, iconName);
			for (const s of ALL_TERMINAL_STATUSES) {
				iconEl.toggleClass(terminalStatusClass(s), s === status);
			}
			setTooltip(iconEl, t(STATUS_LABEL_KEY[status]));
		}
	}

	// ---- 通知・後始末（§6.5） -----------------------------------------------------

	/** `busy|shell → idle` で、そのタブが前面でないか Obsidian が非アクティブなら通知する。 */
	private notifyIdle(id: string): void {
		if (!this.settings.notifyOnIdle || this.headless.has(id)) {
			return;
		}
		const front = this.app.workspace.getActiveViewOfType(TerminalView);
		if (front?.sessionId === id && document.hasFocus()) {
			return;
		}
		const name = this.index.sessions.get(id)?.name ?? t("common.untitled", { id: id.slice(0, 8) });
		const notice = new Notice(t("notice.waitingForInput", { name }), 8000);
		notice.noticeEl.addEventListener("click", () => void this.openSession(id));
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
			new Notice(t("notice.storeLocked"));
			return;
		}
		new Notice(t("notice.storeUpdateFailed", { error: messageOf(err) }));
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
			.setName(t("settings.font.name"))
			.addText((text) =>
				text.setValue(this.plugin.settings.fontFamily).onChange(async (value) => {
					this.plugin.settings.fontFamily = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settings.fontSize.name"))
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
			.setName(t("settings.padding.name"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						comfortable: t("settings.padding.comfortable"),
						compact: t("settings.padding.compact"),
						none: t("settings.padding.none"),
					})
					.setValue(this.plugin.settings.padding)
					.onChange(async (value) => {
						this.plugin.settings.padding = value as AgentSessionsSettings["padding"];
						await this.plugin.saveSettings();
					})
			);

		this.renderLanguageSetting(containerEl);
		this.renderSubmitKeySetting(containerEl);

		new Setting(containerEl)
			.setName(t("settings.recentCount.name"))
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
			.setName(t("settings.notifyOnIdle.name"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.notifyOnIdle).onChange(async (value) => {
					this.plugin.settings.notifyOnIdle = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settings.claudePath.name"))
			.setDesc(t("settings.claudePath.desc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.claudePath).onChange(async (value) => {
					this.plugin.settings.claudePath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settings.agentSessionsPath.name"))
			.setDesc(t("settings.agentSessionsPath.desc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.agentSessionsPath).onChange(async (value) => {
					this.plugin.settings.agentSessionsPath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settings.pythonPath.name"))
			.setDesc(t("settings.pythonPath.desc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.pythonPath).onChange(async (value) => {
					this.plugin.settings.pythonPath = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(t("settings.editorHeight.name"))
			.setDesc(t("settings.editorHeight.desc"))
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
			.setName(t("settings.scrollback.name"))
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

	/** 言語（§6.9・D-56）：自動／日本語／English。変えたら `setLang` → `saveSettings()`
	 * （`settings-changed` で各ビュー・このタブ自身が描き直す）。 */
	private renderLanguageSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.language.name"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						auto: t("settings.language.optionAuto"),
						ja: t("settings.language.optionJa"),
						en: t("settings.language.optionEn"),
					})
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value as AgentSessionsSettings["language"];
						this.plugin.applyLanguage();
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}

	private static readonly SUBMIT_KEY_LABELS: Record<SubmitKey, string> = {
		enter: "Enter",
		"shift+enter": "Shift+Enter",
		"ctrl+enter": "Ctrl+Enter",
		"alt+enter": "Option+Enter",
		"cmd+enter": "Cmd+Enter",
	};

	/** 現在の keybindings.json の Chat の enter の表示だけに使う（変更には使わない、§6.8）。 */
	private currentEnterBindingText(keybindingsPath: string): string {
		const info = readEnterMode(keybindingsPath);
		switch (info.mode) {
			case "unreadable":
				return t("settings.submitKey.currentUnreadable", { path: keybindingsPath });
			case "custom":
				return t("settings.submitKey.currentCustom", { raw: info.raw ?? "" });
			case "newline":
				return t("settings.submitKey.currentNewline");
			case "submit":
				return t("settings.submitKey.currentSubmit");
		}
	}

	/** 送信キー（§6.8・D-50）。開くたびに `keybindings.json` を読んで現在値を出す。 */
	private renderSubmitKeySetting(containerEl: HTMLElement): void {
		const keybindingsPath = this.plugin.keybindingsPath();

		const applyAndSave = (next: SubmitKey) => {
			const result = applySubmitKey(keybindingsPath, next);
			this.plugin.settings.submitKey = next;
			void this.plugin.saveSettings();
			if (result.warning) {
				new Notice(result.warning);
			}
			this.display();
		};

		const setting = new Setting(containerEl).setName(t("settings.submitKey.name"));
		setting.descEl.createDiv({
			text: t("settings.submitKey.desc"),
		});
		setting.descEl.createDiv({ text: this.currentEnterBindingText(keybindingsPath) });
		setting.addDropdown((dropdown) => {
			for (const key of SUBMIT_KEYS) {
				dropdown.addOption(key, AgentSessionsSettingTab.SUBMIT_KEY_LABELS[key]);
			}
			dropdown.setValue(this.plugin.settings.submitKey);
			dropdown.onChange((value) => {
				const next = value as SubmitKey;
				const current = this.plugin.settings.submitKey;
				if (next === current) {
					return;
				}
				if (next !== "enter") {
					new ConfirmModal(this.app, t("confirm.writeKeybindings.message"), t("action.write"), () =>
						applyAndSave(next)
					).open();
					// 確認が済むまでは見た目を戻しておく（確定したら display() で組み直す）。
					dropdown.setValue(current);
				} else {
					applyAndSave(next);
				}
			});
		});

		this.renderSubmitKeyMismatch(containerEl, keybindingsPath);
	}

	/**
	 * `keybindings.json` の `Chat.enter` と設定の `submitKey` が食い違っているとき
	 * （例：ファイルは `chat:newline` なのに設定は `enter` のまま）に警告を出す
	 * （§6.8・D-50）。「ファイルに合わせる」で `syncSubmitKeyFromKeybindings()` を実行する。
	 */
	private renderSubmitKeyMismatch(containerEl: HTMLElement, keybindingsPath: string): void {
		const info = readEnterMode(keybindingsPath);
		const submitKey = this.plugin.settings.submitKey;
		const mismatched = (info.mode === "newline" && submitKey === "enter") || (info.mode === "submit" && submitKey !== "enter");
		if (!mismatched) {
			return;
		}

		const setting = new Setting(containerEl).setName(t("settings.submitKeyMismatch.name"));
		setting.descEl.createSpan({
			text: t("settings.submitKeyMismatch.desc"),
			cls: "agent-sessions-settings-mismatch",
		});
		setting.addButton((button) =>
			button.setButtonText(t("action.matchFile")).onClick(async () => {
				const changed = await this.plugin.syncSubmitKeyFromKeybindings();
				if (changed) {
					new Notice(t("notice.matchedKeybindings"));
				}
				this.display();
			})
		);
	}
}
