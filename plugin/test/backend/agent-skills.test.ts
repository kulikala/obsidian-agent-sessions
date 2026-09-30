import { describe, expect, it, vi } from "vitest";
import {
	AGENT_SKILLS_NOTICE,
	agentSkillsArgs,
	parseAgentSkillsStatus,
	skillFolders,
	skillLauncher,
	skillsStamp,
	syncAgentSkills,
	type SkillsSyncInput,
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
	it("installs for the given vault, agents and launcher, with no update-only or remove form", () => {
		expect(agentSkillsArgs("/v", ["claude", "codex"], "$HOME/p/bin/agent-sessions")).toEqual([
			"setup", "--skills", "--vault", "/v", "--agents", "claude,codex", "--command", "$HOME/p/bin/agent-sessions",
		]);
	});
});

describe("skillsStamp", () => {
	it("changes with the version, the launcher and the agents, not with the agents' order", () => {
		const base = skillsStamp("1+a", "/l", ["claude", "codex"]);
		expect(skillsStamp("1+a", "/l", ["codex", "claude"])).toBe(base);
		expect(skillsStamp("1+b", "/l", ["claude", "codex"])).not.toBe(base);
		expect(skillsStamp("1+a", "/m", ["claude", "codex"])).not.toBe(base);
		expect(skillsStamp("1+a", "/l", ["claude"])).not.toBe(base);
	});
});

describe("syncAgentSkills", () => {
	const input = (over: Partial<SkillsSyncInput> = {}): SkillsSyncInput => ({
		program: "/Users/a/bin/agent-sessions",
		exists: () => true,
		run: vi.fn(async () => "agent-skills: installed\n"),
		version: "1+a",
		home: "/Users/a",
		vault: "/v",
		agents: ["claude"],
		savedStamp: "",
		...over,
	});

	it("writes nothing into the vault while the program is missing", async () => {
		const run = vi.fn(async () => "");
		expect(await syncAgentSkills(input({ exists: () => false, run, force: true }))).toEqual({ ran: false });
		expect(run).not.toHaveBeenCalled();
	});

	it("installs when the skill was never written and returns the stamp to save", async () => {
		const i = input();
		const result = await syncAgentSkills(i);
		expect(i.run).toHaveBeenCalledWith("/Users/a/bin/agent-sessions", [
			"setup", "--skills", "--vault", "/v", "--agents", "claude", "--command", "$HOME/bin/agent-sessions",
		]);
		expect(result).toEqual({
			ran: true,
			status: "installed",
			stamp: skillsStamp("1+a", "$HOME/bin/agent-sessions", ["claude"]),
		});
	});

	it("skips while the saved stamp matches, and runs with force", async () => {
		const savedStamp = skillsStamp("1+a", "$HOME/bin/agent-sessions", ["claude"]);
		const idle = input({ savedStamp });
		expect(await syncAgentSkills(idle)).toEqual({ ran: false });
		expect(idle.run).not.toHaveBeenCalled();
		const forced = input({ savedStamp, force: true });
		expect((await syncAgentSkills(forced)).ran).toBe(true);
		expect(forced.run).toHaveBeenCalledTimes(1);
	});

	it("runs again when the version, the launcher or the agents changed", async () => {
		const savedStamp = skillsStamp("1+a", "$HOME/bin/agent-sessions", ["claude"]);
		for (const over of [
			{ version: "2+b" },
			{ program: "/opt/as/bin/agent-sessions" },
			{ agents: ["claude", "codex"] },
		]) {
			const i = input({ savedStamp, ...over });
			expect((await syncAgentSkills(i)).ran).toBe(true);
		}
	});

	it("names the bundled install's launcher with $HOME and a settings path verbatim", async () => {
		const bundled = input({ program: "/Users/a/.local/share/agent-sessions/bin/agent-sessions" });
		await syncAgentSkills(bundled);
		expect(vi.mocked(bundled.run).mock.calls[0][1]).toContain("$HOME/.local/share/agent-sessions/bin/agent-sessions");
		const custom = input({ program: "/opt/tools/as" });
		await syncAgentSkills(custom);
		expect(vi.mocked(custom.run).mock.calls[0][1]).toContain("/opt/tools/as");
	});

	it("passes on a failing run, and reports null for an older program without the status line", async () => {
		await expect(
			syncAgentSkills(input({ run: async () => Promise.reject(new Error("boom")) }))
		).rejects.toThrow("boom");
		const old = await syncAgentSkills(input({ run: async () => "no changes\n" }));
		expect(old).toMatchObject({ ran: true, status: null });
	});
});

describe("AGENT_SKILLS_NOTICE", () => {
	it("says something different for installed, updated, unchanged and foreign", () => {
		const keys = (["installed", "updated", "unchanged", "foreign"] as const).map((s) => AGENT_SKILLS_NOTICE[s]);
		expect(new Set(keys).size).toBe(4);
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
