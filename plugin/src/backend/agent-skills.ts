// What `agent-sessions setup --skills` / `--remove-skills` report. The last stdout line is
// `agent-skills: <status>` (agentsessions/cli/setup.py), so the plugin can say what actually
// happened to the skill files instead of assuming they were written.

import { basename, dirname } from "node:path";
import type { MessageKey } from "../i18n";
import { hookLauncher } from "./bundle";

export type AgentSkillsStatus = "installed" | "updated" | "unchanged" | "foreign" | "absent" | "failed" | "removed";

const STATUSES: readonly string[] = ["installed", "updated", "unchanged", "foreign", "absent", "failed", "removed"];

/** The arguments of `setup` that install the skills: it writes the ones the enabled agents need
 * and takes our copies away from the folders they don't. Running it again with the same input
 * changes nothing. */
export function agentSkillsArgs(vault: string, agents: string[], launcher: string): string[] {
	return ["setup", "--skills", "--vault", vault, "--agents", agents.join(","), "--command", launcher];
}

/**
 * What the skill files in the vault were last written for: the program version, the launcher they
 * name and the agents they were written for. It is kept in the plugin's settings; while it equals
 * the current one nothing is run on load.
 */
export function skillsStamp(version: string, launcher: string, agents: readonly string[]): string {
	return JSON.stringify([version, launcher, [...agents].sort()]);
}

export interface SkillsSyncInput {
	/** The program in use (`agentSessionsPath`). */
	program: string;
	exists: (path: string) => boolean;
	run: (program: string, args: string[]) => Promise<string>;
	/** The version of the program bundled with this plugin. */
	version: string;
	home: string;
	vault: string;
	/** The enabled agents. */
	agents: readonly string[];
	/** The stamp saved by the last successful run (`""` = none). */
	savedStamp: string;
	/** Run even when the saved stamp is current. */
	force?: boolean;
}

/** `ran: false`: nothing was done (no program, or the skill is current); the vault is untouched.
 * Otherwise what the program reported and the stamp to save. A failing run rejects, and the
 * caller keeps the old stamp so the next load tries again. */
export type SkillsSyncResult = { ran: false } | { ran: true; status: AgentSkillsStatus | null; stamp: string };

/** Installs (or brings up to date) the skill for the program in use. */
export async function syncAgentSkills(input: SkillsSyncInput): Promise<SkillsSyncResult> {
	if (!input.exists(input.program)) {
		return { ran: false };
	}
	const launcher = skillLauncher(input.program, input.home);
	const stamp = skillsStamp(input.version, launcher, input.agents);
	if (!input.force && input.savedStamp === stamp) {
		return { ran: false };
	}
	const stdout = await input.run(input.program, agentSkillsArgs(input.vault, [...input.agents], launcher));
	return { ran: true, status: parseAgentSkillsStatus(stdout), stamp };
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
	removed: null,
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
