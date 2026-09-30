import { describe, expect, it } from "vitest";
import {
	AGENT_SKILLS_NOTICE,
	agentSkillsArgs,
	parseAgentSkillsStatus,
	skillFolders,
	skillLauncher,
} from "../../src/backend/agent-skills";

describe("parseAgentSkillsStatus", () => {
	it("reads the status line at the end of the output", () => {
		expect(parseAgentSkillsStatus("agent skill: installed /x\nagent-skills: installed\n")).toBe("installed");
		expect(parseAgentSkillsStatus("no changes\nagent-skills: unchanged\n")).toBe("unchanged");
		expect(parseAgentSkillsStatus("x\nagent-skills: foreign")).toBe("foreign");
	});

	it("returns null without a (known) status line", () => {
		expect(parseAgentSkillsStatus("")).toBeNull();
		expect(parseAgentSkillsStatus("no changes\n")).toBeNull();
		expect(parseAgentSkillsStatus("agent-skills: exploding\n")).toBeNull();
	});
});

describe("agentSkillsArgs", () => {
	it("installs for the enabled agents, into the vault, naming the launcher", () => {
		expect(agentSkillsArgs("install", "/v", ["claude", "codex"], "$HOME/p/bin/agent-sessions")).toEqual([
			"setup", "--skills", "--vault", "/v", "--agents", "claude,codex", "--command", "$HOME/p/bin/agent-sessions",
		]);
	});

	it("update-only adds the flag that stops setup from creating anything", () => {
		expect(agentSkillsArgs("update-only", "/v", ["claude"], "l")).toContain("--update-only");
		expect(agentSkillsArgs("install", "/v", ["claude"], "l")).not.toContain("--update-only");
	});

	it("remove touches nothing but the skills of the given vault", () => {
		const args = agentSkillsArgs("remove", "/v", ["claude"], "l");
		expect(args).toEqual(["setup", "--remove-skills", "--vault", "/v"]);
		expect(args).not.toContain("--remove");
	});
});

describe("AGENT_SKILLS_NOTICE", () => {
	it("says something different for installed, updated, unchanged, foreign and removed", () => {
		const keys = (["installed", "updated", "unchanged", "foreign", "removed"] as const).map((s) => AGENT_SKILLS_NOTICE[s]);
		expect(new Set(keys).size).toBe(5);
		expect(keys.every((k) => k !== null)).toBe(true);
	});
});

describe("skillFolders", () => {
	it("gives Claude Code and Codex a folder each", () => {
		expect(skillFolders(["claude"])).toEqual([".claude/skills"]);
		expect(skillFolders(["codex"])).toEqual([".agents/skills"]);
		expect(skillFolders(["claude", "codex"])).toEqual([".claude/skills", ".agents/skills"]);
	});

	it("gives OpenCode a folder only when it is alone, since it reads the other two", () => {
		expect(skillFolders(["opencode"])).toEqual([".opencode/skills"]);
		expect(skillFolders(["claude", "opencode"])).toEqual([".claude/skills"]);
		expect(skillFolders(["codex", "opencode"])).toEqual([".agents/skills"]);
		expect(skillFolders([])).toEqual([]);
	});
});

describe("skillLauncher", () => {
	it("uses $HOME for a launcher under the home directory", () => {
		expect(skillLauncher("/Users/a/.local/share/agent-sessions/bin/agent-sessions", "/Users/a")).toBe(
			"$HOME/.local/share/agent-sessions/bin/agent-sessions"
		);
	});

	it("keeps a launcher outside the home directory, and a path that is not a launcher, as they are", () => {
		expect(skillLauncher("/opt/as/bin/agent-sessions", "/Users/a")).toBe("/opt/as/bin/agent-sessions");
		expect(skillLauncher("/Users/a/tools/as", "/Users/a")).toBe("/Users/a/tools/as");
	});
});
