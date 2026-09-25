import {
	Events,
	MarkdownView,
	Notice,
	Platform,
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
import {
	agentEnvFor,
	agentVersion,
	buildAgentArgv,
	detail,
	detectAgents,
	live,
	loginEnv,
	resolve,
	resolveAgentBinary,
	resetLoginEnvCache,
	resolveAgentSessionsPath,
	scan,
	setAgentEnv,
	withBinDirOnPath,
} from "./backend/backend";
import { DaemonClient, defaultSockPath, ensureDaemon } from "./backend/daemon-client";
import { EditServer, editReplyFor, submitsAfterEdit, type EditReply, type EditRequest } from "./backend/edit-server";
import { SessionIndex } from "./sessions/index";
import { getLang, languageOptions, readObsidianLang, resolveLang, setLang, t, type MessageKey } from "./i18n";
import { applySubmitKey, defaultKeybindingsPath, readChatBindings, readEnterMode } from "./terminal/keybindings";
import { reconcileSubmitKey, sendSequence } from "./terminal/keys";
import { buildAtToken, selectionLineRange } from "./terminal/links";
import { ConfirmModal, NewSessionModal, RenameSessionModal } from "./ui/modals";
import { sessionDisplayName } from "./sessions/name";
import { SessionOpener, VIEW_TYPE_TERMINAL, type OpenSessionOptions } from "./sessions/open-session";
import {
	AGENT_IDS,
	AgentSessionsSettings,
	asAgentId,
	DEFAULT_SETTINGS,
	mergeSettings,
	parseEnvLines,
	SUBMIT_KEYS,
	SUBMIT_KEYS_NON_MAC,
	type AgentId,
	type SubmitKey,
} from "./settings";
import { loadStore, migrateFromMarkdown, StoreLockError, updateStore } from "./sessions/store";
import {
	ALL_TERMINAL_STATUSES,
	higherPriorityStatus,
	rowTerminalStatus,
	statusTooltip,
	TERMINAL_STATUS_ICON,
	terminalStatusClass,
	type TerminalStatus,
} from "./sessions/terminal-status";
import { claudeSettingsPath, readFullscreenTui } from "./terminal/tui-mode";
import type { ArchivedSession, DaemonSession } from "./types";
import { writeUiState } from "./backend/ui-state";
import { UsageModal } from "./usage/usage-modal";
import { writeVaultState } from "./backend/vault-state";
import { ManagerView, VIEW_TYPE_MANAGER } from "./views/manager";
import { SideView, VIEW_TYPE_SIDE } from "./views/side";
import { TerminalView } from "./views/terminal";

export { VIEW_TYPE_SIDE, VIEW_TYPE_MANAGER, VIEW_TYPE_TERMINAL };

const RUNTIME_DIR = join(homedir(), ".agents", "sessions");
/** The settings tab's per-agent heading (an autonym-like proper name, not translated — same idea
 * as `i18n/index.ts`'s locale self-names). */
const AGENT_DISPLAY_NAME_KEY: Record<AgentId, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
};
/** Ctrl+S = Claude Code's `chat:stash` (stashes the draft; Claude restores it automatically after the next submit). */
const STASH = "\x13";
/** Bracketed paste markers. Wrapping a command in these lets it go in as one block without opening `/` completion. */
const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Gap between the built-in editor's "send" and the submit sequence (lets Claude read the temp file back first). */
const SUBMIT_AFTER_EDIT_MS = 300;
/** Upper bound while waiting for `registry`'s state. */
const WAIT_IDLE_MS = 60000;
/** Upper bound while waiting to see `busy` after sending. Commands that never go busy (like `/rename`) give up after this. */
const WAIT_BUSY_MS = 10000;
/** Upper bound from a headless session's `/exit` to its `exit` event. */
const WAIT_EXIT_MS = 30000;
/** Terminal size used when starting headless (no screen). */
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 40;
/** `resolveCodexSession`'s polling interval, and how many attempts before giving up on finding
 * the daemon-tracked pid (should appear almost immediately after `start`). Thread-id resolution
 * itself isn't bounded by an attempt count — Codex doesn't create its rollout file until the first
 * turn completes, which can be well after the tab opens, so that stage keeps retrying for as long
 * as the tab stays open (`resolveCodexSession`'s loop condition). */
const RESOLVE_POLL_MS = 2000;
const RESOLVE_PID_ATTEMPTS = 15;

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The submit sequence. `\r` when `submitKey === 'enter'`; otherwise Enter has been swapped to
 * mean newline, so this is `\x1b\r` (meta+enter = submit). A pure function used by
 * `views/terminal.ts`'s `sendSubmit()`, command sending, and the built-in editor's "send".
 */
export function submitSequence(settings: AgentSessionsSettings): string {
	return sendSequence("submit", settings.submitKey);
}

export default class AgentSessionsPlugin extends Plugin {
	settings: AgentSessionsSettings = DEFAULT_SETTINGS;
	/** Events internal to the plugin (`settings-changed`, `terminal-status`). */
	events = new Events();
	/** Combines the scan results with what's running and what's open in a tab. Holds one `registry` and one `statusline`. */
	index!: SessionIndex;
	/**
	 * Each session's terminal-tab state. Row markers (side panel, manager) read this via
	 * `resolveRowStatus`. An id with no tab isn't in here (`refreshTerminalStatus` removes it).
	 */
	terminalStatuses = new Map<string, TerminalStatus>();
	private stopIndex: (() => void) | null = null;
	/** True for exactly one `onload`: saved data had no `agents` object at all (pre-T-96, or a
	 * genuinely first run) — `onload` runs `detectAgents` once and applies the result. */
	private needsAgentDetection = false;
	private opener!: SessionOpener<WorkspaceLeaf>;
	/** The socket that receives `agent-sessions edit` requests. */
	private editServer = new EditServer();
	/** Debounce for cleaning up exited sessions. */
	private cleanupExitedTimer: ReturnType<typeof setTimeout> | null = null;
	/** The last-frontmost Markdown view. `activeEditor` is null while the terminal has focus, so this is tracked separately. */
	private lastMarkdown: MarkdownView | null = null;
	/** Sessions started headless (in the background). Excluded from `notifyIdle`. */
	private headless = new Set<string>();
	/** Whether Claude Code's `tui` is `fullscreen` (re-read at startup and on every `settings-changed`). */
	private fullscreenTui = false;
	/** In-flight `openSession` calls. */
	get opening(): Map<string, Promise<WorkspaceLeaf>> {
		return this.opener.opening;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.autoDetectAgentsOnFirstRun();
		this.applyLanguage();
		this.refreshTuiMode();
		this.registerEvent(this.events.on("settings-changed", () => this.refreshTuiMode()));
		// If keybindings.json already has Enter mapped to a newline (including when another tool
		// or the user wrote it by hand), bring the plugin's setting in line with it (without
		// writing to keybindings.json itself).
		await this.syncSubmitKeyFromKeybindings();
		this.syncUiState();
		this.syncVaultState();

		// Import from the old `claude-sessions.md`. Does nothing if `sessions.json` already exists.
		try {
			migrateFromMarkdown(join(this.vaultPath(), "claude-sessions.md"), this.storePath());
		} catch (err) {
			console.warn("agent-sessions: failed to import claude-sessions.md", err);
		}

		this.index = new SessionIndex({
			scan: (only) => scan(this.agentSessionsPath(), this.vaultPath(), only),
			live: () => live(this.agentSessionsPath(), this.vaultPath()),
			detail: (id) => detail(this.agentSessionsPath(), this.vaultPath(), id),
			storePath: this.storePath(),
			eventsLogPath: join(RUNTIME_DIR, "events.log"),
			sessionsDir: join(homedir(), ".claude", "sessions"),
			statusDir: join(RUNTIME_DIR, "status"),
			compactedDir: join(RUNTIME_DIR, "compacted"),
		});
		this.app.workspace.onLayoutReady(() => {
			this.stopIndex = this.index.start();
		});
		this.opener = new SessionOpener<WorkspaceLeaf>(this.app.workspace);

		this.register(this.index.registry.onIdle((id) => this.notifyIdle(id)));

		// Remember the last-frontmost Markdown view (the target for `@` insertion).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.lastMarkdown = leaf.view;
				}
			})
		);

		// Clean up exited sessions: sends `forget` for exited sessions that have no tab.
		this.app.workspace.onLayoutReady(() => this.scheduleCleanupExited());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleCleanupExited()));

		this.editServer.onEdit((req, reply) => this.handleEdit(req, reply));
		this.editServer.start(this.pluginSockPath()).catch((err) => {
			console.warn("agent-sessions: couldn't open plugin.sock", err);
		});

		this.registerView(VIEW_TYPE_SIDE, (leaf) => new SideView(leaf, this));
		this.registerView(VIEW_TYPE_MANAGER, (leaf) => new ManagerView(leaf, this));
		this.registerView(VIEW_TYPE_TERMINAL, (leaf) => new TerminalView(leaf, this));

		// Deferred tabs' icon and title (a tab restored but not yet brought to front, so its
		// `TerminalView` hasn't loaded): with no view to call `updateIcon()`/`updateHeader()`,
		// patch the tab header's DOM directly here with what's known (`rowTerminalStatus`,
		// `Row.name`; falls back to `detached`/"Untitled" without a ledger entry). Once
		// `TerminalView` loads, `updateIcon()`/`refreshName()` take over.
		this.app.workspace.onLayoutReady(() => this.refreshDeferredTerminalTabs());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshDeferredTerminalTabs()));
		this.register(this.index.onChange(() => this.refreshDeferredTerminalTabs()));
		this.register(this.index.registry.onChange(() => this.refreshDeferredTerminalTabs()));

		this.addRibbonIcon("list-tree", "Agent Sessions", () => {
			void this.openSidePanel();
		});

		this.registerCommands();
		// Redraw command names whenever the language changes (re-calling `addCommand` with the same id overwrites it).
		this.registerEvent(this.events.on("settings-changed", () => this.registerCommands()));

		this.addSettingTab(new AgentSessionsSettingTab(this.app, this));
	}

	/** Command palette entries. Re-registered under the same ids whenever the language changes, to redraw their names. */
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
				new NewSessionModal(this, (name, agent) => this.newSession(name || undefined, agent)).open();
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
		// Resolve any in-progress edit with `cancel` (writing the original content back), then close the socket.
		for (const view of this.terminalViews()) {
			view.cancelEditor();
		}
		this.editServer.stop();
		// Leaves from registerView are closed by Obsidian itself.
		this.stopIndex?.();
		this.stopIndex = null;
		this.index.dispose();
		if (this.cleanupExitedTimer) {
			clearTimeout(this.cleanupExitedTimer);
			this.cleanupExitedTimer = null;
		}
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		this.settings = mergeSettings(raw, Platform.isMacOS);
		this.needsAgentDetection = !(raw && typeof raw === "object" && "agents" in raw);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.syncUiState();
		this.events.trigger("settings-changed");
	}

	/**
	 * First run only (`needsAgentDetection`: saved settings had no `agents` object at all —
	 * pre-T-96 data or a genuinely first run): auto-detects Claude/Codex (`detectAgents`) and
	 * enables whichever is found. Neither found leaves Claude enabled (today's behavior,
	 * unchanged) — at least one agent is always left enabled. Runs once; from then on the user's
	 * own toggles in Settings are authoritative (re-detecting again only happens via the settings
	 * tab's "Detect again" button, which shows the result rather than silently flipping a toggle).
	 */
	private async autoDetectAgentsOnFirstRun(): Promise<void> {
		if (!this.needsAgentDetection) {
			return;
		}
		this.needsAgentDetection = false;
		try {
			const found = await detectAgents(Platform.isMacOS);
			for (const id of AGENT_IDS) {
				this.settings.agents[id].enabled = found[id] !== null;
			}
			if (!AGENT_IDS.some((id) => this.settings.agents[id].enabled)) {
				this.settings.agents.claude.enabled = true;
			}
			await this.saveSettings();
		} catch (err) {
			console.warn("agent-sessions: agent auto-detect failed", err);
		}
	}

	/**
	 * Writes the submit-key symbol, the resolved display language, and the enabled agent ids to
	 * `ui.json`, and updates the env `envWithVault` overlays onto every `json …` call
	 * (`setAgentEnv`/`agentEnvFor`). The submit-key symbol is read by the statusLine (the Python
	 * side's `format_status_line`) — only sessions started with `AGENT_SESSIONS_ID` set actually
	 * attach it, so this writes unconditionally. Called from `saveSettings`, so a language or
	 * agent-settings change gets picked up here too.
	 */
	private syncUiState(): void {
		setAgentEnv(agentEnvFor(this.settings));
		const enabledAgents = AGENT_IDS.filter((id) => this.settings.agents[id].enabled);
		try {
			writeUiState(RUNTIME_DIR, this.settings.submitKey, getLang(), enabledAgents, Platform.isMacOS);
		} catch (err) {
			console.warn("agent-sessions: couldn't write ui.json", err);
		}
	}

	/**
	 * Writes the vault's location to `vault.json`. The Python side (`_resolve_vault` in
	 * `agentsessions/config.py`) reads this after the env var, so vault location isn't lost
	 * outside Obsidian (TUI, CLI, or claude spawned by the daemon). The vault doesn't change
	 * while running, so writing this once in `onload` is enough.
	 */
	private syncVaultState(): void {
		try {
			writeVaultState(RUNTIME_DIR, this.vaultPath());
		} catch (err) {
			console.warn("agent-sessions: couldn't write vault.json", err);
		}
	}

	/**
	 * Display language: derives `t()`'s current value from the setting's `language` and
	 * Obsidian's own language (`localStorage.language`). Called first thing in `onload`, and
	 * whenever the language setting changes (call `saveSettings()` afterward so
	 * `settings-changed` redraws every view).
	 */
	applyLanguage(): void {
		setLang(resolveLang(this.settings.language, readObsidianLang()));
	}

	/** Where `keybindings.json` lives. Also used by `AgentSessionsSettingTab`. */
	keybindingsPath(): string {
		return defaultKeybindingsPath(homedir(), process.env.CLAUDE_CONFIG_DIR);
	}

	/**
	 * Reads `keybindings.json`'s `Chat` block and brings the `submitKey` setting in line with
	 * it, without writing to `keybindings.json` itself. Returns `true` if it changed anything
	 * (also called from the settings tab's "match the file" button).
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

	/** Opens a session's tab. Just brings it to front if it's already open. */
	openSession(id: string, opts: OpenSessionOptions = {}): Promise<WorkspaceLeaf> {
		return this.opener.open(id, opts);
	}

	/**
	 * Whether Claude Code is in fullscreen layout (`tui: "fullscreen"` in
	 * `~/.claude/settings.json`). When true, the terminal's jump buttons work via Claude's own
	 * scroll keys instead of markers.
	 */
	isFullscreenTui(): boolean {
		return this.fullscreenTui;
	}

	private refreshTuiMode(): void {
		this.fullscreenTui = readFullscreenTui(claudeSettingsPath(homedir(), process.env.CLAUDE_CONFIG_DIR));
	}

	/**
	 * The last-frontmost Markdown view. `null` if it's been closed. If nothing has been in
	 * front yet, falls back to whichever Markdown view is currently active.
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
	 * Writes the last-frontmost note to the target terminal as `@path[#Lx-y] `. The target is
	 * the frontmost terminal view, or failing that, the first open terminal tab.
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

	/** The frontmost terminal view (whichever tab is visible). Falls back to the first open tab. */
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

	/** The socket `agent-sessions edit` connects to. */
	pluginSockPath(): string {
		return join(RUNTIME_DIR, "plugin.sock");
	}

	/**
	 * The `VISUAL` value put into `start`'s `env`: `~/bin/agent-sessions-code` if the
	 * `agentSessionsPath` setting is empty, otherwise `agent-sessions-code` next to it.
	 */
	visualPath(): string {
		const configured = this.settings.agentSessionsPath;
		return configured ? join(dirname(configured), "agent-sessions-code") : join(homedir(), "bin", "agent-sessions-code");
	}

	/**
	 * An `edit` request: finds the session's terminal view (replying `no-tab` if there isn't
	 * one), opens the editor pane, and replies with the result. Send/back to prompt reply `ok`;
	 * cancel (the tab closed) replies `cancel`. On send for a prompt edit (`claude-prompt-*`),
	 * waits for Claude to read the file back before sending the submit sequence. If claude's
	 * side disconnects (`onAbort`), closes the editor pane without sending a reply.
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
				console.warn("agent-sessions: couldn't open the editor pane", err);
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

	/** Opens this plugin's settings tab. `app.setting` isn't in the public types. */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	storePath(): string {
		return join(this.vaultPath(), ".agents", "sessions", "sessions.json");
	}

	/** Opens the manager tab (creates it in the main area if it doesn't exist, otherwise brings it to front). */
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

	// ---- Session actions. `updateStore`'s `StoreLockError` is turned into a `Notice` here. --------

	/**
	 * New session: creates a uuid, records it in `sessions.json`, then opens the tab. If a name
	 * was given, sends `/rename` once the tab's `start` has claude reach `idle` (no pending-name
	 * state is kept elsewhere). After sending, waits via `index.waitForName` for `Row.name` to
	 * reflect it (once it does, subscribers redraw the tab title themselves).
	 *
	 * `agent` defaults to the last one used (`settings.lastNewSessionAgent`, what the new-session
	 * dialog remembers) and is saved back as the new "last used" value. Claude's `--session-id`
	 * lets the caller assign `id` as the session's own persistent id, so a `sessions.json` entry
	 * under it is meaningful from the very first scan. Codex has no equivalent (`buildAgentArgv`)
	 * — its real thread id is only known once Codex itself creates its transcript — so a fresh
	 * Codex session instead runs under `id` as a *daemon-only* placeholder at first (the tab's own
	 * `TerminalView.daemonId` tracks it) while `resolveCodexSession` polls `json resolve codex` in
	 * the background to learn the real thread id; once found, the tab's own `id` is swapped to it
	 * (`TerminalView.relinkId`) and `sessions.json` links the two (design.md §3.3). Naming at
	 * creation isn't attempted for a non-Claude agent — the `idle`/name-reflected waits below only
	 * work through the registry/scan, which for a still-unresolved session are watching an id
	 * nothing is filed under yet.
	 */
	newSession(name?: string, agent: AgentId = this.settings.lastNewSessionAgent): void {
		if (agent !== this.settings.lastNewSessionAgent) {
			this.settings.lastNewSessionAgent = agent;
			void this.saveSettings();
		}
		const id = crypto.randomUUID();
		const cwd = this.vaultPath();
		if (agent === "claude") {
			try {
				updateStore(this.storePath(), (store) => {
					store.sessions[id] = { agent, cwd };
				});
			} catch (err) {
				this.notifyLockError(err);
				return;
			}
			this.index.refreshStore();
		}
		const opened = this.openSession(id, { agent, cwd, fresh: true });
		if (agent !== "claude") {
			void this.resolveCodexSession(id, cwd);
		}
		if (!name) {
			return;
		}
		if (agent !== "claude") {
			new Notice(t("notice.renameAtCreateUnsupported"));
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

	/**
	 * For a freshly-started Codex session (`newSession`, no caller-assignable id — see
	 * `buildAgentArgv`): finds the daemon-tracked `placeholderId` session's own pid, then polls
	 * `json resolve codex` (`backend.ts`'s `resolve`) until it learns the real thread id. Codex
	 * doesn't create its rollout file until the first turn completes, which can be well after the
	 * tab opens — this keeps retrying for as long as the tab stays open (checked each iteration via
	 * `findTerminalView`), rather than giving up after a fixed window, so a tab left idle for a
	 * while before its first message still gets linked once one is sent. Once found: links
	 * `sessions.json` (`linkCodexSession` — design.md §3.3), rescans so the row appears under that
	 * id, and swaps every open tab for `placeholderId` (normally one, but a split can make several)
	 * over to it (`TerminalView.relinkId`) so `id` is the real id everywhere from then on — row
	 * matching, `sendCommand` route ①, and the saved workspace layout.
	 */
	private async resolveCodexSession(placeholderId: string, cwd: string): Promise<void> {
		const since = Date.now() / 1000;
		let client: DaemonClient;
		try {
			client = await ensureDaemon(this.sockPath(), this.agentSessionsPath());
		} catch {
			return;
		}
		try {
			await client.hello("plugin");
			let pid: number | null = null;
			for (let i = 0; i < RESOLVE_PID_ATTEMPTS && pid === null; i++) {
				if (!this.findTerminalView(placeholderId)) {
					return;
				}
				const list = await client.list().catch(() => null);
				const sessions = (list?.sessions as DaemonSession[] | undefined) ?? [];
				pid = sessions.find((s) => s.id === placeholderId)?.pid ?? null;
				if (pid === null) {
					await sleep(RESOLVE_POLL_MS);
				}
			}
			if (pid === null) {
				return;
			}
			while (this.findTerminalView(placeholderId)) {
				const { thread } = await resolve(this.agentSessionsPath(), this.vaultPath(), "codex", pid, since, cwd).catch(
					() => ({ thread: null, transcript: null })
				);
				if (thread) {
					this.linkCodexSession(thread, cwd, placeholderId);
					this.relinkTerminalViews(placeholderId, thread);
					return;
				}
				await sleep(RESOLVE_POLL_MS);
			}
		} finally {
			client.close();
		}
	}

	/**
	 * Writes/overwrites `sessions.json`'s Codex daemon link (`sessions[id] = {agent: "codex", cwd,
	 * daemon: daemonId}` — design.md §3.3) and rescans so the row picks it up. Called both by
	 * `resolveCodexSession` (the first link, keyed by the real thread id it just learned) and by
	 * `TerminalView.startSession`'s resume-after-daemon-restart relaunch (re-linking the same
	 * thread id to a brand-new `daemonId` — the daemon has no rename op, so the old one just stops
	 * being referenced once a new PTY exists under a different id).
	 */
	linkCodexSession(id: string, cwd: string, daemonId: string): void {
		try {
			updateStore(this.storePath(), (store) => {
				store.sessions[id] = { agent: "codex", cwd, daemon: daemonId };
			});
			this.index.refreshStore();
			void this.index.rescan();
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	/** Calls `TerminalView.relinkId(newId)` on every open tab currently at `oldId` (normally one,
	 * but a split can make several). */
	private relinkTerminalViews(oldId: string, newId: string): void {
		for (const view of this.terminalViews()) {
			if (view.sessionId === oldId) {
				view.relinkId(newId);
			}
		}
	}

	/**
	 * The daemon-tracked id to use for `client.list()`-level lookups (route ②/③ of `sendCommand`),
	 * for a given row/session id. The same as `id` for everything except a linked Codex session
	 * (see `resolveCodexSession`), where the row's own id (the real thread id) and the daemon's
	 * tracked id (`TerminalView.daemonId`) differ — `sessions.json`'s `daemon` field on that entry
	 * is the link. Not used for route ① (`findTerminalView`) — an open tab's own `sessionId` is
	 * already the real id post-relink, so that lookup uses `id` directly. Swallows a lock/read
	 * failure by falling back to `id` unchanged — a transient store error shouldn't block sending a
	 * command entirely.
	 */
	private daemonIdFor(id: string): string {
		try {
			return loadStore(this.storePath()).sessions[id]?.daemon || id;
		} catch {
			return id;
		}
	}

	/** Rename: sends `/rename` right away (even without a tab). */
	async renameSession(id: string, name: string): Promise<void> {
		try {
			await this.sendCommand(id, `/rename ${name}`, t("progress.renaming"));
			// `/rename` doesn't call the model and doesn't show up in events.log, so wait for it
			// by repeatedly rescanning. Once `Row.name` changes, subscribers redraw the tab title.
			void this.index.waitForName(id, name);
		} catch (err) {
			new Notice(t("notice.renameFailed", { error: messageOf(err) }));
		}
	}

	/**
	 * Whether the last instruction was `/compact` (`json detail`'s `last_command`; only Python
	 * reads the transcript). Uses `index.getDetail`'s cache if there is one, otherwise fetches it.
	 */
	async lastInstructionIsCompact(id: string): Promise<boolean> {
		try {
			return (await this.index.getDetail(id)).last_command === "/compact";
		} catch {
			return false;
		}
	}

	/** Compact: does nothing if the last instruction was already `/compact`; otherwise sends `/compact` (even without a tab). */
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

	// ---- Sending commands ------------------------------------------------------
	//
	// Sends `text` (`/rename NAME`, `/compact`) by one of three routes depending on where the
	// session currently is. Every route sends the same shape of sequence (`commandBytes`): for
	// Claude, Ctrl+S (`chat:stash` — stashes the draft if there is one, does nothing if empty;
	// Claude Code-specific, so skipped for any other agent, which may not treat Ctrl+S as
	// harmless) → the command as bracketed paste (goes in as one block without opening `/`
	// completion — a standard terminal convention, not Claude-specific, so kept for every agent)
	// → the submit sequence (Claude's own configured submit key, or plain `\r` for any other
	// agent, whose keymap isn't touched — see `terminal.ts`'s `sendSubmit`). The stashed draft
	// isn't restored explicitly — Claude Code does that itself after the next submit ("Draft
	// restored"); sending a restore here would just get it stashed again.
	// ① A tab exists and is attached: write to that tab.
	// ② No tab, but the daemon has it: attach temporarily and write.
	// ③ Not on the daemon: `start` (`--resume`) headless → wait for `idle` → write → once the
	//    reply is done, `/exit` → `forget`.

	/**
	 * Sends a command. `progress` is only shown as a `Notice` for route ③ (headless start).
	 * Failures throw (the caller turns them into a `Notice`).
	 */
	async sendCommand(id: string, text: string, progress = t("progress.sending")): Promise<void> {
		// Route ①: an open tab's own `sessionId` is the real id post-relink (or the only id it's
		// ever had, for Claude / a not-yet-linked Codex session), so this looks it up by `id`
		// directly — no `daemonIdFor` conversion needed here.
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
			// Routes ②/③ talk to the daemon's raw session list, which is always keyed by its own
			// tracked id (`daemonIdFor`) — for a linked Codex session that can differ from `id`.
			const daemonId = this.daemonIdFor(id);
			const existing = sessions.find((s) => s.id === daemonId);
			if (existing && existing.exited === null) {
				await this.sendViaAttach(client, daemonId, text, existing.agent);
			} else {
				if (existing) {
					await client.forget(daemonId).catch(() => undefined);
				}
				// Headless start/resume always uses the row's own id (`id`, not `daemonId`) —
				// `codex resume <id>` needs the real, persistent thread id, not a placeholder
				// from a since-ended daemon session (see `buildAgentArgv`).
				await this.sendHeadless(client, id, text, progress);
			}
		} finally {
			client.close();
		}
	}

	/** Stash (Claude only) → command as bracketed paste → submit sequence. */
	private commandBytes(text: string, agent: AgentId): Buffer {
		const stash = agent === "claude" ? STASH : "";
		const submit = agent === "claude" ? submitSequence(this.settings) : "\r";
		return Buffer.from(stash + PASTE_BEGIN + text + PASTE_END + submit, "utf8");
	}

	/** Route ①: write straight to that tab. */
	private sendViaView(view: TerminalView, text: string): void {
		view.sendBytes(this.commandBytes(text, asAgentId(view.sessionAgent)));
	}

	/** Route ②: attach temporarily and write. */
	private async sendViaAttach(client: DaemonClient, id: string, text: string, agent: string): Promise<void> {
		const res = await client.attach(id, HEADLESS_COLS, HEADLESS_ROWS);
		if (!res.ok) {
			throw new Error(t("error.attachFailed", { error: res.error ?? "unknown" }));
		}
		try {
			client.writeInput(this.commandBytes(text, asAgentId(agent)));
		} finally {
			await client.detach().catch(() => undefined);
		}
	}

	/**
	 * Route ③: starts headless, sends, then exits. Progress is shown as a `Notice`.
	 * `idle` → send → `busy` then back to `idle` (commands that never go busy give up after
	 * `WAIT_BUSY_MS`) → `/exit` → the `exit` event → `forget`.
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
			const agent = asAgentId(row.agent);
			const agentSettings = this.settings.agents[agent];
			const bin = await resolveAgentBinary(agent, agentSettings.path, Platform.isMacOS);
			// `AGENT_SESSIONS_VAULT`/`withBinDirOnPath`: same reason as terminal.ts's startSession.
			const env = withBinDirOnPath(
				{
					...(await loginEnv(Platform.isMacOS)),
					VISUAL: this.visualPath(),
					AGENT_SESSIONS_VAULT: this.vaultPath(),
					...parseEnvLines(agentSettings.env),
				},
				bin
			);
			const res = await client.start({
				id,
				agent: row.agent || "claude",
				cwd: row.cwd || this.vaultPath(),
				argv: buildAgentArgv(agent, bin, id, false),
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
			client.writeInput(this.commandBytes(text, agent));
			await registry.waitFor(id, "busy", WAIT_BUSY_MS);
			if (!(await registry.waitFor(id, "idle", WAIT_IDLE_MS))) {
				throw new Error(t("error.replyWaitFailed"));
			}
			client.writeInput(this.commandBytes("/exit", agent));
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

	/** End session: confirm → `kill`. */
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

	/** Opens the session analytics modal. */
	showUsage(id: string): void {
		const row = this.index.sessions.get(id);
		const name = row?.name || row?.label || t("common.untitled", { id: id.slice(0, 8) });
		new UsageModal(this.app, this.agentSessionsPath(), this.vaultPath(), id, name).open();
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
	 * Called whenever a `TerminalView` changes state (`updateIcon()`) or closes (`onClose()`).
	 * Looks at every view for `id` (there can be several, from splits) and keeps whichever has
	 * higher priority in `terminalStatuses`; removes the entry if no view is left. Row markers
	 * (side panel, manager) update off this `terminal-status` event.
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
	 * Fixes up the icon and title for deferred tabs (`leaf.view` is Obsidian's own
	 * `DeferredView` rather than a `TerminalView` — this is what a tab restored but not yet
	 * brought to front looks like). There's no `TerminalView` yet, so `updateIcon()`/
	 * `refreshName()` aren't available; instead this works from what's knowable via the `Row` in
	 * `plugin.index.sessions` (status from `rowTerminalStatus`, or `detached` without even a
	 * ledger entry; name from `Row.name`, or `sessionDisplayName`'s "Untitled <id8>" without one).
	 *
	 * Two things get fixed:
	 * 1. `leaf.view.icon`/`leaf.view.title` — `DeferredView` is still an instance of `View` (the
	 *    public type), where `icon: IconName` is a public field (`getIcon()` just returns it).
	 *    `title` isn't in the public type but does exist at runtime, and is read from here
	 *    instead of `getDisplayText()`. Left stale, either would keep returning
	 *    `lucide-ghost` (Obsidian's default) or `agent-sessions-terminal` (`TerminalView`'s
	 *    `getViewType()` — Obsidian persists whatever was last drawn, and that value carries
	 *    straight into the `DeferredView` it creates).
	 * 2. The tab header's DOM (the icon's `agent-sessions-status-<status>` class, tooltip, and
	 *    actual `<svg>`; the title's `.workspace-tab-header-inner-title` text) — fixing (1) alone
	 *    doesn't guarantee Obsidian redraws it on its own, so this is kept in sync directly too.
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
			setTooltip(iconEl, statusTooltip(status));
		}
	}

	// ---- Notifications and cleanup -----------------------------------------------------

	/** On `busy|shell → idle`, notifies if that tab isn't in front or Obsidian isn't the active window. */
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
	 * Sends `forget` for exited sessions (`exited !== null`) that have no terminal tab. Does
	 * nothing if the daemon can't be reached (doesn't start it).
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
			console.warn("agent-sessions: failed to clean up exited sessions", err);
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

/** The plugin's settings tab. */
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

		this.renderAgentsSetting(containerEl);

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

	/**
	 * The "Agents" section: per agent (Claude Code, Codex), an enabled toggle, a path field
	 * (empty = auto-detect), and a multi-line "environment variables" field (`KEY=VALUE` per
	 * line). A shared "Detect again" button re-runs `detectAgents` and shows each agent's result
	 * inline — it only ever *shows* what it found; it never flips a toggle itself (that only
	 * happens automatically once, on a genuine first run — see `main.ts`'s `onload`). The enabled
	 * toggle refuses to turn off the last remaining enabled agent (at least one must stay on).
	 */
	private renderAgentsSetting(containerEl: HTMLElement): void {
		const sectionEl = containerEl.createDiv();
		let detected: Partial<Record<AgentId, string | null>> = {};
		/** `<bin> --version` for each entry in `detected`, filled in after detection (`agentVersion`
		 * is a second, separate call — no reason to hold up showing the path on it). */
		let versions: Partial<Record<AgentId, string | null>> = {};

		const redraw = (): void => {
			sectionEl.empty();
			new Setting(sectionEl).setName(t("settings.agents.heading")).setHeading();
			sectionEl.createDiv({ cls: "setting-item-description", text: t("settings.agents.desc") });

			for (const id of AGENT_IDS) {
				const agentSettings = this.plugin.settings.agents[id];

				new Setting(sectionEl)
					.setName(t(AGENT_DISPLAY_NAME_KEY[id]))
					.addToggle((toggle) =>
						toggle.setValue(agentSettings.enabled).onChange(async (value) => {
							if (!value && AGENT_IDS.filter((other) => other !== id).every((other) => !this.plugin.settings.agents[other].enabled)) {
								new Notice(t("notice.needsOneAgentEnabled"));
								toggle.setValue(true);
								return;
							}
							agentSettings.enabled = value;
							await this.plugin.saveSettings();
						})
					);

				const pathSetting = new Setting(sectionEl)
					.setName(t("settings.agents.path.name"))
					.setDesc(t("settings.agents.path.desc"))
					.addText((text) =>
						text.setValue(agentSettings.path).onChange(async (value) => {
							agentSettings.path = value;
							await this.plugin.saveSettings();
						})
					);
				if (id in detected) {
					const found = detected[id];
					const version = versions[id];
					const text = found
						? version
							? t("settings.agents.detected.foundWithVersion", { path: found, version })
							: t("settings.agents.detected.found", { path: found })
						: t("settings.agents.detected.notFound");
					pathSetting.descEl.createDiv({ cls: "agent-sessions-agent-detected", text });
					// A user with settings already saved never runs `autoDetectAgentsOnFirstRun` — if
					// "Detect again" now finds an agent that's still off (e.g. installed after that
					// first run, or found only once the search order below covered a version manager),
					// offer to flip it on right here rather than making them go find the toggle above.
					if (found && !agentSettings.enabled) {
						pathSetting.addButton((button) =>
							button.setButtonText(t("settings.agents.detected.enable")).onClick(async () => {
								agentSettings.enabled = true;
								await this.plugin.saveSettings();
								redraw();
							})
						);
					}
				}

				new Setting(sectionEl)
					.setName(t("settings.agents.env.name"))
					.setDesc(t("settings.agents.env.desc"))
					.addTextArea((textArea) => {
						textArea.setValue(agentSettings.env).onChange(async (value) => {
							agentSettings.env = value;
							await this.plugin.saveSettings();
						});
						textArea.inputEl.rows = 3;
						textArea.inputEl.addClass("agent-sessions-agent-env");
					});
			}

			new Setting(sectionEl).addButton((button) =>
				button.setButtonText(t("settings.agents.detect.name")).onClick(async () => {
					button.setDisabled(true);
					try {
						// Also re-probes the interactive-shell PATH a session launches with
						// (`loginEnv`'s own cache) — otherwise "Detect again" could find a binary
						// while a session started right after still launches with the stale PATH.
						resetLoginEnvCache();
						detected = await detectAgents(Platform.isMacOS);
						versions = {};
						redraw();
						const found = AGENT_IDS.map((id) => detected[id]).filter((path): path is string => !!path);
						await Promise.all(
							found.map(async (path) => {
								const version = await agentVersion(path);
								for (const id of AGENT_IDS) {
									if (detected[id] === path) {
										versions[id] = version;
									}
								}
							})
						);
					} finally {
						button.setDisabled(false);
						redraw();
					}
				})
			);
		};

		redraw();
	}

	/** Language: auto / Japanese / English. Changing it calls `setLang` → `saveSettings()`
	 * (each view, and this tab itself, redraws on `settings-changed`). */
	private renderLanguageSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.language.name"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(languageOptions())
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

	/** Only for displaying the current keybindings.json's Chat `enter` value — never used to change it. */
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

	/** The submit-key setting. Reads `keybindings.json` and shows the current value every time this is opened. */
	private renderSubmitKeySetting(containerEl: HTMLElement): void {
		const keybindingsPath = this.plugin.keybindingsPath();

		const applyAndSave = (next: SubmitKey) => {
			const result = applySubmitKey(keybindingsPath, next);
			this.plugin.settings.submitKey = next;
			void this.plugin.saveSettings();
			if (result.warning) {
				new Notice(result.warning);
			} else if (result.status === "written") {
				new Notice(t("notice.keybindingsWritten"));
			} else if (result.status === "unchanged") {
				new Notice(t("notice.keybindingsUnchanged"));
			}
			this.display();
		};

		const setting = new Setting(containerEl).setName(t("settings.submitKey.name"));
		setting.descEl.createDiv({
			text: t("settings.submitKey.desc"),
		});
		setting.descEl.createDiv({ text: this.currentEnterBindingText(keybindingsPath) });
		setting.addDropdown((dropdown) => {
			// Non-macOS doesn't offer cmd+enter (Command — on non-macOS that's Super).
			for (const key of Platform.isMacOS ? SUBMIT_KEYS : SUBMIT_KEYS_NON_MAC) {
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
					// Revert the dropdown's appearance until confirmed (display() rebuilds it once applied).
					dropdown.setValue(current);
				} else {
					applyAndSave(next);
				}
			});
		});

		this.renderSubmitKeyMismatch(containerEl, keybindingsPath);
	}

	/**
	 * Warns when `keybindings.json`'s `Chat.enter` disagrees with the `submitKey` setting (e.g.
	 * the file has `chat:newline` but the setting is still `enter`). "Match the file" runs
	 * `syncSubmitKeyFromKeybindings()`.
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
