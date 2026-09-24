// Settings types and defaults. Doesn't depend on `obsidian` (plain data definitions only).

import { allLangs, type Lang, type LanguageSetting } from "./i18n";

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

export interface AgentSessionsSettings {
	fontFamily: string;
	fontSize: number;
	padding: Padding;
	recentCount: number;
	notifyOnIdle: boolean;
	claudePath: string;
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
}

export const DEFAULT_SETTINGS: AgentSessionsSettings = {
	fontFamily: FONT_FAMILY_MAC,
	fontSize: 13,
	padding: "comfortable",
	recentCount: 10,
	notifyOnIdle: true,
	claudePath: "",
	agentSessionsPath: "",
	scrollback: 5000,
	editorHeight: 40,
	submitKey: "enter",
	sideDetailHeight: 220,
	language: "auto",
	managerAnalysisHeight: 240,
	managerAnalysisCollapsed: false,
};

/**
 * Layers saved data over the defaults. Drops keys that aren't in the current type (`newlineKey`)
 * and values that aren't in the current `SubmitKey` (`super+enter`, `meta+enter`, etc.), even if
 * they're left over in saved data — those get re-derived from keybindings.json at startup.
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
	if (!SUBMIT_KEYS.includes(saved.submitKey as SubmitKey)) {
		delete saved.submitKey;
	}
	if (!isMac && saved.submitKey === "cmd+enter") {
		delete saved.submitKey;
	}
	const defaults = isMac ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, fontFamily: defaultFontFamily(false) };
	return Object.assign({}, defaults, saved) as AgentSessionsSettings;
}
