// What `agent-sessions setup --skills` / `--remove-skills` report. The last stdout line is
// `agent-skills: <status>` (agentsessions/cli/setup.py), so the plugin can say what actually
// happened to the skill files instead of assuming they were written.

import { basename, dirname } from "node:path";
import type { MessageKey } from "../i18n";
import { hookLauncher } from "./bundle";

export type AgentSkillsStatus = "installed" | "updated" | "unchanged" | "foreign" | "absent" | "failed" | "removed";

const STATUSES: readonly string[] = ["installed", "updated", "unchanged", "foreign", "absent", "failed", "removed"];

/** How to call `setup` for the skills. `install` writes the skills the enabled agents need and takes
 * our copies away from the folders they don't; `update-only` refreshes copies that are already there
 * and creates nothing; `remove` deletes every copy of ours. */
export type AgentSkillsMode = "install" | "update-only" | "remove";

export function agentSkillsArgs(mode: AgentSkillsMode, vault: string, agents: string[], launcher: string): string[] {
	if (mode === "remove") {
		return ["setup", "--remove-skills", "--vault", vault];
	}
	const args = ["setup", "--skills", "--vault", vault, "--agents", agents.join(","), "--command", launcher];
	return mode === "update-only" ? [...args, "--update-only"] : args;
}

/** The status line at the end of `setup`'s stdout; `null` if there is none (an older program). */
export function parseAgentSkillsStatus(stdout: string): AgentSkillsStatus | null {
	const lines = stdout.split("\n").map((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = /^agent-skills:\s*(\w+)$/.exec(lines[i]);
		if (match) {
			return STATUSES.includes(match[1]) ? (match[1] as AgentSkillsStatus) : null;
		}
	}
	return null;
}

/** The notice for a status; `null` = nothing worth saying. */
export const AGENT_SKILLS_NOTICE: Record<AgentSkillsStatus, MessageKey | null> = {
	installed: "notice.agentSkillsInstalled",
	updated: "notice.agentSkillsUpdated",
	unchanged: "notice.agentSkillsCurrent",
	foreign: "notice.agentSkillsForeign",
	absent: null,
	failed: null,
	removed: "notice.agentSkillsRemoved",
};

/**
 * How the skills should name the program: `$HOME/…` when it is under the home directory (a vault
 * synced between machines keeps working), else the path as is. Only a launcher at
 * `<dir>/bin/agent-sessions` gets the `$HOME` treatment; any other path is used verbatim.
 */
export function skillLauncher(programPath: string, home: string): string {
	if (basename(programPath) === "agent-sessions" && basename(dirname(programPath)) === "bin") {
		return hookLauncher(dirname(dirname(programPath)), home);
	}
	return programPath;
}

/**
 * The vault folders (relative) the enabled agents' skills go into — the same choice
 * `agentsessions/skills/__init__.py` makes: Claude Code's `.claude/skills`, Codex's `.agents/skills`,
 * and OpenCode's own `.opencode/skills` only when neither of those is wanted (OpenCode reads both).
 */
export function skillFolders(enabled: readonly string[]): string[] {
	const out: string[] = [];
	if (enabled.includes("claude")) {
		out.push(".claude/skills");
	}
	if (enabled.includes("codex")) {
		out.push(".agents/skills");
	}
	if (enabled.includes("opencode") && out.length === 0) {
		out.push(".opencode/skills");
	}
	return out;
}
