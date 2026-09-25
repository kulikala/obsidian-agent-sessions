// Settings types and defaults. Doesn't depend on `obsidian` (plain data definitions only).

import { allLangs, type Lang, type LanguageSetting } from "./i18n";
import { MANAGER_STATUS_FILTERS, type ManagerStatusFilter } from "./sessions/terminal-status";

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

const FONT_FAMILY_MAC = 'Menlo, "Hiragino Sans", monospace';
/** Menlo doesn't exist on Linux, so non-macOS gets a monospace font with even CJK width plus a fallback. */
const FONT_FAMILY_NON_MAC = '"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace';

/** The default font. */
export function defaultFontFamily(isMac: boolean): string {
	return isMac ? FONT_FAMILY_MAC : FONT_FAMILY_NON_MAC;
}

/** The CLI-agent adapters the plugin knows how to launch. Codex is `enabled: false` by default —
 * `defaultAgentSettings()` is only what a saved-settings shape falls back to when nothing better
 * is known; `main.ts`'s first-run auto-detect is what actually decides what's enabled the very
 * first time (see its module comment). */
export type AgentId = "claude" | "codex";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex"];

/** Narrows a `Row`/tab's `agent` (`string`, since it round-trips through JSON with no runtime
 * validation) to a known `AgentId`, falling back to `claude` for anything else — a future/unknown
 * agent id degrades to the original single-agent behavior rather than failing to launch at all. */
export function asAgentId(agent: string): AgentId {
	return agent === "codex" ? "codex" : "claude";
}

export interface AgentSettings {
	enabled: boolean;
	/** Absolute path to the executable. Empty means auto-detect (`backend.ts`'s `resolveAgentBinary`). */
	path: string;
	/** `KEY=VALUE`, one per line, merged into the launched process's environment (and, for
	 * Codex's `CODEX_HOME` specifically, also into the environment `json …` calls get — see
	 * `backend.ts`'s `setAgentEnv`). Blank lines and lines starting with `#` are ignored. */
	env: string;
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
	};
}

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
	/** The side panel's detail area height (px). */
	sideDetailHeight: number;
	/** The display language. Default is `auto` (follows Obsidian's own language). */
	language: LanguageSetting;
	/** The manager's bottom analytics area (usage bar + per-category bar) height (px). */
	managerAnalysisHeight: number;
	/** Whether the manager's analytics area is collapsed. */
	managerAnalysisCollapsed: boolean;
	/** The manager's status-filter menu selection (next to the name filter). Default `all`. */
	managerStatusFilter: ManagerStatusFilter;
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
	sideDetailHeight: 220,
	language: "auto",
	managerAnalysisHeight: 240,
	managerAnalysisCollapsed: false,
	managerStatusFilter: "all",
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
	}
	return result;
}

/**
 * Layers saved data over the defaults. Drops keys that aren't in the current type (`newlineKey`)
 * and values that aren't in the current `SubmitKey` (`super+enter`, `meta+enter`, etc.), even if
 * they're left over in saved data — those get re-derived from keybindings.json at startup.
 * Migrates a pre-T-96 top-level `claudePath` into `agents.claude.path` (once — see below) and
 * validates `agents`/`lastNewSessionAgent` the same defensive way.
 *
 * `isMac` (default `true`): on non-macOS, drops a leftover `cmd+enter` in saved data (falling
 * back to `enter`), and uses the non-macOS default font only when `fontFamily` is absent from
 * saved data (a fresh install) — a `fontFamily` that was ever saved is never overwritten just
 * because the platform changed.
 */
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
	if (!SUBMIT_KEYS.includes(saved.submitKey as SubmitKey)) {
		delete saved.submitKey;
	}
	if (!isMac && saved.submitKey === "cmd+enter") {
		delete saved.submitKey;
	}
	// Pre-T-96 saved data has a single top-level `claudePath` instead of `agents`. Migrated once,
	// the first time saved data with no `agents` object of its own is merged.
	if (saved.agents === undefined && typeof saved.claudePath === "string" && saved.claudePath) {
		saved.agents = { ...defaultAgentSettings(), claude: { ...defaultAgentSettings().claude, path: saved.claudePath } };
	}
	delete saved.claudePath;
	saved.agents = mergeAgentSettings(saved.agents);
	if (!AGENT_IDS.includes(saved.lastNewSessionAgent as AgentId)) {
		delete saved.lastNewSessionAgent;
	}
	const defaults = isMac ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, fontFamily: defaultFontFamily(false) };
	return Object.assign({}, defaults, saved) as AgentSessionsSettings;
}
