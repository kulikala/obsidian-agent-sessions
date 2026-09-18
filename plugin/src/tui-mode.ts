// Claude Code の画面レイアウト（`~/.claude/settings.json` の `tui`）を読む（D-42）。
// `fullscreen` のとき Claude は全画面を自分で描き直し、スクロールも自分で持つ——xterm の
// スクロールバックには何も溜まらず、マーカーによるジャンプは成り立たない。そのときは
// ジャンプを Claude のスクロールキー（PageUp／PageDown／End）に置き換える。

import * as fs from "node:fs";
import * as path from "node:path";

/** `settings.json` の本文（無ければ `null`）から、`tui` が `fullscreen` かを判定する純関数。 */
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

/** Claude Code の `settings.json`（`CLAUDE_CONFIG_DIR` があればその下、無ければ `~/.claude`）。 */
export function claudeSettingsPath(homeDir: string, configDir?: string): string {
	return path.join(configDir || path.join(homeDir, ".claude"), "settings.json");
}

/** ファイルを読んで判定する。読めなければ `false`。 */
export function readFullscreenTui(settingsPath: string): boolean {
	let text: string | null;
	try {
		text = fs.readFileSync(settingsPath, "utf8");
	} catch {
		text = null;
	}
	return isFullscreenTui(text);
}
