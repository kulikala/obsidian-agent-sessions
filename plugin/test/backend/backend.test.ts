import { afterEach, describe, expect, it } from "vitest";
import { agentEnvFor, buildAgentArgv, defaultLoginShell, envWithVault, setAgentEnv } from "../../src/backend/backend";
import { DEFAULT_SETTINGS } from "../../src/settings";

describe("envWithVault (ensures every code path that calls json… gets AGENT_SESSIONS_VAULT)", () => {
	it("overlays AGENT_SESSIONS_VAULT onto the base env", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "old" };
		const result = envWithVault("/tmp/vault", base);
		expect(result).toEqual({ PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "/tmp/vault" });
	});

	it("just adds the key when the base env doesn't have it", () => {
		const result = envWithVault("/tmp/vault", { PATH: "/usr/bin" });
		expect(result).toEqual({ PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "/tmp/vault" });
	});

	it("does not mutate the base env (returns a new object)", () => {
		const base = { PATH: "/usr/bin" };
		const result = envWithVault("/tmp/vault", base);
		expect(base).toEqual({ PATH: "/usr/bin" });
		expect(result).not.toBe(base);
	});
});

describe("setAgentEnv / envWithVault (the extra env setAgentEnv sets is overlaid too)", () => {
	afterEach(() => setAgentEnv({}));

	it("overlays whatever setAgentEnv was last called with", () => {
		setAgentEnv({ AGENT_SESSIONS_AGENTS: "claude,codex", CODEX_HOME: "/x/.codex" });
		const result = envWithVault("/tmp/vault", { PATH: "/usr/bin" });
		expect(result).toEqual({
			PATH: "/usr/bin",
			AGENT_SESSIONS_AGENTS: "claude,codex",
			CODEX_HOME: "/x/.codex",
			AGENT_SESSIONS_VAULT: "/tmp/vault",
		});
	});

	it("AGENT_SESSIONS_VAULT always wins over an extra var of the same name", () => {
		setAgentEnv({ AGENT_SESSIONS_VAULT: "should-not-win" });
		expect(envWithVault("/tmp/vault", {}).AGENT_SESSIONS_VAULT).toBe("/tmp/vault");
	});
});

describe("agentEnvFor", () => {
	it("lists every enabled agent, comma-separated", () => {
		const settings = {
			agents: {
				claude: { enabled: true, path: "", env: "" },
				codex: { enabled: true, path: "", env: "" },
			},
		};
		expect(agentEnvFor(settings).AGENT_SESSIONS_AGENTS).toBe("claude,codex");
	});

	it("lists only the enabled agents", () => {
		const settings = {
			agents: {
				claude: { enabled: true, path: "", env: "" },
				codex: { enabled: false, path: "", env: "" },
			},
		};
		expect(agentEnvFor(settings).AGENT_SESSIONS_AGENTS).toBe("claude");
	});

	it("includes CODEX_HOME when codex's env setting has one", () => {
		const settings = {
			agents: {
				...DEFAULT_SETTINGS.agents,
				codex: { enabled: true, path: "", env: "CODEX_HOME=/custom/.codex\nOTHER=ignored" },
			},
		};
		expect(agentEnvFor(settings)).toEqual({ AGENT_SESSIONS_AGENTS: "claude,codex", CODEX_HOME: "/custom/.codex" });
	});

	it("omits CODEX_HOME when codex's env setting doesn't have one", () => {
		expect(agentEnvFor({ agents: DEFAULT_SETTINGS.agents })).toEqual({ AGENT_SESSIONS_AGENTS: "claude" });
	});
});

describe("buildAgentArgv", () => {
	it("claude fresh: --session-id, the id the plugin generated", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc-123", true)).toEqual(["/bin/claude", "--session-id", "abc-123"]);
	});

	it("claude resume: --resume", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc-123", false)).toEqual(["/bin/claude", "--resume", "abc-123"]);
	});

	it("codex fresh: no id-related flag at all (codex assigns its own new thread id)", () => {
		expect(buildAgentArgv("codex", "/bin/codex", "abc-123", true)).toEqual(["/bin/codex"]);
	});

	it("codex resume: the resume subcommand, plain (not a flag)", () => {
		expect(buildAgentArgv("codex", "/bin/codex", "abc-123", false)).toEqual(["/bin/codex", "resume", "abc-123"]);
	});
});

describe("defaultLoginShell (non-macOS fallback when $SHELL is unset)", () => {
	it("is zsh on macOS", () => {
		expect(defaultLoginShell(true)).toBe("/bin/zsh");
	});

	it("is sh on non-macOS (some minimal environments lack bash)", () => {
		expect(defaultLoginShell(false)).toBe("/bin/sh");
	});
});
