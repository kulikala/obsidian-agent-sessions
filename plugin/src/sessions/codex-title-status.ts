// Codex's own terminal-title text, parsed for busy/asking signals (T-108). Codex writes an OSC 0
// title itself (codex-rs/tui/src/terminal_title.rs) whenever its status changes — reading it back
// via xterm's `onTitleChange` gives a far more immediate signal than waiting for the next daemon
// poll of its rollout file, at the cost of only working while the user's own `tui.terminal_title`
// config still includes the "activity" item (Codex's own built-in default does; a customized one
// might not — this plugin deliberately doesn't manage that setting, see docs/design.md). Both
// markers below are Codex's own hardcoded English text/glyphs
// (codex-rs/tui/src/chatwidget/status_surfaces.rs, verified 2026-09-25 against codex-cli
// 0.154.0-alpha.6.2 — not something this plugin controls, and not guaranteed to stay the same in
// a future Codex release: if they change, classification just stops matching, and title-based
// detection silently falls back to the daemon's rollout-based status — nothing breaks).

/** Codex's own braille-pattern spinner frames, shown in the title while a turn is actively running. */
const CODEX_TITLE_SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Substring Codex's own title carries while blocked on user input (an approval prompt,
 * elicitation, etc) — the surrounding "[ ! ]"/"[ . ]" blink marker alternates every second, so
 * only this stable part is matched. */
const CODEX_TITLE_ACTION_REQUIRED_MARKER = "Action Required";

export type CodexTitleStatus = "working" | "asking" | null;

/**
 * Classifies Codex's own terminal-title text (read via xterm's `onTitleChange`). `null` means "no
 * signal either way" — the caller falls back to its existing (rollout-tail-based) status, not
 * "idle": Codex may simply not be writing the "activity" item into its title right now (e.g. the
 * user's own `tui.terminal_title` config doesn't include it), so a title with neither marker
 * isn't itself proof of being idle.
 */
export function classifyCodexTitleStatus(title: string): CodexTitleStatus {
	if (title.includes(CODEX_TITLE_ACTION_REQUIRED_MARKER)) {
		return "asking";
	}
	if (CODEX_TITLE_SPINNER_CHARS.some((ch) => title.includes(ch))) {
		return "working";
	}
	return null;
}
