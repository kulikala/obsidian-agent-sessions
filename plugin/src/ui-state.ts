// Writes the submit-key symbol to `~/.agents/sessions/ui.json`. Read by the Python side's
// `format_status_line`, which attaches it to the statusLine. Plain I/O with no dependency on
// `obsidian`. Writes the same way `store.ts`'s `saveStore` does (tmp, then rename).

import * as fs from "node:fs";
import * as path from "node:path";
import { submitKeyStatuslineSymbol } from "./keys";
import type { SubmitKey } from "./settings";

export interface UiState {
	submitKey: SubmitKey;
	submitSymbol: string;
}

/**
 * Writes `ui.json` into `runtimeDir` (`~/.agents/sessions`). Called from `onload` and
 * `saveSettings`. `isMac` (default `true`): on non-macOS, writes the short text form used for
 * the statusLine (e.g. `C-⏎`).
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
