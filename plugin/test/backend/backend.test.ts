import { afterEach, describe, expect, it } from "vitest";
import {
	agentEnvFor,
	buildAgentArgv,
	commonBinDirs,
	defaultLoginShell,
	envWithVault,
	setAgentEnv,
	sortVersionsDesc,
	withBinDirOnPath,
} from "../../src/backend/backend";
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

describe("sortVersionsDesc", () => {
	it("sorts numeric-dotted versions newest-first", () => {
		expect(sortVersionsDesc(["24.14.0", "24.18.0", "20.11.0"])).toEqual(["24.18.0", "24.14.0", "20.11.0"]);
	});

	it("compares a bare major version against a fully-qualified one component-by-component", () => {
		expect(sortVersionsDesc(["24", "24.18.0"])).toEqual(["24.18.0", "24"]);
	});

	it("strips a leading v (nvm's directory naming) before comparing", () => {
		expect(sortVersionsDesc(["v20.11.0", "v22.1.0"])).toEqual(["v22.1.0", "v20.11.0"]);
	});

	it("sorts a non-numeric label (e.g. mise's lts) after every numeric version", () => {
		expect(sortVersionsDesc(["lts", "24.18.0", "20.11.0"])).toEqual(["24.18.0", "20.11.0", "lts"]);
	});

	it("keeps ties (including two non-numeric labels) in their original order", () => {
		expect(sortVersionsDesc(["lts", "current", "24.0.0"])).toEqual(["24.0.0", "lts", "current"]);
	});

	it("doesn't mutate the input array", () => {
		const input = ["24.0.0", "20.0.0"];
		sortVersionsDesc(input);
		expect(input).toEqual(["24.0.0", "20.0.0"]);
	});
});

describe("commonBinDirs (search order: mise shims/installs, asdf, volta, nvm, then generic locations)", () => {
	const base = { home: "/Users/kaz", isMac: true, miseNodeVersions: [], nvmNodeVersions: [], npmPrefix: "" };

	it("puts mise's shims first, then its node installs newest-first, before anything else", () => {
		const dirs = commonBinDirs({ ...base, miseNodeVersions: ["24.14.0", "24.18.0", "lts"] });
		expect(dirs.slice(0, 4)).toEqual([
			"/Users/kaz/.local/share/mise/shims",
			"/Users/kaz/.local/share/mise/installs/node/24.18.0/bin",
			"/Users/kaz/.local/share/mise/installs/node/24.14.0/bin",
			"/Users/kaz/.local/share/mise/installs/node/lts/bin",
		]);
	});

	it("includes asdf's shims, volta, and nvm's installs newest-first, in that order", () => {
		const dirs = commonBinDirs({ ...base, nvmNodeVersions: ["v18.0.0", "v20.0.0"] });
		expect(dirs).toContain("/Users/kaz/.asdf/shims");
		expect(dirs).toContain("/Users/kaz/.volta/bin");
		const nvmIdx18 = dirs.indexOf("/Users/kaz/.nvm/versions/node/v18.0.0/bin");
		const nvmIdx20 = dirs.indexOf("/Users/kaz/.nvm/versions/node/v20.0.0/bin");
		expect(nvmIdx20).toBeGreaterThanOrEqual(0);
		expect(nvmIdx20).toBeLessThan(nvmIdx18);
	});

	it("includes /opt/homebrew/bin only on macOS", () => {
		expect(commonBinDirs({ ...base, isMac: true })).toContain("/opt/homebrew/bin");
		expect(commonBinDirs({ ...base, isMac: false })).not.toContain("/opt/homebrew/bin");
	});

	it("ends with ~/.local/bin, the homebrew/usr-local pair, then npm's prefix if given", () => {
		const dirs = commonBinDirs({ ...base, npmPrefix: "/opt/custom-npm" });
		expect(dirs.slice(-4)).toEqual(["/Users/kaz/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/custom-npm/bin"]);
	});

	it("omits npm's prefix dir entirely when npmPrefix is empty", () => {
		expect(commonBinDirs(base).at(-1)).toBe("/usr/local/bin");
	});
});

describe("withBinDirOnPath (a version-manager-resolved binary needs its own dir on PATH — e.g. codex.js's #!/usr/bin/env node)", () => {
	it("prepends bin's directory onto an existing PATH", () => {
		const env = withBinDirOnPath({ PATH: "/usr/bin:/bin" }, "/Users/kaz/.local/share/mise/shims/codex");
		expect(env.PATH).toBe("/Users/kaz/.local/share/mise/shims:/usr/bin:/bin");
	});

	it("sets PATH to just bin's directory when there was none", () => {
		const env = withBinDirOnPath({} as Record<string, string>, "/usr/local/bin/codex");
		expect(env.PATH).toBe("/usr/local/bin");
	});

	it("doesn't mutate the input env (returns a new object)", () => {
		const input = { PATH: "/usr/bin" };
		const result = withBinDirOnPath(input, "/opt/homebrew/bin/claude");
		expect(input).toEqual({ PATH: "/usr/bin" });
		expect(result).not.toBe(input);
	});
});
