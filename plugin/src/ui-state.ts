// 送信キーの記号を `~/.agents/sessions/ui.json` へ書く（T-71）。Python 側の
// `format_status_line` が読み、statusLine に付ける。obsidian には依存しない純粋な I/O。
// 書き方は `store.ts` の `saveStore` と同じ（tmp に書いて rename）。

import * as fs from "node:fs";
import * as path from "node:path";
import { submitKeyStatuslineSymbol } from "./keys";
import type { SubmitKey } from "./settings";

export interface UiState {
	submitKey: SubmitKey;
	submitSymbol: string;
}

/**
 * `runtimeDir`（`~/.agents/sessions`）へ `ui.json` を書く。`onload`・`saveSettings` から呼ぶ。
 * `isMac`（既定 `true`）は非 macOS 対応（§14）：非 macOS は statusLine 用の短い文字表記
 * （`C-⏎` など）を書く。
 */
export function writeUiState(runtimeDir: string, submitKey: SubmitKey, isMac = true): void {
	fs.mkdirSync(runtimeDir, { recursive: true });
	const state: UiState = { submitKey, submitSymbol: submitKeyStatuslineSymbol(submitKey, isMac) };
	const data = JSON.stringify(state, null, 1);
	const filePath = path.join(runtimeDir, "ui.json");
	const tmp = path.join(runtimeDir, `.ui.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, data, "utf8");
	try {
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// no-op
		}
		throw err;
	}
}
