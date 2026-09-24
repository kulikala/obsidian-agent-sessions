// Reads Claude Code's screen layout (`tui` in `~/.claude/settings.json`). In `fullscreen`
// mode, Claude redraws the whole screen itself and owns scrolling — nothing accumulates in
// xterm's scrollback, so jumping via markers doesn't work. In that mode, jump is replaced with
// Claude's own scroll keys (PageUp/PageDown/End).

import * as fs from "node:fs";
import * as path from "node:path";

/** A pure function: whether `tui` is `fullscreen`, from `settings.json`'s contents (`null` if there's no file). */
export function isFullscreenTui(text: string | null): boolean {
	if (text === null) {
		return false;
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof data !== "object" || data === null) {
		return false;
	}
	return (data as { tui?: unknown }).tui === "fullscreen";
}

/** Claude Code's `settings.json` (under `CLAUDE_CONFIG_DIR` if it's set, otherwise `~/.claude`). */
export function claudeSettingsPath(homeDir: string, configDir?: string): string {
	return path.join(configDir || path.join(homeDir, ".claude"), "settings.json");
}

/** Reads the file and checks it. `false` if it can't be read. */
export function readFullscreenTui(settingsPath: string): boolean {
	let text: string | null;
	try {
		text = fs.readFileSync(settingsPath, "utf8");
	} catch {
		text = null;
	}
	return isFullscreenTui(text);
}
