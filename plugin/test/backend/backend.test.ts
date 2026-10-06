import { afterEach, describe, expect, it } from "vitest";
import {
	agentEnvFor,
	buildAgentArgv,
	codexNoDaemon,
	helpListsNoDaemon,
	commonBinDirs,
	parseOllamaList,
	defaultLoginShell,
	envWithVault,
	mergePath,
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
				opencode: { enabled: true, path: "", env: "" },
			},
		};
		expect(agentEnvFor(settings).AGENT_SESSIONS_AGENTS).toBe("claude,codex,opencode");
	});

	it("lists only the enabled agents", () => {
		const settings = {
			agents: {
				claude: { enabled: true, path: "", env: "" },
				codex: { enabled: false, path: "", env: "" },
				opencode: { enabled: false, path: "", env: "" },
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

	it("forwards OpenCode's XDG_DATA_HOME / XDG_CONFIG_HOME from its env setting", () => {
		const settings = {
			agents: {
				...DEFAULT_SETTINGS.agents,
				opencode: { enabled: true, path: "", env: "XDG_DATA_HOME=/d\nXDG_CONFIG_HOME=/c\nOTHER=x" },
			},
		};
		const env = agentEnvFor(settings, { XDG_DATA_HOME: "/login-d", XDG_CONFIG_HOME: "/login-c" });
		expect(env.XDG_DATA_HOME).toBe("/d");
		expect(env.XDG_CONFIG_HOME).toBe("/c");
		expect(env).not.toHaveProperty("OTHER");
	});

	it("forwards OpenCode's database choice (OPENCODE_DB, OPENCODE_DISABLE_CHANNEL_DB)", () => {
		const settings = {
			agents: {
				...DEFAULT_SETTINGS.agents,
				opencode: { enabled: true, path: "", env: "OPENCODE_DB=mine.db" },
			},
		};
		const env = agentEnvFor(settings, { OPENCODE_DISABLE_CHANNEL_DB: "1" });
		expect(env.OPENCODE_DB).toBe("mine.db");
		expect(env.OPENCODE_DISABLE_CHANNEL_DB).toBe("1");
	});

	it("falls back to the login shell's XDG variables, and forwards nothing when neither has them", () => {
		const settings = { agents: DEFAULT_SETTINGS.agents };
		expect(agentEnvFor(settings, { XDG_DATA_HOME: "/login-d", PATH: "/bin" })).toEqual({
			AGENT_SESSIONS_AGENTS: "claude",
			XDG_DATA_HOME: "/login-d",
		});
		expect(agentEnvFor(settings, {})).toEqual({ AGENT_SESSIONS_AGENTS: "claude" });
	});

	it("forwards Codex's CODEX_SQLITE_HOME with CODEX_HOME", () => {
		const settings = {
			agents: { ...DEFAULT_SETTINGS.agents, codex: { enabled: true, path: "", env: "CODEX_HOME=/p2\nCODEX_SQLITE_HOME=/db\nX=1" } },
		};
		expect(agentEnvFor(settings)).toEqual({ AGENT_SESSIONS_AGENTS: "claude,codex", CODEX_HOME: "/p2", CODEX_SQLITE_HOME: "/db" });
	});

	it("omits CODEX_HOME when codex's env setting doesn't have one", () => {
		expect(agentEnvFor({ agents: DEFAULT_SETTINGS.agents })).toEqual({ AGENT_SESSIONS_AGENTS: "claude" });
	});
});

describe("buildAgentArgv", () => {
	it("claude fresh: --session-id, the id the plugin generated", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc-123", true)).toEqual(["/bin/claude", "--session-id", "abc-123"]);
	});

	it("claude fresh with a name: --name=NAME, one argument even when the name starts with a dash", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc", true, undefined, false, "Work: Fix login")).toEqual([
			"/bin/claude",
			"--session-id",
			"abc",
			"--name=Work: Fix login",
		]);
		expect(buildAgentArgv("claude", "/bin/claude", "abc", true, undefined, false, "-x")).toEqual(["/bin/claude", "--session-id", "abc", "--name=-x"]);
	});

	it("claude resume takes no name: the transcript already holds it", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc", false, undefined, false, "N")).toEqual(["/bin/claude", "--resume", "abc"]);
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

	it("codex with --no-daemon, fresh and resumed (no shared background server); other agents ignore it", () => {
		const bin = "C:\\codex\\codex.exe";
		expect(buildAgentArgv("codex", bin, "abc-123", true, undefined, true)).toEqual([bin, "--no-daemon"]);
		expect(buildAgentArgv("codex", bin, "abc-123", false, undefined, true)).toEqual([bin, "--no-daemon", "resume", "abc-123"]);
		expect(buildAgentArgv("claude", "C:\\claude.exe", "abc", true, undefined, true)).toEqual(["C:\\claude.exe", "--session-id", "abc"]);
		expect(buildAgentArgv("opencode", "C:\\oc.exe", "ses_a", false, undefined, true)).toEqual(["C:\\oc.exe", "--session", "ses_a"]);
	});

	it("asks for --no-daemon only when --help lists it", async () => {
		expect(helpListsNoDaemon("Options:\n      --no-daemon\n          Run without the shared background server")).toBe(true);
		expect(helpListsNoDaemon("Options:\n  -m, --model <MODEL>\n      --no-alt-screen")).toBe(false);
		expect(await codexNoDaemon("/no/such/codex")).toBe(false);
	});

	it("opencode fresh: no id-related flag at all (opencode assigns its own session id)", () => {
		expect(buildAgentArgv("opencode", "/bin/opencode", "abc-123", true)).toEqual(["/bin/opencode"]);
	});

	it("opencode resume: --session <id>", () => {
		expect(buildAgentArgv("opencode", "/bin/opencode", "ses_abc", false)).toEqual(["/bin/opencode", "--session", "ses_abc"]);
	});

	it("opencode via ollama, fresh: ollama launch opencode --model M -y --", () => {
		expect(
			buildAgentArgv("opencode", "/bin/opencode", "x", true, { ollamaBin: "/bin/ollama", model: "gpt-oss:20b" })
		).toEqual(["/bin/ollama", "launch", "opencode", "--model", "gpt-oss:20b", "-y", "--"]);
	});

	it("opencode via ollama, resume: --session goes after the -- separator", () => {
		expect(
			buildAgentArgv("opencode", "/bin/opencode", "ses_abc", false, { ollamaBin: "/bin/ollama", model: "gpt-oss:20b" })
		).toEqual(["/bin/ollama", "launch", "opencode", "--model", "gpt-oss:20b", "-y", "--", "--session", "ses_abc"]);
	});

	it("ignores the ollama launch for the other agents", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc", true, { ollamaBin: "/bin/ollama", model: "m" })).toEqual([
			"/bin/claude",
			"--session-id",
			"abc",
		]);
	});
});

describe("parseOllamaList", () => {
	it("takes the first column of each row after the header", () => {
		const out = [
			"NAME                 ID              SIZE      MODIFIED",
			"gpt-oss:20b          aa11bb22cc33    13 GB     2 weeks ago",
			"gemma4:e4b-mlx-bf16  dd44ee55ff66    16 GB     3 days ago",
			"",
		].join("\n");
		expect(parseOllamaList(out)).toEqual(["gpt-oss:20b", "gemma4:e4b-mlx-bf16"]);
	});

	it("is empty for empty or header-only output", () => {
		expect(parseOllamaList("")).toEqual([]);
		expect(parseOllamaList("NAME  ID  SIZE  MODIFIED\n")).toEqual([]);
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
	const base = { home: "/Users/someone", isMac: true, miseNodeVersions: [], nvmNodeVersions: [], npmPrefix: "" };

	it("puts mise's shims first, then its node installs newest-first, before anything else", () => {
		const dirs = commonBinDirs({ ...base, miseNodeVersions: ["24.14.0", "24.18.0", "lts"] });
		expect(dirs.slice(0, 4)).toEqual([
			"/Users/someone/.local/share/mise/shims",
			"/Users/someone/.local/share/mise/installs/node/24.18.0/bin",
			"/Users/someone/.local/share/mise/installs/node/24.14.0/bin",
			"/Users/someone/.local/share/mise/installs/node/lts/bin",
		]);
	});

	it("includes asdf's shims, volta, and nvm's installs newest-first, in that order", () => {
		const dirs = commonBinDirs({ ...base, nvmNodeVersions: ["v18.0.0", "v20.0.0"] });
		expect(dirs).toContain("/Users/someone/.asdf/shims");
		expect(dirs).toContain("/Users/someone/.volta/bin");
		const nvmIdx18 = dirs.indexOf("/Users/someone/.nvm/versions/node/v18.0.0/bin");
		const nvmIdx20 = dirs.indexOf("/Users/someone/.nvm/versions/node/v20.0.0/bin");
		expect(nvmIdx20).toBeGreaterThanOrEqual(0);
		expect(nvmIdx20).toBeLessThan(nvmIdx18);
	});

	it("includes /opt/homebrew/bin only on macOS", () => {
		expect(commonBinDirs({ ...base, isMac: true })).toContain("/opt/homebrew/bin");
		expect(commonBinDirs({ ...base, isMac: false })).not.toContain("/opt/homebrew/bin");
	});

	it("ends with ~/.local/bin, ~/.opencode/bin, the homebrew/usr-local pair, then npm's prefix if given", () => {
		const dirs = commonBinDirs({ ...base, npmPrefix: "/opt/custom-npm" });
		expect(dirs.slice(-5)).toEqual(["/Users/someone/.local/bin", "/Users/someone/.opencode/bin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/custom-npm/bin"]);
	});

	it("omits npm's prefix dir entirely when npmPrefix is empty", () => {
		expect(commonBinDirs(base).at(-1)).toBe("/usr/local/bin");
	});
});

describe("withBinDirOnPath (a version-manager-resolved binary needs its own dir on PATH — e.g. codex.js's #!/usr/bin/env node)", () => {
	it("prepends bin's directory onto an existing PATH", () => {
		const env = withBinDirOnPath({ PATH: "/usr/bin:/bin" }, "/Users/someone/.local/share/mise/shims/codex");
		expect(env.PATH).toBe("/Users/someone/.local/share/mise/shims:/usr/bin:/bin");
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

describe("mergePath (T-100: the interactive shell's PATH merged onto the login shell's)", () => {
	it("keeps every login entry, in order, before any interactive-only entry", () => {
		expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin")).toBe("/usr/bin:/bin:/opt/homebrew/bin");
	});

	it("appends interactive-only entries in their own order", () => {
		expect(mergePath("/usr/bin", "/a/bin:/b/bin")).toBe("/usr/bin:/a/bin:/b/bin");
	});

	it("drops duplicates, keeping only the first (login-side) occurrence", () => {
		expect(mergePath("/usr/bin:/opt/bin", "/opt/bin:/usr/bin:/new/bin")).toBe("/usr/bin:/opt/bin:/new/bin");
	});

	it("an empty login PATH is just the interactive one", () => {
		expect(mergePath("", "/a/bin:/b/bin")).toBe("/a/bin:/b/bin");
	});

	it("an empty interactive PATH (probe failed/timed out) is just the login one, unchanged", () => {
		expect(mergePath("/usr/bin:/bin", "")).toBe("/usr/bin:/bin");
	});

	it("both empty is empty", () => {
		expect(mergePath("", "")).toBe("");
	});

	it("drops empty segments from either side (a stray leading/trailing/doubled delimiter)", () => {
		expect(mergePath("/usr/bin::/bin", ":/a/bin:")).toBe("/usr/bin:/bin:/a/bin");
	});
});
