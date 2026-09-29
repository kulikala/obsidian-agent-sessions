// What `agent-sessions setup --opencode` / `--remove-opencode` report. The last stdout line is
// `opencode-plugin: <status>` (agentsessions/cli/setup.py), so the plugin can say what actually
// happened to OpenCode's status plugin file instead of assuming it was installed.

import type { MessageKey } from "../i18n";

export type OpencodePluginStatus = "installed" | "updated" | "unchanged" | "foreign" | "absent" | "failed" | "removed";

const STATUSES: readonly string[] = ["installed", "updated", "unchanged", "foreign", "absent", "failed", "removed"];

/** How to call `setup` for the plugin file. `update-only` refreshes an existing file and never
 * creates one; `remove` deletes our file and nothing else (Claude Code's hooks stay). */
export type OpencodePluginMode = "install" | "update-only" | "remove";

export function opencodePluginArgs(mode: OpencodePluginMode): string[] {
	switch (mode) {
		case "install":
			return ["setup", "--opencode"];
		case "update-only":
			return ["setup", "--opencode", "--update-only"];
		case "remove":
			return ["setup", "--remove-opencode"];
	}
}

/** The status line at the end of `setup`'s stdout; `null` if there is none (an older program). */
export function parseOpencodePluginStatus(stdout: string): OpencodePluginStatus | null {
	const lines = stdout.split("\n").map((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = /^opencode-plugin:\s*(\w+)$/.exec(lines[i]);
		if (match) {
			return STATUSES.includes(match[1]) ? (match[1] as OpencodePluginStatus) : null;
		}
	}
	return null;
}

/** The notice for a status; `null` = nothing worth saying. */
export const OPENCODE_PLUGIN_NOTICE: Record<OpencodePluginStatus, MessageKey | null> = {
	installed: "notice.opencodePluginInstalled",
	updated: "notice.opencodePluginUpdated",
	unchanged: "notice.opencodePluginCurrent",
	foreign: "notice.opencodePluginForeign",
	absent: null,
	failed: null,
	removed: "notice.opencodePluginRemoved",
};
