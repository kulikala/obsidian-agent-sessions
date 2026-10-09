// Settings types and defaults. Doesn't depend on `obsidian` (plain data definitions only).

import { allLangs, type Lang, type LanguageSetting } from "./i18n";
import { MANAGER_STATUS_FILTERS, type ManagerStatusFilter } from "./sessions/terminal-status";
import { sanitizeProgress, type OnboardingProgress } from "./ui/onboarding-model";

export type Padding = "comfortable" | "compact" | "none";

/**
 * The submit key. Choosing anything other than `enter` makes Enter insert a newline instead,
 * and writes to keybindings.json. `alt+enter` is Option+Enter, `cmd+enter` is Command+Enter.
 */
export type SubmitKey = "enter" | "shift+enter" | "ctrl+enter" | "alt+enter" | "cmd+enter";

export const SUBMIT_KEYS: readonly SubmitKey[] = ["enter", "shift+enter", "ctrl+enter", "alt+enter", "cmd+enter"];

/**
 * The submit-key choices on non-macOS. `cmd+enter` (Command — on non-macOS that's Super) isn't
 * offered, since it doesn't reliably reach the browser (a window manager can grab it first).
 */
export const SUBMIT_KEYS_NON_MAC: readonly SubmitKey[] = ["enter", "shift+enter", "ctrl+enter", "alt+enter"];

/** The submit keys offered on this platform (`cmd+enter` is macOS-only). */
export function submitKeyChoices(isMac: boolean): readonly SubmitKey[] {
	return isMac ? SUBMIT_KEYS : SUBMIT_KEYS_NON_MAC;
}

export const SUBMIT_KEY_LABELS: Record<SubmitKey, string> = {
	enter: "Enter",
	"shift+enter": "Shift+Enter",
	"ctrl+enter": "Ctrl+Enter",
	"alt+enter": "Option+Enter",
	"cmd+enter": "Cmd+Enter",
};

/** The label of a submit-key choice in a dropdown: the Option key is Alt off macOS. */
export function submitKeyOptionLabel(key: SubmitKey, isMac: boolean): string {
	return !isMac && key === "alt+enter" ? "Alt+Enter" : SUBMIT_KEY_LABELS[key];
}

/**
 * The key that opens the agent's external editor (the built-in editor pane, reached through
 * `$VISUAL`). Each choice is one that Claude Code, Codex and OpenCode all leave free (or that
 * takes nothing they use), and that reaches the terminal on macOS and Linux (`terminal/keys.ts`).
 * `alt+g` is Option+G on macOS.
 */
export type EditorKey = "ctrl+g" | "ctrl+q" | "alt+g";

export const EDITOR_KEYS: readonly EditorKey[] = ["ctrl+g", "ctrl+q", "alt+g"];

/** The default editor key: Claude Code's and Codex's own, so neither needs a config change. */
export const DEFAULT_EDITOR_KEY: EditorKey = "ctrl+g";

const FONT_FAMILY_MAC = 'Menlo, "Hiragino Sans", monospace';
/** Menlo doesn't exist on Linux, so non-macOS gets a monospace font with even CJK width plus a fallback. */
const FONT_FAMILY_NON_MAC = '"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace';

/** The default font. */
export function defaultFontFamily(isMac: boolean): string {
	return isMac ? FONT_FAMILY_MAC : FONT_FAMILY_NON_MAC;
}

/** The CLI-agent adapters the plugin knows how to launch. Codex and OpenCode are `enabled: false` by default —
 * `defaultAgentSettings()` is only what a saved-settings shape falls back to when nothing better
 * is known; `main.ts`'s first-run auto-detect is what actually decides what's enabled the very
 * first time (see its module comment). */
export type AgentId = "claude" | "codex" | "opencode";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "opencode"];

/** Agents whose vendor exposes usage windows (5-hour, weekly, …). OpenCode has none, so it gets no
 * usage bar, category bars or rate-limit rows. */
export const AGENTS_WITHOUT_LIMITS: readonly AgentId[] = ["opencode"];

/**
 * The agents the usage bars / rate-limit rows are built for: the enabled ones that have usage
 * windows. With no agent enabled at all it is `["claude"]` (the always-there default); with only
 * OpenCode enabled it is empty — there is nothing to show, so no group is drawn.
 */
export function agentsWithLimits(agents: Record<AgentId, { enabled: boolean }>): AgentId[] {
	const enabled = AGENT_IDS.filter((id) => agents[id].enabled);
	if (enabled.length === 0) {
		return ["claude"];
	}
	return enabled.filter((id) => !AGENTS_WITHOUT_LIMITS.includes(id));
}

/** The agents whose config files are due their one-time setup on load (`agentConfigApplied`):
 * enabled, never set up, and — for OpenCode, whose status plugin the program writes — only once
 * the program is installed. Codex's `config.toml` is written by the plugin itself. */
export function agentConfigDue(
	settings: { agents: Record<AgentId, { enabled: boolean }>; agentConfigApplied: readonly AgentId[] },
	programInstalled: boolean
): AgentId[] {
	return (["codex", "opencode"] as const).filter(
		(id) =>
			settings.agents[id].enabled && !settings.agentConfigApplied.includes(id) && (id === "codex" || programInstalled)
	);
}

/** Narrows a `Row`/tab's `agent` (`string`, since it round-trips through JSON with no runtime
 * validation) to a known `AgentId`, falling back to `claude` for anything else — a future/unknown
 * agent id degrades to the original single-agent behavior rather than failing to launch at all. */
export function asAgentId(agent: string): AgentId {
	return agent === "codex" || agent === "opencode" ? agent : "claude";
}

/** How OpenCode gets started: straight (`opencode`) or through `ollama launch opencode`, which
 * injects an Ollama provider for the chosen local model. */
export type OpencodeLaunchVia = "opencode" | "ollama";

export const OPENCODE_LAUNCH_VIA: readonly OpencodeLaunchVia[] = ["opencode", "ollama"];

export interface AgentSettings {
	enabled: boolean;
	/** Absolute path to the executable. Empty means auto-detect (`backend.ts`'s `resolveAgentBinary`). */
	path: string;
	/** `KEY=VALUE`, one per line, merged into the launched process's environment (and, for
	 * Codex's `CODEX_HOME` specifically, also into the environment `json …` calls get — see
	 * `backend.ts`'s `setAgentEnv`). Blank lines and lines starting with `#` are ignored. */
	env: string;
	/** OpenCode only: how to start it. Absent for other agents. */
	launchVia?: OpencodeLaunchVia;
	/** OpenCode only: the model handed to `ollama launch opencode --model` when `launchVia` is
	 * `ollama`. Empty means unset (starting is refused rather than letting ollama open its picker). */
	ollamaModel?: string;
}

/** Parses an `AgentSettings.env` value (`KEY=VALUE` per line) into a plain object. Blank lines
 * and lines starting with `#` are skipped; a line with no `=` is skipped too (rather than, say,
 * treated as a key with an empty value — a stray line shouldn't silently set an empty-string env var). */
export function parseEnvLines(text: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const idx = line.indexOf("=");
		if (idx <= 0) {
			continue;
		}
		result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return result;
}

function defaultAgentSettings(): Record<AgentId, AgentSettings> {
	return {
		claude: { enabled: true, path: "", env: "" },
		codex: { enabled: false, path: "", env: "" },
		opencode: { enabled: false, path: "", env: "", launchVia: "opencode", ollamaModel: "" },
	};
}

/** Every agent unfolded by default. */
function defaultAnalysisFolded(): Record<AgentId, boolean> {
	return { claude: false, codex: false, opencode: false };
}

/** The activity calendar's period: a 7-day period aligned to the usage limit's reset, a
 * Sunday-start week, or one day. */
export type ActivityMode = "session" | "week" | "day";

export const ACTIVITY_MODES: readonly ActivityMode[] = ["session", "week", "day"];

/** The model "Organize names and categories" asks Claude Code for: Sonnet is the default, Haiku is faster. */
export type OrganizeModel = "sonnet" | "haiku";

export const ORGANIZE_MODELS: readonly OrganizeModel[] = ["sonnet", "haiku"];

/** The model token efficiency asks Claude Code for: Sonnet by default, Opus when asked. */
export type EfficiencyModel = "sonnet" | "opus";

export const EFFICIENCY_MODELS: readonly EfficiencyModel[] = ["sonnet", "opus"];

/** The ranges token efficiency's settings accept: the usage share (%) at which a window becomes
 * the range, and the budget (weighted tokens) otherwise. */
export const EFFICIENCY_THRESHOLD_RANGE = { min: 50, max: 95 } as const;
export const EFFICIENCY_BUDGET_RANGE = { min: 1_000_000, max: 100_000_000 } as const;

/** How far apart (minutes) two turns may be and still join into one block in the activity calendar. */
export const ACTIVITY_GAPS = [30, 60, 120] as const;
export type ActivityGap = (typeof ACTIVITY_GAPS)[number];

export interface AgentSessionsSettings {
	fontFamily: string;
	fontSize: number;
	padding: Padding;
	recentCount: number;
	notifyOnIdle: boolean;
	/** Per-agent enable/path/env settings, keyed by `AgentId`. */
	agents: Record<AgentId, AgentSettings>;
	/** The agent "New session" used last time, so the dialog defaults to it next time
	 * (meaningless with only one agent enabled — the dialog skips the picker entirely then). */
	lastNewSessionAgent: AgentId;
	agentSessionsPath: string;
	scrollback: number;
	/** The editor pane's height, as a % of the body. */
	editorHeight: number;
	/** The submit key (default `enter`). Re-derived from keybindings.json at startup. */
	submitKey: SubmitKey;
	/** The key that opens the agent's external editor (default `ctrl+g`). */
	editorKey: EditorKey;
	/** The side panel's detail area height (px). */
	sideDetailHeight: number;
	/** The display language. Default is `auto` (follows Obsidian's own language). */
	language: LanguageSetting;
	/** The manager's bottom analytics area (usage bar + per-category bar) height (px). */
	managerAnalysisHeight: number;
	/** Whether the manager's analytics area is collapsed. */
	managerAnalysisCollapsed: boolean;
	/** Whether each agent's own analytics section is folded —
	 * independent of `managerAnalysisCollapsed`, which folds the whole area. Only meaningful when
	 * more than one agent is enabled (a single section has no heading to fold at all). */
	managerAnalysisFolded: Record<AgentId, boolean>;
	/** The manager's status-filter menu selection (next to the name filter). Default `all`. */
	managerStatusFilter: ManagerStatusFilter;
	/** The model for name and category suggestions with Claude Code (Codex and OpenCode use their own default). */
	organizeModel: OrganizeModel;
	/** Token efficiency: a usage limit window at or above this share (%) becomes the range. */
	efficiencyThreshold: number;
	/** Token efficiency: otherwise, the newest calls up to this many weighted tokens. */
	efficiencyBudget: number;
	/** Token efficiency: the Claude Code model that reads the digest. */
	efficiencyModel: EfficiencyModel;
	/** The activity calendar's period mode. Default `session`. */
	activityMode: ActivityMode;
	/** The activity calendar's join gap (minutes). Default 30. */
	activityGapMinutes: ActivityGap;
	/** Agents hidden in the activity calendar (their lanes, blocks and card). */
	activityHiddenAgents: string[];
	/** The activity calendar's details panel width, as a % of the view (when a block is open). */
	activityDetailWidth: number;
	/** What the agent skill in the vault was last written for (`skillsStamp`); empty = never. Not
	 * shown in the settings tab. */
	agentSkillsStamp: string;
	/** The agents whose config files the plugin has set up at least once: Codex's `config.toml`
	 * (the `status_line` default and the keymap), OpenCode's status plugin and `tui.json`. An
	 * enabled agent missing here gets them on the next load (`agentConfigDue`); one listed here is
	 * left alone, so a `status_line` the user took out stays out. Not shown in the settings tab. */
	agentConfigApplied: AgentId[];
	/** The plugin version the welcome guide was last shown for; empty = never shown. Not shown in the settings tab. */
	onboardingShownVersion: string;
	/** Whether the welcome guide is shown again after an update. */
	onboardingOnUpdate: boolean;
	/** How far the welcome guide got, so it can be picked up again after a restart. `null` when it
	 * has never run. */
	onboardingProgress: OnboardingProgress | null;
	/** Whether the welcome guide shows its screenshots. */
	onboardingImages: boolean;
	/** The side panel's Remote Control toggle: on keeps it on across restarts, but only a click
	 * starts the server (`sessions/rc-server.ts`). Not shown in the settings tab. */
	rcServerEnabled: boolean;
}

export const DEFAULT_SETTINGS: AgentSessionsSettings = {
	fontFamily: FONT_FAMILY_MAC,
	fontSize: 13,
	padding: "comfortable",
	recentCount: 10,
	notifyOnIdle: true,
	agents: defaultAgentSettings(),
	lastNewSessionAgent: "claude",
	agentSessionsPath: "",
	scrollback: 5000,
	editorHeight: 40,
	submitKey: "enter",
	editorKey: DEFAULT_EDITOR_KEY,
	sideDetailHeight: 220,
	language: "auto",
	managerAnalysisHeight: 240,
	managerAnalysisCollapsed: false,
	managerAnalysisFolded: defaultAnalysisFolded(),
	managerStatusFilter: "all",
	organizeModel: "sonnet",
	efficiencyThreshold: 80,
	efficiencyBudget: 10_000_000,
	efficiencyModel: "sonnet",
	activityMode: "session",
	activityGapMinutes: 30,
	activityHiddenAgents: [],
	activityDetailWidth: 38,
	agentSkillsStamp: "",
	agentConfigApplied: [],
	onboardingShownVersion: "",
	onboardingOnUpdate: true,
	onboardingProgress: null,
	onboardingImages: true,
	rcServerEnabled: false,
};

/** Validates a saved `agents` value, entry by entry — an invalid or missing field falls back to
 * that one agent's own default rather than discarding the whole object (so a saved `codex.path`
 * survives even if, say, `codex.env` was somehow corrupted). */
function mergeAgentSettings(data: unknown): Record<AgentId, AgentSettings> {
	const defaults = defaultAgentSettings();
	const result = defaultAgentSettings();
	if (typeof data !== "object" || data === null) {
		return result;
	}
	const saved = data as Record<string, unknown>;
	for (const id of AGENT_IDS) {
		const entry = saved[id];
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const e = entry as Record<string, unknown>;
		result[id] = {
			enabled: typeof e.enabled === "boolean" ? e.enabled : defaults[id].enabled,
			path: typeof e.path === "string" ? e.path : defaults[id].path,
			env: typeof e.env === "string" ? e.env : defaults[id].env,
		};
		if (id === "opencode") {
			result[id].launchVia = OPENCODE_LAUNCH_VIA.includes(e.launchVia as OpencodeLaunchVia)
				? (e.launchVia as OpencodeLaunchVia)
				: "opencode";
			result[id].ollamaModel = typeof e.ollamaModel === "string" ? e.ollamaModel.trim() : "";
		}
	}
	return result;
}

/** Same defensive per-key merge as `mergeAgentSettings`, for the simpler `AgentId -> boolean`
 * shape — a missing or malformed entry for a given agent falls back to unfolded rather than
 * discarding the whole saved object (e.g. a value saved before a new agent id existed). */
function mergeAnalysisFolded(data: unknown): Record<AgentId, boolean> {
	const result = defaultAnalysisFolded();
	if (typeof data !== "object" || data === null) {
		return result;
	}
	const saved = data as Record<string, unknown>;
	for (const id of AGENT_IDS) {
		if (typeof saved[id] === "boolean") {
			result[id] = saved[id];
		}
	}
	return result;
}

/**
 * Layers saved data over the defaults. Drops keys that aren't in the current type (`newlineKey`)
 * and values that aren't in the current `SubmitKey` (`super+enter`, `meta+enter`, etc.), even if
 * they're left over in saved data — those get re-derived from keybindings.json at startup.
 * Migrates an older top-level `claudePath` into `agents.claude.path` (once — see below) and
 * validates `agents`/`lastNewSessionAgent` the same defensive way.
 *
 * `isMac` (default `true`): on non-macOS, drops a leftover `cmd+enter` in saved data (falling
 * back to `enter`), and uses the non-macOS default font only when `fontFamily` is absent from
 * saved data (a fresh install) — a `fontFamily` that was ever saved is never overwritten just
 * because the platform changed.
 */
function inRange(value: unknown, range: { min: number; max: number }): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= range.max;
}

export function mergeSettings(data: unknown, isMac = true): AgentSessionsSettings {
	const saved = (typeof data === "object" && data !== null ? { ...(data as Record<string, unknown>) } : {}) as Record<
		string,
		unknown
	>;
	delete saved.newlineKey;
	if (saved.language !== "auto" && !allLangs().includes(saved.language as Lang)) {
		delete saved.language;
	}
	if (!MANAGER_STATUS_FILTERS.includes(saved.managerStatusFilter as ManagerStatusFilter)) {
		delete saved.managerStatusFilter;
	}
	if (!ORGANIZE_MODELS.includes(saved.organizeModel as OrganizeModel)) {
		delete saved.organizeModel;
	}
	if (!inRange(saved.efficiencyThreshold, EFFICIENCY_THRESHOLD_RANGE)) {
		delete saved.efficiencyThreshold;
	}
	if (!inRange(saved.efficiencyBudget, EFFICIENCY_BUDGET_RANGE)) {
		delete saved.efficiencyBudget;
	}
	if (!EFFICIENCY_MODELS.includes(saved.efficiencyModel as EfficiencyModel)) {
		delete saved.efficiencyModel;
	}
	if (!ACTIVITY_MODES.includes(saved.activityMode as ActivityMode)) {
		delete saved.activityMode;
	}
	if (!ACTIVITY_GAPS.includes(saved.activityGapMinutes as ActivityGap)) {
		delete saved.activityGapMinutes;
	}
	if (!Array.isArray(saved.activityHiddenAgents) || !saved.activityHiddenAgents.every((a) => typeof a === "string")) {
		delete saved.activityHiddenAgents;
	}
	if (typeof saved.activityDetailWidth !== "number" || !(saved.activityDetailWidth >= 20 && saved.activityDetailWidth <= 70)) {
		delete saved.activityDetailWidth;
	}
	delete saved.installAgentSkills;
	if (typeof saved.agentSkillsStamp !== "string") {
		delete saved.agentSkillsStamp;
	}
	if (Array.isArray(saved.agentConfigApplied)) {
		saved.agentConfigApplied = AGENT_IDS.filter((id) => (saved.agentConfigApplied as unknown[]).includes(id));
	} else {
		delete saved.agentConfigApplied;
	}
	if (typeof saved.onboardingShownVersion !== "string") {
		delete saved.onboardingShownVersion;
	}
	if (typeof saved.onboardingOnUpdate !== "boolean") {
		delete saved.onboardingOnUpdate;
	}
	// Progress saved by another version of the guide (or mangled by hand) reads as no progress at
	// all, which starts the guide from the top rather than carrying a half-understood record along.
	saved.onboardingProgress = sanitizeProgress(saved.onboardingProgress);
	if (typeof saved.onboardingImages !== "boolean") {
		delete saved.onboardingImages;
	}
	if (typeof saved.rcServerEnabled !== "boolean") {
		delete saved.rcServerEnabled;
	}
	if (!SUBMIT_KEYS.includes(saved.submitKey as SubmitKey)) {
		delete saved.submitKey;
	}
	if (!EDITOR_KEYS.includes(saved.editorKey as EditorKey)) {
		delete saved.editorKey;
	}
	if (!isMac && saved.submitKey === "cmd+enter") {
		delete saved.submitKey;
	}
	// Older saved data has a single top-level `claudePath` instead of `agents`. Migrated once,
	// the first time saved data with no `agents` object of its own is merged.
	if (saved.agents === undefined && typeof saved.claudePath === "string" && saved.claudePath) {
		saved.agents = { ...defaultAgentSettings(), claude: { ...defaultAgentSettings().claude, path: saved.claudePath } };
	}
	delete saved.claudePath;
	saved.agents = mergeAgentSettings(saved.agents);
	saved.managerAnalysisFolded = mergeAnalysisFolded(saved.managerAnalysisFolded);
	if (!AGENT_IDS.includes(saved.lastNewSessionAgent as AgentId)) {
		delete saved.lastNewSessionAgent;
	}
	const defaults = isMac ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, fontFamily: defaultFontFamily(false) };
	return Object.assign({}, defaults, saved);
}
