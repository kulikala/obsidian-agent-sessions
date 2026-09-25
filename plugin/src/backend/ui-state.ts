// Writes the submit-key symbol and the resolved display language to
// `~/.agents/sessions/ui.json`. Read by the Python side (statusLine's `format_status_line`,
// among others) so it can match the plugin's own display language. Plain I/O with no dependency
// on `obsidian`. Writes the same way `store.ts`'s `saveStore` does (tmp, then rename).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Lang } from "../i18n";
import { submitKeyStatuslineSymbol } from "../terminal/keys";
import type { SubmitKey } from "../settings";

export interface UiState {
	submitKey: SubmitKey;
	submitSymbol: string;
	/** The resolved display language ("ja"/"en") — already resolved from "auto", never "auto" itself. */
	language: Lang;
	/** The currently-enabled agent ids (`AgentId[]`, but kept as `string[]` here the same way the
	 * rest of this file avoids importing agent-specific types — see `agentsessions/agents/__init__.py`'s
	 * `enabled_agents()`, which reads this array as its fallback when `AGENT_SESSIONS_AGENTS` isn't set
	 * (outside a plugin-launched terminal — the TUI, a bare CLI invocation). */
	agents: string[];
}

/**
 * Writes `ui.json` into `runtimeDir` (`~/.agents/sessions`). Called from `onload` and
 * `saveSettings` (so it's rewritten whenever the display language or agent toggles change too,
 * since both always go through `saveSettings`). `isMac` (default `true`): on non-macOS, writes
 * the short text form used for the statusLine (e.g. `C-⏎`).
 */
export function writeUiState(
	runtimeDir: string,
	submitKey: SubmitKey,
	language: Lang,
	agents: string[],
	isMac = true
): void {
	fs.mkdirSync(runtimeDir, { recursive: true });
	const state: UiState = { submitKey, submitSymbol: submitKeyStatuslineSymbol(submitKey, isMac), language, agents };
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
