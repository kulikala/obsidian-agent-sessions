import {
	Events,
	getLanguage,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
	setTooltip,
	WorkspaceLeaf,
	type DropdownComponent,
	type FileSystemAdapter,
} from "obsidian";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BACKEND_FILES, BACKEND_VERSION } from "virtual:agent-sessions-backend";
import {
	agentEnvFor,
	agentVersion,
	BackendError,
	buildAgentArgv,
	detail,
	detectAgent,
	detectAgents,
	live,
	loginEnv,
	resolve,
	resolveAgentBinary,
	resetLoginEnvCache,
	listOllamaModels,
	locateProgram,
	runProgram,
	scan,
	setAgentEnv,
	withBinDirOnPath,
} from "./backend/backend";
import {
	chooseInstallDir,
	findInstalled,
	findPython,
	hookLauncher,
	installCandidates,
	isSupportedPlatform,
	launcherPath,
	removeBundle,
	writeBundle,
	type InstallDirChoice,
	type InstallInfo,
	type PythonInfo,
} from "./backend/bundle";
import { DaemonClient, defaultSockPath, ensureDaemon } from "./backend/daemon-client";
import { waitUntilReady } from "./backend/headless-ready";
import { OllamaModelCache } from "./backend/ollama-models";
import {
	OPENCODE_PLUGIN_NOTICE,
	opencodePluginArgs,
	parseOpencodePluginStatus,
	type OpencodePluginMode,
	type OpencodePluginStatus,
} from "./backend/opencode-plugin";
import { EditServer, editReplyFor, submitsAfterEdit, tabOwnsEditSession, type EditReply, type EditRequest } from "./backend/edit-server";
import { SessionIndex } from "./sessions/index";
import { getLang, languageOptions, resolveLang, setLang, t, type MessageKey } from "./i18n";
import { applyCodexConfig, defaultCodexConfigPath, type ApplyCodexConfigResult } from "./terminal/codex-config";
import { applyEditorKey, applySubmitKey, defaultKeybindingsPath, readChatBindings, readEnterMode } from "./terminal/keybindings";
import { agentSendSequence, editorKeyLabel, reconcileSubmitKey } from "./terminal/keys";
import {
	BACKUP_FILENAME,
	defaultOpencodeTuiPath,
	syncOpencodeTui,
	type OpencodeTuiResult,
} from "./terminal/opencode-tui";
import { buildAtToken, selectionLineRange } from "./terminal/links";
import { ConfirmModal, NewSessionModal } from "./ui/modals";
import { AGENT_ICON_ID } from "./ui/icons";
import { registerAgentIcons } from "./ui/register-icons";
import { sessionDisplayName } from "./sessions/name";
import { renameRoute, sessionAgentOf } from "./sessions/rename";
import { SessionOpener, VIEW_TYPE_TERMINAL, type OpenSessionOptions } from "./sessions/open-session";
import {
	AGENT_IDS,
	AgentSessionsSettings,
	asAgentId,
	DEFAULT_SETTINGS,
	EDITOR_KEYS,
	mergeSettings,
	OPENCODE_LAUNCH_VIA,
	parseEnvLines,
	SUBMIT_KEYS,
	SUBMIT_KEYS_NON_MAC,
	type AgentId,
	type AgentSettings,
	type EditorKey,
	type OpencodeLaunchVia,
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
import type { ArchivedSession, DaemonSession, Detail, LiveResult, ScanResult } from "./types";
import {
	AGENT_SKILLS_NOTICE,
	agentSkillsArgs,
	parseAgentSkillsStatus,
	skillLauncher,
	type AgentSkillsMode,
	type AgentSkillsStatus,
} from "./backend/agent-skills";
import { agentLaunchFor, writeUiState } from "./backend/ui-state";
import { InstallBackendModal } from "./ui/install-modal";
import { UsageModal } from "./usage/usage-modal";
import { writeVaultState } from "./backend/vault-state";
import { ManagerView, VIEW_TYPE_MANAGER } from "./views/manager";
import { SideView, VIEW_TYPE_SIDE } from "./views/side";
import { TerminalView } from "./views/terminal";

export { VIEW_TYPE_SIDE, VIEW_TYPE_MANAGER, VIEW_TYPE_TERMINAL };

const RUNTIME_DIR = join(homedir(), ".agents", "sessions");
/** Where `install.sh` links the program; used when present, ahead of an install made from inside the plugin. */
const LINKED_AGENT_SESSIONS = join(homedir(), "bin", "agent-sessions");
/** What the index sees while the program isn't installed: nothing, rather than a failed call
 * (and a "scan failed" notice) every minute. */
const EMPTY_SCAN: ScanResult = { sessions: [], store: { folded: [], archived: [], pendingRenames: {}, sessions: {} } };
const EMPTY_LIVE: LiveResult = { live: {}, daemon: { running: false, sessions: [] } };
const EMPTY_DETAIL: Detail = { last_user: null, last_assistant: null, last_command: null, tools: [] };
/** The settings tab's per-agent heading (an autonym-like proper name, not translated — same idea
 * as `i18n/index.ts`'s locale self-names). */
const AGENT_DISPLAY_NAME_KEY: Record<AgentId, MessageKey> = {
	claude: "settings.agents.claude.name",
	codex: "settings.agents.codex.name",
	opencode: "settings.agents.opencode.name",
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
/** How long OpenCode's terminal must be quiet before a headless session with no status is taken as ready. */
const OPENCODE_QUIET_MS = 2500;
/** After a kill, how long to wait for the `exit` event before forgetting the session. */
const WAIT_KILL_MS = 5000;
/** Terminal size used when starting headless (no screen). */
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 40;
/** `resolveAgentSession`'s polling interval, and how many attempts before giving up on finding
 * the daemon-tracked pid (should appear almost immediately after `start`). Thread-id resolution
 * itself isn't bounded by an attempt count — Codex doesn't create its rollout file until the first
 * turn completes, which can be well after the tab opens, so that stage keeps retrying for as long
 * as the tab stays open (`resolveAgentSession`'s loop condition). */
const RESOLVE_POLL_MS = 2000;
const RESOLVE_PID_ATTEMPTS = 15;

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The pause between the parts of a command sent in several writes (`commandChunks`). */
const COMMAND_CHUNK_GAP_MS = 250;

/** How long `refreshUntilExited` keeps re-reading after an end request (the daemon's 10 s kill grace plus a margin). */
const END_REFRESH_MAX_MS = 12_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * The submit sequence. `\r` when `submitKey === 'enter'`; otherwise Enter has been swapped to
 * mean newline, so this is `\x1b\r` (meta+enter = submit); OpenCode's is `\n` then (its
 * `tui.json` is set to match, `agentSendSequence`). A pure function used by
 * `views/terminal.ts`'s `sendSubmit()`, command sending, and the built-in editor's "send".
 */
export function submitSequence(settings: AgentSessionsSettings, agent: AgentId = "claude"): string {
	return agentSendSequence(agent, "submit", settings.submitKey);
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
	/** The login shell's env (`loginEnv`), once read: `agentEnvFor`'s fallback for OpenCode's XDG_* variables. */
	private loginEnvVars: Record<string, string> = {};
	private loginEnvRequested = false;
	/** The copy of the program installed from inside the plugin, if any (`installBackend`). */
	bundled: InstallInfo | null = null;
	/** `false` on a platform `onload` stops early on (nothing to tear down in `onunload`). */
	private started = false;
	private opener!: SessionOpener<WorkspaceLeaf>;
	/** The socket that receives `agent-sessions edit` requests. */
	private editServer = new EditServer();
	/** Debounce for cleaning up exited sessions. */
	private cleanupExitedTimer: number | null = null;
	/** The last-frontmost Markdown view. `activeEditor` is null while the terminal has focus, so this is tracked separately. */
	private lastMarkdown: MarkdownView | null = null;
	/** OpenCode names given before the session has its real id (naming at creation, or Rename on a
	 * tab still under its placeholder id), by placeholder id. `linkAgentSession` moves them into
	 * `sessions.json`. */
	private pendingNames = new Map<string, string>();
	/** Placeholder ids of Codex/OpenCode sessions `resolveAgentSession` is still looking the real id for. */
	private unresolvedIds = new Set<string>();
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
		if (!isSupportedPlatform(process.platform, Platform.isMobile)) {
			// Windows (native) and mobile: nothing below can work there, so nothing is started —
			// just a note on why, in a notice now and in this plugin's settings tab.
			this.applyLanguage();
			new Notice(t("notice.unsupportedPlatform"), 10000);
			this.addSettingTab(new UnsupportedSettingTab(this.app, this));
			return;
		}
		this.started = true;
		registerAgentIcons();
		this.bundled = findInstalled(installCandidates(homedir(), process.env));
		this.refreshBundledBackend();
		await this.autoDetectAgentsOnFirstRun();
		this.applyLanguage();
		this.refreshTuiMode();
		this.registerEvent(this.events.on("settings-changed", () => this.refreshTuiMode()));
		// If keybindings.json already has Enter mapped to a newline (including when another tool
		// or the user wrote it by hand), bring the plugin's setting in line with it (without
		// writing to keybindings.json itself).
		await this.syncSubmitKeyFromKeybindings();
		// OpenCode's tui.json carries the editor key whenever OpenCode is enabled.
		this.syncOpencodeTui();
		this.syncUiState();
		this.syncVaultState();

		// Import from the old `claude-sessions.md`. Does nothing if `sessions.json` already exists.
		try {
			migrateFromMarkdown(join(this.vaultPath(), "claude-sessions.md"), this.storePath());
		} catch (err) {
			console.warn("agent-sessions: failed to import claude-sessions.md", err);
		}

		this.index = new SessionIndex({
			scan: (only) => (this.backendAvailable() ? scan(this.agentSessionsPath(), this.vaultPath(), only) : Promise.resolve(EMPTY_SCAN)),
			live: () => (this.backendAvailable() ? live(this.agentSessionsPath(), this.vaultPath()) : Promise.resolve(EMPTY_LIVE)),
			detail: (id) =>
				this.backendAvailable() ? detail(this.agentSessionsPath(), this.vaultPath(), id) : Promise.resolve(EMPTY_DETAIL),
			storePath: this.storePath(),
			eventsLogPath: join(RUNTIME_DIR, "events.log"),
			sessionsDir: join(homedir(), ".claude", "sessions"),
			opencodeDir: join(RUNTIME_DIR, "opencode"),
			statusDir: join(RUNTIME_DIR, "status"),
			compactedDir: join(RUNTIME_DIR, "compacted"),
		});
		this.app.workspace.onLayoutReady(() => {
			this.stopIndex = this.index.start();
		});
		this.opener = new SessionOpener<WorkspaceLeaf>(this.app.workspace);

		this.register(this.index.registry.onIdle((id) => void this.notifyIdle(id)));

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
		if (!this.started) {
			return;
		}
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
			window.clearTimeout(this.cleanupExitedTimer);
			this.cleanupExitedTimer = null;
		}
	}

	async loadSettings(): Promise<void> {
		// `loadData()` is typed `Promise<any>` (Obsidian's own data store has no schema) — `raw` is
		// kept `unknown` here rather than `any` so `mergeSettings` (which already takes `unknown`)
		// stays the only place that has to make sense of its shape.
		const raw: unknown = await this.loadData();
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
	 * pre-T-96 data or a genuinely first run): auto-detects Claude/Codex/OpenCode (`detectAgents`) and
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
		setAgentEnv(agentEnvFor(this.settings, this.loginEnvVars));
		if (!this.loginEnvRequested) {
			// The login shell's env is async; the first `json …` calls run without it, the next
			// ones with it (`agentEnvFor` takes OpenCode's XDG_* from it).
			this.loginEnvRequested = true;
			void loginEnv(Platform.isMacOS)
				.then((env) => {
					this.loginEnvVars = env;
					setAgentEnv(agentEnvFor(this.settings, env));
				})
				.catch(() => undefined);
		}
		const enabledAgents = AGENT_IDS.filter((id) => this.settings.agents[id].enabled);
		try {
			writeUiState(
				RUNTIME_DIR,
				this.settings.submitKey,
				getLang(),
				enabledAgents,
				Platform.isMacOS,
				agentLaunchFor(this.settings.agents)
			);
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
	 * Obsidian's own language (`getLanguage()`). Called first thing in `onload`, and
	 * whenever the language setting changes (call `saveSettings()` afterward so
	 * `settings-changed` redraws every view).
	 */
	applyLanguage(): void {
		setLang(resolveLang(this.settings.language, getLanguage()));
	}

	/** Where `keybindings.json` lives. Also used by `AgentSessionsSettingTab`. */
	keybindingsPath(): string {
		return defaultKeybindingsPath(homedir(), process.env.CLAUDE_CONFIG_DIR);
	}

	/** Where Codex's own `config.toml` lives (T-108) — the same `CODEX_HOME` resolution priority
	 * as the Python side (`agentEnvFor`/`agentsessions/agents/codex/rollout.py`'s `codex_home()`):
	 * this plugin's own "Codex environment variables" setting first, then the system env var,
	 * then `~/.codex`. Also used by `AgentSessionsSettingTab`. */
	codexConfigPath(): string {
		const codexHome = parseEnvLines(this.settings.agents.codex.env).CODEX_HOME || process.env.CODEX_HOME;
		return defaultCodexConfigPath(homedir(), codexHome);
	}

	/**
	 * Syncs `~/.codex/config.toml` with the current `submitKey` and `editorKey` settings and the
	 * `status_line` default (T-108, `applyCodexConfig`) — called whenever either key setting
	 * changes (`AgentSessionsSettingTab`'s dropdowns, same trigger as Claude's own
	 * `applySubmitKey`) and when Codex is switched on or off. With Codex enabled the keymap lines
	 * are written (or removed at the defaults) and the `status_line` default applied once; with
	 * Codex disabled the managed keymap lines are removed and nothing else is written — a file
	 * that doesn't exist stays absent.
	 */
	syncCodexConfig(): ApplyCodexConfigResult {
		const { submitKey, editorKey } = this.settings;
		const enabled = this.settings.agents.codex.enabled;
		const result = applyCodexConfig(this.codexConfigPath(), submitKey, editorKey, { statusLine: enabled });
		// Taking the lines away from a Codex nobody uses is silent about a file it can't parse.
		return enabled ? result : { status: result.status };
	}

	/** Shows the notice for a config sync result (a warning wins over "written"). */
	noticeConfigResult(result: { status: string; warning?: string }, writtenKey: MessageKey): void {
		if (result.warning) {
			new Notice(result.warning);
		} else if (result.status === "written") {
			new Notice(t(writtenKey));
		}
	}

	/** Where OpenCode's `tui.json` lives: the XDG_CONFIG_HOME OpenCode runs with (its own
	 * "environment variables" setting, then the login shell's, then the system's), else `~/.config`. */
	opencodeTuiPath(): string {
		const xdg = agentEnvFor(this.settings, this.loginEnvVars).XDG_CONFIG_HOME || process.env.XDG_CONFIG_HOME;
		return defaultOpencodeTuiPath(homedir(), xdg);
	}

	/**
	 * Brings OpenCode's `tui.json` keybinds in line with the submit and editor keys: the editor key
	 * is managed while OpenCode is enabled, the submit pair too when the key isn't Enter, and
	 * everything is restored to the user's own values when OpenCode is disabled
	 * (`syncOpencodeTui`). Returns the result and shows the notices for it; call it wherever
	 * `syncCodexConfig` is called, and when OpenCode is switched on or off.
	 */
	syncOpencodeTui(): OpencodeTuiResult {
		const result = syncOpencodeTui(
			this.opencodeTuiPath(),
			join(RUNTIME_DIR, BACKUP_FILENAME),
			this.settings.submitKey,
			this.settings.editorKey,
			this.settings.agents.opencode.enabled
		);
		if (result.warning) {
			new Notice(result.warning);
		} else if (result.status === "written") {
			new Notice(t("notice.opencodeTuiWritten"));
		} else if (result.status === "restored") {
			new Notice(t("notice.opencodeTuiRestored"));
		}
		return result;
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

	/** The `VISUAL` value put into `start`'s `env`: `agent-sessions-code`, next to the program in use. */
	visualPath(): string {
		return join(dirname(this.agentSessionsPath()), "agent-sessions-code");
	}

	/** The built-in editor's env for `agent`'s process: `VISUAL` (Claude Code, Codex) — and
	 * `EDITOR` too for OpenCode, which reads `$EDITOR` only. Same shim either way. */
	editorEnv(agent: AgentId): Record<string, string> {
		const shim = this.visualPath();
		return agent === "opencode" ? { VISUAL: shim, EDITOR: shim } : { VISUAL: shim };
	}

	/**
	 * `buildAgentArgv` plus the launch settings: OpenCode set to start through ollama gets
	 * `ollama launch opencode --model <M> -y -- …`. Refuses (a `Notice`, and a thrown error the
	 * caller shows in the tab) when the model is empty — otherwise ollama would open its own
	 * model picker inside the terminal.
	 */
	async launchArgv(agent: AgentId, bin: string, id: string, fresh: boolean): Promise<string[]> {
		const settings = this.settings.agents[agent];
		if (agent !== "opencode" || settings.launchVia !== "ollama") {
			return buildAgentArgv(agent, bin, id, fresh);
		}
		const model = (settings.ollamaModel ?? "").trim();
		if (!model) {
			const message = t("error.ollamaModelMissing");
			new Notice(message);
			throw new Error(message);
		}
		const ollamaBin = await locateProgram("ollama", Platform.isMacOS);
		if (!ollamaBin) {
			throw new BackendError(t("error.agentMissing", { name: "ollama" }));
		}
		return buildAgentArgv(agent, bin, id, fresh, { ollamaBin, model });
	}

	/**
	 * An `edit` request: finds the session's terminal view (replying `no-tab` if there isn't
	 * one), opens the editor pane, and replies with the result. Send/back to prompt reply `ok`;
	 * cancel (the tab closed) replies `cancel`. On send for a prompt edit (`claude-prompt-*`),
	 * waits for Claude to read the file back before sending the submit sequence. If claude's
	 * side disconnects (`onAbort`), closes the editor pane without sending a reply.
	 */
	private handleEdit(req: EditRequest, reply: EditReply): void {
		// `req.session` is the daemon's id for the session, which is not the tab's own id once the
		// tab is linked to its real thread id (Codex/OpenCode).
		const view = this.terminalViews().find((v) =>
			tabOwnsEditSession({ sessionId: v.sessionId, daemonId: v.daemonSessionId }, req.session)
		);
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
				if (result === "send" && submitsAfterEdit(req.file, view.sessionAgent)) {
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

	/**
	 * The `agent-sessions` program in use: the path set in settings if any; otherwise the `~/bin`
	 * link `install.sh` makes, if present; otherwise the copy installed from inside the plugin
	 * (`installBackend`). With none of them, still the `~/bin` path (for error messages).
	 */
	agentSessionsPath(): string {
		if (this.settings.agentSessionsPath) {
			return this.settings.agentSessionsPath;
		}
		if (!existsSync(LINKED_AGENT_SESSIONS) && this.bundled) {
			return launcherPath(this.bundled.dir);
		}
		return LINKED_AGENT_SESSIONS;
	}

	/** Whether the program `agentSessionsPath` names exists — `false` means it still needs installing. */
	backendAvailable(): boolean {
		return existsSync(this.agentSessionsPath());
	}

	/**
	 * Brings an install made from inside the plugin up to the version bundled with this build.
	 * Runs on every load, so updating the plugin updates the program with it. Keeps the Python
	 * it was installed with while that still exists; otherwise leaves it for the user to
	 * reinstall (settings), since picking a different interpreter silently could surprise them.
	 */
	private refreshBundledBackend(): void {
		const info = this.bundled;
		if (!info || info.version === BACKEND_VERSION || !existsSync(info.python)) {
			return;
		}
		try {
			this.bundled = writeBundle(info.dir, BACKEND_FILES, BACKEND_VERSION, info.python);
			// The status plugin's content ships inside the program, so an updated program means
			// an updated plugin file too — but only one that is already there; a silent refresh
			// never creates it.
			void this.installOpencodePlugin({ mode: "update-only" });
			// Likewise the skills: an updated program means updated skill text, for copies already there.
			void this.installAgentSkills({ mode: "update-only", program: launcherPath(info.dir) });
			this.syncOpencodeTui();
		} catch (err) {
			console.warn("agent-sessions: couldn't update the installed program", err);
		}
	}

	/** What an install would use, for the install dialog to show before anything is written. */
	async planBackendInstall(): Promise<{ python: PythonInfo | null; location: InstallDirChoice }> {
		const isMac = Platform.isMacOS;
		const python = await findPython(isMac, {
			locate: () => locateProgram("python3", isMac),
			run: (bin, args) => runProgram(bin, args, 15000),
			exists: (path) => existsSync(path),
		});
		const location = chooseInstallDir(installCandidates(homedir(), process.env), this.vaultPath());
		return { python, location };
	}

	/**
	 * Writes the bundled program into `dir`, running under `python`, and — with Claude Code
	 * enabled — points Claude Code's hooks and statusLine at it (`agent-sessions setup`, which
	 * backs `settings.json` up first) and, with OpenCode enabled, installs OpenCode's status
	 * plugin (`setup --opencode`). Then rescans, so the side panel comes to life.
	 */
	async installBackend(python: PythonInfo, dir: string): Promise<void> {
		this.bundled = writeBundle(dir, BACKEND_FILES, BACKEND_VERSION, python.path);
		const launcher = launcherPath(dir);
		if (this.settings.agents.claude.enabled) {
			await runProgram(launcher, ["setup", "--command", hookLauncher(dir, homedir())]);
		}
		if (this.settings.agents.opencode.enabled) {
			// Reports its own outcome (a `Notice`) and never throws: a plugin folder that can't be
			// written must not fail the rest of the install.
			await this.installOpencodePlugin({ notify: true, program: launcher });
			this.syncOpencodeTui();
		}
		if (this.settings.installAgentSkills) {
			await this.installAgentSkills({ notify: true, program: launcher });
		}
		this.syncVaultState();
		await this.index.rescan();
	}

	/**
	 * Runs `setup` for OpenCode's status plugin file (`mode`: `install` writes or refreshes it,
	 * `update-only` refreshes an existing one and never creates it, `remove` deletes our file and
	 * nothing else) and returns what the program reports (`opencode-plugin: <status>`). `notify`
	 * says what happened in a `Notice`; a failure is always reported that way, never thrown. `null`
	 * when there was nothing to run (no installed program; `install`/`update-only` with OpenCode
	 * disabled) or the run failed.
	 */
	async installOpencodePlugin(
		opts: { mode?: OpencodePluginMode; notify?: boolean; program?: string } = {}
	): Promise<OpencodePluginStatus | null> {
		const mode = opts.mode ?? "install";
		const program = opts.program ?? this.agentSessionsPath();
		if ((mode !== "remove" && !this.settings.agents.opencode.enabled) || !existsSync(program)) {
			return null;
		}
		try {
			// The plugin folder is found through XDG_CONFIG_HOME, which must be the one OpenCode runs with.
			const login = await loginEnv(Platform.isMacOS).catch((): Record<string, string> => ({}));
			const env = { ...process.env, ...agentEnvFor(this.settings, login) };
			const status = parseOpencodePluginStatus(await runProgram(program, opencodePluginArgs(mode), undefined, env));
			const key = status ? OPENCODE_PLUGIN_NOTICE[status] : null;
			if (opts.notify && key) {
				new Notice(t(key));
			}
			return status;
		} catch (err) {
			const stderr = (err as { stderr?: string }).stderr?.trim();
			new Notice(t("notice.opencodeSetupFailed", { error: stderr ? stderr.split("\n")[0] : messageOf(err) }));
			return null;
		}
	}

	/**
	 * Runs `setup` for the agent skills in the vault (`mode`: `install` writes the skills the enabled
	 * agents need and takes our copies out of the other folders, `update-only` refreshes copies that
	 * are already there, `remove` deletes every copy of ours) and returns what the program reports
	 * (`agent-skills: <status>`). `notify` says what happened in a `Notice`; a failure is always
	 * reported that way, never thrown. `null` when there was nothing to run (no installed program,
	 * or `install`/`update-only` with the setting off) or the run failed.
	 */
	async installAgentSkills(
		opts: { mode?: AgentSkillsMode; notify?: boolean; program?: string } = {}
	): Promise<AgentSkillsStatus | null> {
		const mode = opts.mode ?? "install";
		const program = opts.program ?? this.agentSessionsPath();
		if ((mode !== "remove" && !this.settings.installAgentSkills) || !existsSync(program)) {
			return null;
		}
		try {
			const enabled = AGENT_IDS.filter((id) => this.settings.agents[id].enabled);
			const args = agentSkillsArgs(mode, this.vaultPath(), enabled, skillLauncher(program, homedir()));
			const status = parseAgentSkillsStatus(await runProgram(program, args));
			const key = status ? AGENT_SKILLS_NOTICE[status] : null;
			if (opts.notify && key) {
				new Notice(t(key));
			}
			return status;
		} catch (err) {
			const stderr = (err as { stderr?: string }).stderr?.trim();
			new Notice(t("notice.agentSkillsFailed", { error: stderr ? stderr.split("\n")[0] : messageOf(err) }));
			return null;
		}
	}

	/** The "Install agent skills" switch: saves it, then writes the skills (or takes them away). */
	async setInstallAgentSkills(value: boolean): Promise<void> {
		this.settings.installAgentSkills = value;
		await this.saveSettings();
		if (value && !this.backendAvailable()) {
			// Nothing to run yet: the install writes them once the program is there.
			return;
		}
		await this.installAgentSkills({ mode: value ? "install" : "remove", notify: true });
	}

	/**
	 * Undoes `installBackend`: stops the daemon (ending any running session), removes its
	 * Claude Code hooks/statusLine, the Codex config lines, OpenCode's status plugin and
	 * its tui.json keybinds it manages (`setup --remove`), then deletes the files.
	 */
	async uninstallBackend(): Promise<void> {
		const info = this.bundled;
		if (!info) {
			return;
		}
		const launcher = launcherPath(info.dir);
		await runProgram(launcher, ["daemon", "--stop"]).catch(() => undefined);
		await runProgram(launcher, ["setup", "--remove", "--vault", this.vaultPath()]).catch((err) => {
			console.warn("agent-sessions: setup --remove failed", err);
		});
		removeBundle(info.dir);
		this.bundled = null;
		await this.index.rescan();
	}

	/** Opens the install dialog (side panel's empty state, settings); `onDone` runs after a successful install. */
	openInstallBackend(onDone?: () => void): void {
		new InstallBackendModal(this.app, this, onDone).open();
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
			await workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_SIDE, active: true });
		await workspace.revealLeaf(leaf);
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
	 * under it is meaningful from the very first scan. Codex and OpenCode have no equivalent
	 * (`buildAgentArgv`) — the real thread id is only known once the agent itself creates its
	 * transcript/session — so a fresh Codex or OpenCode session instead runs under `id` as a
	 * *daemon-only* placeholder at first (the tab's own `TerminalView.daemonId` tracks it) while
	 * `resolveAgentSession` polls `json resolve <agent>` in
	 * the background to learn the real thread id; once found, the tab's own `id` is swapped to it
	 * (`TerminalView.relinkId`) and `sessions.json` links the two (design.md §3.3). Naming at
	 * creation works through `/rename` for Claude only. An OpenCode name is kept in memory
	 * (`pendingNames`, shown in the tab title) and written to `sessions.json` when
	 * `linkAgentSession` learns the real id; Codex isn't supported yet (`/rename` needs an
	 * `idle` and a scan to reflect it, and a still-unresolved session has neither).
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
			this.trackNewAgentSession(agent, id, cwd);
		}
		if (!name) {
			return;
		}
		if (agent === "opencode") {
			// OpenCode has no `/rename`: the name waits here until the session has its real id.
			this.pendingNames.set(id, name);
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

	/** Starts finding the real id of a new Codex/OpenCode session that runs under `placeholderId`
	 * (`newSession`, and a tab's "Start fresh"). */
	trackNewAgentSession(agent: AgentId, placeholderId: string, cwd: string): void {
		this.unresolvedIds.add(placeholderId);
		void this.resolveAgentSession(agent, placeholderId, cwd);
	}

	/**
	 * For a freshly-started Codex/OpenCode session (`newSession`, no caller-assignable id — see
	 * `buildAgentArgv`): finds the daemon-tracked `placeholderId` session's own pid, then polls
	 * `json resolve <agent>` (`backend.ts`'s `resolve`) until it learns the real thread id. Codex
	 * doesn't create its rollout file until the first turn completes (OpenCode's session row only
	 * counts once it has a user message), which can be well after the
	 * tab opens — this keeps retrying for as long as the tab stays open (checked each iteration via
	 * `findTerminalView`), rather than giving up after a fixed window, so a tab left idle for a
	 * while before its first message still gets linked once one is sent. Once found: links
	 * `sessions.json` (`linkAgentSession` — design.md §3.3), rescans so the row appears under that
	 * id, and swaps every open tab for `placeholderId` (normally one, but a split can make several)
	 * over to it (`TerminalView.relinkId`) so `id` is the real id everywhere from then on — row
	 * matching, `sendCommand` route ①, and the saved workspace layout.
	 */
	private async resolveAgentSession(agent: AgentId, placeholderId: string, cwd: string): Promise<void> {
		try {
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
					const { thread } = await resolve(this.agentSessionsPath(), this.vaultPath(), agent, pid, since, cwd).catch(
						() => ({ thread: null, transcript: null })
					);
					if (thread) {
						this.linkAgentSession(agent, thread, cwd, placeholderId);
						this.relinkTerminalViews(placeholderId, thread);
						return;
					}
					await sleep(RESOLVE_POLL_MS);
				}
			} finally {
				client.close();
			}
		} finally {
			this.unresolvedIds.delete(placeholderId);
		}
	}

	/**
	 * Writes/overwrites `sessions.json`'s daemon link for a Codex/OpenCode session (`sessions[id] =
	 * {agent, cwd, daemon: daemonId}` — design.md §3.3) and rescans so the row picks it up. Called
	 * both by `resolveAgentSession` (the first link, keyed by the real thread id it just learned) and by
	 * `TerminalView.startSession`'s resume-after-daemon-restart relaunch (re-linking the same
	 * thread id to a brand-new `daemonId` — the daemon has no rename op, so the old one just stops
	 * being referenced once a new PTY exists under a different id).
	 */
	linkAgentSession(agent: AgentId, id: string, cwd: string, daemonId: string): void {
		try {
			updateStore(this.storePath(), (store) => {
				// Keeps a name the user already gave (OpenCode stores it here — see `renameSession`),
				// or the one given while the session was still under its placeholder id.
				const name = this.pendingNames.get(daemonId) ?? store.sessions[id]?.name;
				store.sessions[id] = { agent, cwd, daemon: daemonId, ...(name ? { name } : {}) };
			});
			this.index.refreshStore();
			// The tab is about to be keyed by the real id; until its row exists (a session is listed
			// once it has a user message) the title still shows the name.
			const pending = this.pendingNames.get(daemonId);
			if (pending !== undefined) {
				this.pendingNames.delete(daemonId);
				this.pendingNames.set(id, pending);
			}
			void this.index.rescan();
		} catch (err) {
			this.notifyLockError(err);
		}
	}

	/** The name given to an OpenCode tab that has no row yet (`id` = the tab's current id), if any. */
	pendingName(id: string): string | undefined {
		return this.pendingNames.get(id);
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
	 * for a given row/session id. The same as `id` for everything except a linked Codex/OpenCode
	 * session (see `resolveAgentSession`), where the row's own id (the real thread id) and the daemon's
	 * tracked id (`TerminalView.daemonId`) differ — `sessions.json`'s `daemon` field on that entry
	 * is the link. Not used for route ① (`findTerminalView`) — an open tab's own `sessionId` is
	 * already the real id post-relink, so that lookup uses `id` directly. Swallows a lock/read
	 * failure by falling back to `id` unchanged — a transient store error shouldn't block sending a
	 * command entirely.
	 *
	 * `sessions` (the daemon's current list) wins over the link when it holds `id` itself: a linked
	 * session resumed from its row runs under its real id, while the link still names the
	 * placeholder of an earlier, since-ended run.
	 */
	private daemonIdFor(id: string, sessions?: DaemonSession[]): string {
		if (sessions?.some((s) => s.id === id)) {
			return id;
		}
		try {
			return loadStore(this.storePath()).sessions[id]?.daemon || id;
		} catch {
			return id;
		}
	}

	/** Rename: sends `/rename` right away (even without a tab). OpenCode has no `/rename` — its
	 * name goes into `sessions.json` instead and the index overlays it on the row; nothing is
	 * sent to the TUI. */
	async renameSession(id: string, name: string): Promise<void> {
		const view = this.findTerminalView(id);
		let stored: string | undefined;
		try {
			stored = loadStore(this.storePath()).sessions[id]?.agent;
		} catch {
			stored = undefined;
		}
		const route = renameRoute(
			sessionAgentOf({ tab: view?.sessionAgent, row: this.index.sessions.get(id)?.agent, stored }),
			this.unresolvedIds.has(id)
		);
		if (route !== "command") {
			// The tab title shows the name at once, also while the session has no row yet.
			this.pendingNames.set(id, name);
			view?.refreshTitle();
			if (route === "pending") {
				// Still under the placeholder id: `linkAgentSession` writes it once the id is known.
				return;
			}
			try {
				updateStore(this.storePath(), (store) => {
					const entry = store.sessions[id] ?? {
						agent: "opencode",
						cwd: this.index.sessions.get(id)?.cwd ?? view?.getCwd() ?? "",
					};
					store.sessions[id] = { ...entry, name };
				});
			} catch (err) {
				this.notifyLockError(err);
				return;
			}
			this.index.refreshStore();
			await this.index.rescan([id]);
			return;
		}
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
	// session currently is. Every route sends the same shape of sequence (`commandChunks`): for
	// Claude, Ctrl+S (`chat:stash` — stashes the draft if there is one, does nothing if empty;
	// Claude Code-specific, so skipped for any other agent, which may not treat Ctrl+S as
	// harmless) → the command as bracketed paste (goes in as one block without opening `/`
	// completion — a standard terminal convention, not Claude-specific, so kept for every agent)
	// → the submit sequence (the configured submit key's for Claude and Codex, see
	// `terminal.ts`'s `sendSubmit`; always plain `\r` for OpenCode, which runs the highlighted
	// popup command on it in either mode). The stashed draft
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
			await this.sendViaView(view, text);
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
			const daemonId = this.daemonIdFor(id, sessions);
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

	/** Stash (Claude only) → command as bracketed paste → submit sequence (`submitSequence`: the
	 * configured submit key for Claude and Codex, T-108 — same reasoning as `views/terminal.ts`'s
	 * `sendSubmit()`; always `\r` for OpenCode, see below). */
	private commandChunks(text: string, agent: AgentId, draft: boolean): string[] {
		// Ctrl+S (`chat:stash`) only over a draft: on an empty box it brings a previously stashed
		// draft back instead, and the command would be pasted after it.
		const stash = agent === "claude" && draft ? STASH : "";
		// OpenCode's slash popup answers to `\r` only (`\n` leaves it open), and `\r` runs the
		// highlighted command whichever submit key is configured, so commands always end in `\r`.
		const submit = agent === "opencode" ? "\r" : submitSequence(this.settings, agent);
		const pasted = stash + PASTE_BEGIN + text + PASTE_END;
		// Claude Code: a bare command (`/compact`) leaves the slash-command completion list open, and
		// that list swallows a rebound submit key (meta+Enter). Tab accepts the completion first; it
		// goes in its own write, after the list has had a moment to appear, and the submit after it.
		if (agent === "claude" && !text.includes(" ")) {
			return [pasted, "\t", submit];
		}
		// Codex: a bare command needs a trailing space to close its popup, then the submit key.
		if (agent === "codex" && !text.includes(" ")) {
			return [PASTE_BEGIN + text + " " + PASTE_END, submit];
		}
		// OpenCode: `\r` runs the highlighted popup command only once the popup is up; arriving with
		// the paste, it's read as Return in the input box (a newline, with the managed keybinds).
		if (agent === "opencode") {
			return [pasted, submit];
		}
		return [pasted + submit];
	}

	/** Writes `commandChunks` through `write`, pausing `COMMAND_CHUNK_GAP_MS` between chunks.
	 * `draft`: whether the input box holds a draft to stash first (known only for an open tab). */
	private async writeCommand(write: (data: Buffer) => void, text: string, agent: AgentId, draft = false): Promise<void> {
		const chunks = this.commandChunks(text, agent, draft);
		for (let i = 0; i < chunks.length; i++) {
			if (i > 0) {
				await sleep(COMMAND_CHUNK_GAP_MS);
			}
			write(Buffer.from(chunks[i], "utf8"));
		}
	}

	/** Route ①: write straight to that tab. */
	private sendViaView(view: TerminalView, text: string): Promise<void> {
		return this.writeCommand((data) => view.sendBytes(data), text, asAgentId(view.sessionAgent), view.promptHasDraft() === true);
	}

	/** Route ②: attach temporarily and write. */
	private async sendViaAttach(client: DaemonClient, id: string, text: string, agent: string): Promise<void> {
		const res = await client.attach(id, HEADLESS_COLS, HEADLESS_ROWS);
		if (!res.ok) {
			throw new Error(t("error.attachFailed", { error: res.error ?? "unknown" }));
		}
		try {
			await this.writeCommand((data) => client.writeInput(data), text, asAgentId(agent));
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
		let lastOutputAt: number | null = null;
		const noteOutput = (): void => {
			lastOutputAt = Date.now();
		};
		client.on("data", noteOutput);
		client.on("replay", noteOutput);
		let started = false;
		/** Ends the background process and forgets it — every way out of here but success. */
		const tearDown = async (): Promise<void> => {
			if (!started) {
				return;
			}
			await client.kill(id).catch(() => undefined);
			await Promise.race([exited, sleep(WAIT_KILL_MS)]);
			await client.detach().catch(() => undefined);
			await client.forget(id).catch(() => undefined);
		};
		try {
			const agent = asAgentId(row.agent);
			const agentSettings = this.settings.agents[agent];
			const bin = await resolveAgentBinary(agent, agentSettings.path, Platform.isMacOS);
			// `AGENT_SESSIONS_VAULT`/`withBinDirOnPath`: same reason as terminal.ts's startSession.
			const env = withBinDirOnPath(
				{
					...(await loginEnv(Platform.isMacOS)),
					...this.editorEnv(agent),
					AGENT_SESSIONS_VAULT: this.vaultPath(),
					...parseEnvLines(agentSettings.env),
				},
				bin
			);
			const argv = await this.launchArgv(agent, bin, id, false);
			const res = await client.start({
				id,
				agent: row.agent || "claude",
				cwd: row.cwd || this.vaultPath(),
				argv,
				env,
				cols: HEADLESS_COLS,
				rows: HEADLESS_ROWS,
			});
			if (!res.ok) {
				throw new Error(t("error.startFailed", { error: res.error ?? "unknown" }));
			}
			started = true;
			const attached = await client.attach(id, HEADLESS_COLS, HEADLESS_ROWS);
			if (!attached.ok) {
				throw new Error(t("error.attachFailed", { error: attached.error ?? "unknown" }));
			}
			const registry = this.index.registry;
			const ready = (timeoutMs: number): Promise<boolean> =>
				agent === "opencode"
					? waitUntilReady({
							agent,
							status: () => registry.get(id)?.status ?? null,
							lastOutputAt: () => lastOutputAt,
							now: () => Date.now(),
							sleep,
							timeoutMs,
							quietMs: OPENCODE_QUIET_MS,
							pollMs: 250,
						})
					: registry.waitFor(id, "idle", timeoutMs);
			if (!(await ready(WAIT_IDLE_MS))) {
				throw new Error(t("error.agentStartWaitFailed", { name: t(AGENT_DISPLAY_NAME_KEY[agent]) }));
			}
			await this.writeCommand((data) => client.writeInput(data), text, agent);
			await registry.waitFor(id, "busy", WAIT_BUSY_MS);
			if (!(await ready(WAIT_IDLE_MS))) {
				throw new Error(t("error.replyWaitFailed"));
			}
			await this.writeCommand((data) => client.writeInput(data), "/exit", agent);
			const timeout = new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), WAIT_EXIT_MS));
			if ((await Promise.race([exited, timeout])) === "timeout") {
				await tearDown();
			} else {
				await client.detach().catch(() => undefined);
				await client.forget(id).catch(() => undefined);
			}
			void this.index.rescan([id]);
		} catch (err) {
			await tearDown();
			throw err;
		} finally {
			this.headless.delete(id);
			notice.hide();
		}
	}

	/** End session: confirm → `kill`, addressed by the daemon's own id (`daemonIdFor` — a linked
	 * Codex session's row id isn't one the daemon knows). */
	endSession(id: string): void {
		new ConfirmModal(this.app, t("confirm.endSession.message"), t("action.endSession"), () => {
			void (async () => {
				let client: DaemonClient | null = null;
				try {
					client = await ensureDaemon(this.sockPath(), this.agentSessionsPath());
					await client.hello("plugin");
					const list = await client.list();
					const sessions = (list.sessions as DaemonSession[] | undefined) ?? [];
					const res = await client.kill(this.daemonIdFor(id, sessions));
					if (!res.ok) {
						throw new Error(res.error ?? "unknown");
					}
					void this.refreshUntilExited(id);
				} catch (err) {
					new Notice(t("notice.endFailed", { error: messageOf(err) }));
				} finally {
					client?.close();
				}
			})();
		}).open();
	}

	/** Re-reads the daemon's list once a second (for up to `END_REFRESH_MAX_MS`, the kill grace
	 * plus a margin) until the row of `id` shows as exited, so an ended session leaves "Running"
	 * without a rescan — nothing else prompts a re-read for a Codex/OpenCode session without a tab. */
	private async refreshUntilExited(id: string): Promise<void> {
		const until = Date.now() + END_REFRESH_MAX_MS;
		while (Date.now() < until) {
			await sleep(1000);
			await this.index.refreshLive();
			const row = this.index.sessions.get(id);
			if (!row || !row.daemon || row.exited !== null) {
				return;
			}
		}
	}

	/** Opens the session analytics modal. */
	showUsage(id: string): void {
		const row = this.index.sessions.get(id);
		const name = sessionDisplayName({ name: row?.name, label: row?.label, agent: row?.agent ?? "claude", id });
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
	 * ledger entry; name/label from the `Row` if there is one, agent from the `Row` or else the
	 * leaf's own persisted state — `sessionDisplayName`'s "New Claude Code session"/"New Codex
	 * session" fallback if neither has a name or label yet, T-106).
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
			const state = leaf.getViewState().state as { id?: string; agent?: string } | undefined;
			const id = typeof state?.id === "string" ? state.id : "";
			const row = id ? this.index.sessions.get(id) : undefined;
			const status: TerminalStatus = row ? rowTerminalStatus(row) : "detached";
			const iconName = TERMINAL_STATUS_ICON[status];
			const agent = row?.agent ?? state?.agent ?? "claude";
			const name = sessionDisplayName({ name: row?.name, label: row?.label, agent, id });

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

	/**
	 * On `busy|shell → idle`, notifies if that tab isn't in front or Obsidian isn't the active
	 * window. The idle transition usually lands before the periodic scan has picked up the
	 * session's first prompt, so a session with neither a name nor a label yet is rescanned
	 * first — otherwise the notice would show the agent's placeholder name.
	 */
	private async notifyIdle(id: string): Promise<void> {
		if (!this.settings.notifyOnIdle || this.headless.has(id)) {
			return;
		}
		const front = this.app.workspace.getActiveViewOfType(TerminalView);
		if (front?.sessionId === id && document.hasFocus()) {
			return;
		}
		const known = this.index.sessions.get(id);
		if (!known?.name && (!known?.label || known.label === id)) {
			await this.index.rescan([id]);
		}
		const row = this.index.sessions.get(id);
		const name = sessionDisplayName({ name: row?.name, label: row?.label, agent: row?.agent ?? "claude", id });
		const notice = new Notice(t("notice.waitingForInput", { name }), 8000);
		notice.noticeEl.addEventListener("click", () => void this.openSession(id));
	}

	private scheduleCleanupExited(): void {
		if (this.cleanupExitedTimer) {
			window.clearTimeout(this.cleanupExitedTimer);
		}
		this.cleanupExitedTimer = window.setTimeout(() => {
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
/** The whole settings tab on a platform this plugin can't run on. */
class UnsupportedSettingTab extends PluginSettingTab {
	display(): void {
		this.containerEl.empty();
		this.containerEl.createEl("p", { text: t("notice.unsupportedPlatform") });
	}
}

class AgentSessionsSettingTab extends PluginSettingTab {
	plugin: AgentSessionsPlugin;
	/** `ollama list`'s model names for OpenCode's model dropdown. Lives as long as the tab is open
	 * (`hide()` clears it), so redrawing the page never runs `ollama list` again. */
	private ollamaModels = new OllamaModelCache();

	constructor(app: import("obsidian").App, plugin: AgentSessionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		this.ollamaModels.reset();
	}

	/**
	 * Section order (T-118, correcting T-117's own first attempt): display (how the plugin
	 * looks/reads) → input (how a session receives a keystroke) → other (everything else — paths,
	 * sizes, counts with no natural home in the first two) → agents (which CLI to launch, and how)
	 * last. T-117 had put agents first and submit key right after it with no heading of its own —
	 * with no visual break between them, submit key read as if it were still part of Codex's own
	 * block (Agents' last agent) rather than its own section. Giving submit key its own "Input"
	 * heading fixes that regardless of where it sits, but moving agents to the very end (its own
	 * settings are the most involved on the page — two sub-headings, six rows each) also means
	 * every section above it is a short, uniform list, with nothing left to visually blend into.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName(t("settings.display.heading")).setHeading();

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

		new Setting(containerEl).setName(t("settings.input.heading")).setHeading();
		this.renderSubmitKeySetting(containerEl);
		this.renderEditorKeySetting(containerEl);

		new Setting(containerEl).setName(t("settings.other.heading")).setHeading();

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

		this.renderBackendSetting(containerEl);
		this.renderAgentSkillsSetting(containerEl);

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

		this.renderAgentsSetting(containerEl);
	}

	/**
	 * The "Agents" section (T-117: one sub-heading per agent, replacing the old flat list where
	 * both agents' "Executable" and "Environment variables" rows looked identical and only their
	 * position told them apart). Each agent's block: an icon+name heading with its enabled toggle
	 * on the same row, then the path field (empty = auto-detect), the multi-line "environment
	 * variables" field (`KEY=VALUE` per line), and last a "Find again" button with its own result
	 * text (path/version once run, or "Enable" if it found a still-disabled agent) — one button
	 * per agent, re-detecting just that agent, not both (a click on Codex's button has no reason
	 * to also re-probe Claude's binary). A disabled agent's path/env/result rows are dimmed (not
	 * hidden — the settings are still there to edit before flipping it back on), only its heading
	 * row stays full-strength. The enabled toggle refuses to turn off the last remaining enabled
	 * agent (at least one must stay on). Never flips a toggle on its own from detection — that
	 * only happens automatically once, on a genuine first run (see `main.ts`'s `onload`).
	 */
	private renderAgentsSetting(containerEl: HTMLElement): void {
		const sectionEl = containerEl.createDiv();
		const detected: Partial<Record<AgentId, string | null>> = {};
		/** `<bin> --version` for whichever entries in `detected` have one, filled in after detection
		 * (`agentVersion` is a second, separate call — no reason to hold up showing the path on it). */
		const versions: Partial<Record<AgentId, string | null>> = {};
		const detecting: Partial<Record<AgentId, boolean>> = {};

		const redraw = (): void => {
			sectionEl.empty();
			new Setting(sectionEl).setName(t("settings.agents.heading")).setHeading();
			sectionEl.createDiv({ cls: "setting-item-description agent-sessions-agents-desc", text: t("settings.agents.desc") });

			for (const id of AGENT_IDS) {
				const agentSettings = this.plugin.settings.agents[id];
				const agentEl = sectionEl.createDiv({ cls: "agent-sessions-settings-agent" });

				const heading = new Setting(agentEl).setHeading();
				const iconEl = heading.nameEl.createSpan({ cls: "agent-sessions-settings-agent-icon" });
				setIcon(iconEl, AGENT_ICON_ID[id]);
				heading.nameEl.createSpan({ text: t(AGENT_DISPLAY_NAME_KEY[id]) });
				heading.addToggle((toggle) =>
					toggle.setValue(agentSettings.enabled).onChange(async (value) => {
						if (!value && AGENT_IDS.filter((other) => other !== id).every((other) => !this.plugin.settings.agents[other].enabled)) {
							new Notice(t("notice.needsOneAgentEnabled"));
							toggle.setValue(true);
							return;
						}
						agentSettings.enabled = value;
						await this.plugin.saveSettings();
						// T-108: Codex's config.toml follows the switch — the key lines and the
						// status_line default when it's enabled, the key lines taken away
						// again when it's disabled.
						if (id === "codex") {
							this.plugin.noticeConfigResult(this.plugin.syncCodexConfig(), "notice.codexConfigWritten");
						}
						// OpenCode's status comes from a plugin file the program installs into
						// OpenCode's own config folder — put it there right when it's enabled,
						// and take it away again when it's disabled (it would keep writing status
						// files for an agent nobody is tracking).
						if (id === "opencode") {
							void this.plugin.installOpencodePlugin({ mode: value ? "install" : "remove", notify: true });
							// Its tui.json submit-key keybinds follow the same switch.
							this.plugin.syncOpencodeTui();
						}
						// The skills follow the enabled agents (a disabled agent's copies go).
						void this.plugin.installAgentSkills({ notify: true });
						redraw();
					})
				);

				const bodyEl = agentEl.createDiv({
					cls: agentSettings.enabled ? "agent-sessions-settings-agent-body" : "agent-sessions-settings-agent-body is-disabled",
				});

				new Setting(bodyEl)
					.setName(t("settings.agents.path.name"))
					.setDesc(t("settings.agents.path.desc"))
					.addText((text) =>
						text.setValue(agentSettings.path).onChange(async (value) => {
							agentSettings.path = value;
							await this.plugin.saveSettings();
						})
					);

				new Setting(bodyEl)
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

				if (id === "opencode") {
					this.renderOpencodeLaunch(bodyEl, agentSettings);
				}

				const resultSetting = new Setting(bodyEl);
				if (id in detected) {
					const found = detected[id];
					const version = versions[id];
					const text = found
						? version
							? t("settings.agents.detected.foundWithVersion", { path: found, version })
							: t("settings.agents.detected.found", { path: found })
						: t("settings.agents.detected.notFound");
					resultSetting.descEl.createDiv({ cls: "agent-sessions-agent-detected", text });
					// A user with settings already saved never runs `autoDetectAgentsOnFirstRun` — if
					// "Find again" now finds an agent that's still off (e.g. installed after that
					// first run, or found only once the search order below covered a version manager),
					// offer to flip it on right here rather than making them go find the toggle above.
					if (found && !agentSettings.enabled) {
						resultSetting.addButton((button) =>
							button.setButtonText(t("settings.agents.detected.enable")).onClick(async () => {
								agentSettings.enabled = true;
								await this.plugin.saveSettings();
								redraw();
							})
						);
					}
				}
				resultSetting.addButton((button) => {
					button.setButtonText(t("settings.agents.detect.name")).onClick(async () => {
						try {
							// Also re-probes the interactive-shell PATH a session launches with
							// (`loginEnv`'s own cache) — otherwise "Find again" could find a binary
							// while a session started right after still launches with the stale PATH.
							resetLoginEnvCache();
							// A fresh redraw right away (rather than calling this button's own
							// `setDisabled` in place) so it's disabled the same way every other
							// state change here shows up — through `detecting[id]` and `redraw()`,
							// not a mix of direct component mutation and rebuilding from scratch.
							detecting[id] = true;
							redraw();
							const found = await detectAgent(id, Platform.isMacOS);
							detected[id] = found;
							versions[id] = null;
							redraw();
							versions[id] = found ? await agentVersion(found) : null;
						} finally {
							detecting[id] = false;
							redraw();
						}
					});
					button.setDisabled(!!detecting[id]);
				});
			}
		};

		redraw();
	}

	/**
	 * OpenCode's two launch settings: "Launch with" (`opencode` / `ollama launch opencode`) and,
	 * for the latter, the Ollama model — a dropdown of `ollama list`'s models next to a free-text
	 * field. The model list is loaded once per open settings tab (`ollamaModels`); it fills the
	 * dropdown in place, so the text field keeps its focus and nothing else on the page is redrawn.
	 */
	private renderOpencodeLaunch(bodyEl: HTMLElement, agentSettings: AgentSettings): void {
		const modelEl = bodyEl.createDiv();
		let fillPicker: (() => void) | null = null;
		const loadNames = async (): Promise<string[]> => {
			const ollamaBin = await locateProgram("ollama", Platform.isMacOS);
			return ollamaBin ? await listOllamaModels(ollamaBin) : [];
		};
		const drawModel = (): void => {
			modelEl.empty();
			fillPicker = null;
			if (agentSettings.launchVia !== "ollama") {
				return;
			}
			let textEl: HTMLInputElement | null = null;
			let picker: DropdownComponent | null = null;
			new Setting(modelEl)
				.setName(t("settings.agents.ollamaModel.name"))
				.setDesc(t("settings.agents.ollamaModel.desc"))
				.addDropdown((dropdown) => {
					picker = dropdown;
					dropdown.onChange(async (value) => {
						if (!value) {
							return;
						}
						agentSettings.ollamaModel = value;
						if (textEl) {
							textEl.value = value;
						}
						await this.plugin.saveSettings();
					});
				})
				.addText((text) => {
					textEl = text.inputEl;
					text
						.setPlaceholder(t("settings.agents.ollamaModel.placeholder"))
						.setValue(agentSettings.ollamaModel ?? "")
						.onChange(async (value) => {
							agentSettings.ollamaModel = value.trim();
							await this.plugin.saveSettings();
						});
				});
			fillPicker = () => {
				if (!picker) {
					return;
				}
				const models = this.ollamaModels.list ?? [];
				picker.selectEl.empty();
				picker.addOption("", t("settings.agents.ollamaModel.pick"));
				for (const name of models) {
					picker.addOption(name, name);
				}
				picker.setValue(models.includes(agentSettings.ollamaModel ?? "") ? (agentSettings.ollamaModel ?? "") : "");
			};
			fillPicker();
			void this.ollamaModels.ensure(loadNames, () => {
				if (modelEl.isConnected) {
					fillPicker?.();
				}
			});
		};

		new Setting(bodyEl)
			.setName(t("settings.agents.launchVia.name"))
			.setDesc(t("settings.agents.launchVia.desc"))
			.addDropdown((dropdown) => {
				for (const via of OPENCODE_LAUNCH_VIA) {
					dropdown.addOption(via, t(`settings.agents.launchVia.${via}`));
				}
				dropdown.setValue(agentSettings.launchVia ?? "opencode").onChange(async (value) => {
					agentSettings.launchVia = value as OpencodeLaunchVia;
					await this.plugin.saveSettings();
					drawModel();
				});
			});
		// The model row sits after the "Launch with" row, whatever order they were created in.
		bodyEl.appendChild(modelEl);
		drawModel();
	}

	/** Language: auto / Japanese / English. Changing it calls `setLang` → `saveSettings()`
	 * (each view, and this tab itself, redraws on `settings-changed`). */
	/**
	 * The `agent-sessions` program: which one is in use, and the install / reinstall / remove
	 * buttons for the copy installed from inside the plugin. A program set in the path field
	 * below, or linked into `~/bin` by `install.sh`, is only reported — the plugin didn't put it
	 * there, so it doesn't offer to replace or remove it.
	 */
	private renderBackendSetting(containerEl: HTMLElement): void {
		const plugin = this.plugin;
		const setting = new Setting(containerEl).setName(t("settings.backend.name"));
		const bundled = plugin.bundled;
		const inUse = plugin.agentSessionsPath();
		if (!plugin.backendAvailable()) {
			setting.setDesc(t("settings.backend.missing"));
			setting.addButton((button) =>
				button
					.setButtonText(t("action.installBackend"))
					.setCta()
					.onClick(() => plugin.openInstallBackend(() => this.display()))
			);
			return;
		}
		if (!bundled || inUse !== launcherPath(bundled.dir)) {
			setting.setDesc(t("settings.backend.external", { path: inUse }));
			return;
		}
		setting.setDesc(t("settings.backend.bundled", { dir: bundled.dir, python: bundled.python }));
		setting.addButton((button) =>
			button.setButtonText(t("action.reinstall")).onClick(() => plugin.openInstallBackend(() => this.display()))
		);
		setting.addButton((button) =>
			button
				.setButtonText(t("action.uninstallBackend"))
				.setWarning()
				.onClick(() => {
					new ConfirmModal(this.app, t("uninstall.confirm", { dir: bundled.dir }), t("action.uninstallBackend"), () => {
						void plugin.uninstallBackend().then(
							() => {
								new Notice(t("uninstall.done"));
								this.display();
							},
							(err: unknown) => new Notice(t("uninstall.failed", { error: String(err) }))
						);
					}).open();
				})
		);
	}

	/** The "Install agent skills" switch (default off): writes into the vault's skill folders. */
	private renderAgentSkillsSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.agentSkills.name"))
			.setDesc(t("settings.agentSkills.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.installAgentSkills).onChange(async (value) => {
					await this.plugin.setInstallAgentSkills(value);
				})
			);
	}

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
			// T-108: keeps Codex's own config.toml in step with the same setting.
			this.plugin.noticeConfigResult(this.plugin.syncCodexConfig(), "notice.codexConfigWritten");
			// The same for OpenCode's tui.json (restores it when the key goes back to Enter).
			this.plugin.syncOpencodeTui();
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
					const agents = this.plugin.settings.agents;
					const message =
						(agents.codex.enabled
							? t("confirm.writeKeybindings.messageWithCodex")
							: t("confirm.writeKeybindings.message")) +
						(agents.opencode.enabled ? t("confirm.writeKeybindings.opencodeNote") : "");
					new ConfirmModal(this.app, message, t("action.write"), () => applyAndSave(next)).open();
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
	 * The editor-key setting: the key that opens the agent's external editor (the built-in editor
	 * pane). A key other than Ctrl+G is written into Claude Code's `keybindings.json`, Codex's
	 * `config.toml` and OpenCode's `tui.json` after a confirmation; going back to Ctrl+G takes
	 * it out of the first two again (OpenCode's `editor_open` is written for every choice, since
	 * its own default is a different key).
	 */
	private renderEditorKeySetting(containerEl: HTMLElement): void {
		const keybindingsPath = this.plugin.keybindingsPath();

		const applyAndSave = (next: EditorKey) => {
			const result = applyEditorKey(keybindingsPath, next);
			this.plugin.settings.editorKey = next;
			void this.plugin.saveSettings();
			this.plugin.noticeConfigResult(result, "notice.keybindingsWritten");
			this.plugin.noticeConfigResult(this.plugin.syncCodexConfig(), "notice.codexConfigWritten");
			this.plugin.syncOpencodeTui();
			this.display();
		};

		new Setting(containerEl)
			.setName(t("settings.editorKey.name"))
			.setDesc(t("settings.editorKey.desc"))
			.addDropdown((dropdown) => {
				for (const key of EDITOR_KEYS) {
					dropdown.addOption(key, editorKeyLabel(key, Platform.isMacOS));
				}
				dropdown.setValue(this.plugin.settings.editorKey);
				dropdown.onChange((value) => {
					const next = value as EditorKey;
					const current = this.plugin.settings.editorKey;
					if (next === current) {
						return;
					}
					if (next !== DEFAULT_SETTINGS.editorKey) {
						const agents = this.plugin.settings.agents;
						const vars = { key: editorKeyLabel(next, Platform.isMacOS) };
						const message =
							(agents.codex.enabled
								? t("confirm.writeEditorKey.messageWithCodex", vars)
								: t("confirm.writeEditorKey.message", vars)) +
							(agents.opencode.enabled ? t("confirm.writeEditorKey.opencodeNote", vars) : "");
						new ConfirmModal(this.app, message, t("action.write"), () => applyAndSave(next)).open();
						// Revert the dropdown's appearance until confirmed (display() rebuilds it once applied).
						dropdown.setValue(current);
					} else {
						applyAndSave(next);
					}
				});
			});
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
