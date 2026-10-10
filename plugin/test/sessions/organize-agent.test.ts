import { describe, expect, it } from "vitest";
import {
	agentLabel,
	codexMcpServers,
	headlessArgs,
	headlessEnv,
	OPENCODE_HEADLESS_AGENT,
	opencodeSessionId,
	parseAgentOutput,
	pickOrganizeAgent,
	streamedChars,
} from "../../src/sessions/organize-agent";

const on = (claude: boolean, codex: boolean, opencode: boolean) => ({
	claude: { enabled: claude },
	codex: { enabled: codex },
	opencode: { enabled: opencode },
});

describe("pickOrganizeAgent", () => {
	it("prefers Claude Code, then Codex, then OpenCode", () => {
		expect(pickOrganizeAgent(on(true, true, true))).toBe("claude");
		expect(pickOrganizeAgent(on(false, true, true))).toBe("codex");
		expect(pickOrganizeAgent(on(false, false, true))).toBe("opencode");
	});

	it("is null when no agent is enabled", () => {
		expect(pickOrganizeAgent(on(false, false, false))).toBeNull();
	});
});

describe("agentLabel", () => {
	it("names the model only where one is asked for", () => {
		expect(agentLabel("claude")).toBe("Claude Code (sonnet)");
		expect(agentLabel("claude", "haiku")).toBe("Claude Code (haiku)");
		expect(agentLabel("codex")).toBe("Codex");
		expect(agentLabel("opencode")).toBe("OpenCode");
	});
});

describe("headlessArgs", () => {
	it("runs Claude Code in print mode with no tools, MCP, hooks, skills or transcript", () => {
		const args = headlessArgs("claude");
		expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
		expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
		expect(headlessArgs("claude", "haiku")[headlessArgs("claude", "haiku").indexOf("--model") + 1]).toBe("haiku");
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
		expect(args).toContain("--verbose");
		expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true });
	});

	it("runs Codex exec read-only, outside a repository, without a rollout file, prompt on stdin", () => {
		const args = headlessArgs("codex");
		expect(args[0]).toBe("exec");
		expect(args).toEqual(expect.arrayContaining(["--skip-git-repo-check", "--ephemeral", "--json"]));
		expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
		expect(args[args.length - 1]).toBe("-");
	});

	it("turns off Codex's shell and every other tool, web search and each MCP server named", () => {
		const args = headlessArgs("codex", "sonnet", ["-m", "x"], ["docs", "db"]);
		const overrides = args.filter((_a, i) => args[i - 1] === "-c");
		expect(overrides).toEqual(expect.arrayContaining(["features.shell_tool=false", "features.unified_exec=false", "features.apps=false", "features.multi_agent=false", 'web_search="disabled"', "mcp_servers.docs.enabled=false", "mcp_servers.db.enabled=false"]));
		expect(args.slice(-3)).toEqual(["-m", "x", "-"]);
	});

	it("runs OpenCode run as the agent without tools, with JSON events and no external plugins", () => {
		expect(headlessArgs("opencode")).toEqual(["run", "--pure", "--agent", OPENCODE_HEADLESS_AGENT, "--format", "json"]);
	});
});

describe("codexMcpServers", () => {
	it("lists the servers a config.toml declares, once each", () => {
		const toml = '[mcp_servers.docs]\ncommand = "x"\n[mcp_servers.docs.env]\nA = "1"\n[ mcp_servers."db-1" ]\n# [mcp_servers.off]\n[mcp_servers."a.b"]\n[profiles.x]\n';
		expect(codexMcpServers(toml)).toEqual(["docs", "db-1"]);
		expect(codexMcpServers(null)).toEqual([]);
	});
});

interface OpencodeConfig {
	provider?: unknown;
	agent: Record<string, { permission: Record<string, string> }>;
}

describe("headlessEnv", () => {
	it("defines the OpenCode agent with every permission denied", () => {
		const env = headlessEnv("opencode", { PATH: "/bin" });
		expect(env.PATH).toBe("/bin");
		const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "") as OpencodeConfig;
		expect(config.agent[OPENCODE_HEADLESS_AGENT].permission).toEqual({ "*": "deny", external_directory: "deny" });
	});

	it("keeps a config the user passes the same way, and replaces their agent of that name", () => {
		const user = JSON.stringify({ provider: { p: {} }, agent: { mine: {}, [OPENCODE_HEADLESS_AGENT]: { permission: { "*": "allow" } } } });
		const config = JSON.parse(headlessEnv("opencode", { OPENCODE_CONFIG_CONTENT: user }).OPENCODE_CONFIG_CONTENT ?? "") as OpencodeConfig;
		expect(config.provider).toEqual({ p: {} });
		expect(Object.keys(config.agent)).toEqual(["mine", OPENCODE_HEADLESS_AGENT]);
		expect(config.agent[OPENCODE_HEADLESS_AGENT].permission["*"]).toBe("deny");
		expect(headlessEnv("opencode", { OPENCODE_CONFIG_CONTENT: "{ not json" }).OPENCODE_CONFIG_CONTENT).toContain('"*":"deny"');
	});

	it("leaves the other agents' environment as it is", () => {
		const env = { PATH: "/bin" };
		expect(headlessEnv("claude", env)).toBe(env);
		expect(headlessEnv("codex", env)).toBe(env);
	});
});

describe("parseAgentOutput", () => {
	it("reads Claude Code's result event from JSON lines, a single object or an array", () => {
		const lines = ['{"type":"system"}', '{"type":"result","is_error":false,"result":"hi"}'].join("\n");
		expect(parseAgentOutput("claude", lines)).toBe("hi");
		expect(parseAgentOutput("claude", '{"type":"result","result":"one"}')).toBe("one");
		expect(parseAgentOutput("claude", JSON.stringify([{ type: "system" }, { type: "result", result: "[]" }]))).toBe("[]");
	});

	it("throws Claude Code's message on an error result, and on unusable output", () => {
		expect(() => parseAgentOutput("claude", '{"type":"result","is_error":true,"result":"Not logged in"}')).toThrow("Not logged in");
		expect(() => parseAgentOutput("claude", "not json")).toThrow();
	});

	it("takes the last agent_message of Codex exec --json", () => {
		const out = [
			'{"type":"thread.started","thread_id":"t"}',
			'{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"hmm"}}',
			'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"[1]"}}',
			'{"type":"turn.completed"}',
		].join("\n");
		expect(parseAgentOutput("codex", out)).toBe("[1]");
	});

	it("throws Codex's failure message", () => {
		const out = '{"type":"error","message":"auth required"}\n{"type":"turn.failed","error":{"message":"auth required"}}';
		expect(() => parseAgentOutput("codex", out)).toThrow("auth required");
		expect(() => parseAgentOutput("codex", "")).toThrow();
	});

	it("joins the text parts of OpenCode run --format json", () => {
		const out = [
			'{"type":"step_start","sessionID":"ses_a1"}',
			'{"type":"text","sessionID":"ses_a1","part":{"type":"text","text":"[{\\"id\\""}}',
			'{"type":"text","sessionID":"ses_a1","part":{"type":"text","text":": \\"x\\"}]"}}',
			'{"type":"step_finish","sessionID":"ses_a1"}',
		].join("\n");
		expect(parseAgentOutput("opencode", out)).toBe('[{"id": "x"}]');
	});

	it("throws OpenCode's error event message", () => {
		const out = '{"type":"error","error":{"name":"UnknownError","data":{"message":"model not found"}}}';
		expect(() => parseAgentOutput("opencode", out)).toThrow("model not found");
	});
});

describe("streamedChars", () => {
	it("counts Claude Code text deltas only", () => {
		const delta = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"abc"}}}';
		const thinking = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"zz"}}}';
		expect(streamedChars("claude", delta)).toBe(3);
		expect(streamedChars("claude", thinking)).toBe(0);
		expect(streamedChars("claude", "garbage")).toBe(0);
	});

	it("counts Codex messages and OpenCode text parts", () => {
		expect(streamedChars("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}')).toBe(5);
		expect(streamedChars("opencode", '{"type":"text","part":{"text":"hey"}}')).toBe(3);
		expect(streamedChars("opencode", '{"type":"step_start"}')).toBe(0);
	});
});

describe("opencodeSessionId", () => {
	it("finds the session id of a run and ignores anything unsafe", () => {
		expect(opencodeSessionId('{"type":"step_start","sessionID":"ses_f00e8a559ffenjZ"}')).toBe("ses_f00e8a559ffenjZ");
		expect(opencodeSessionId('{"sessionID":"../x"}')).toBeNull();
		expect(opencodeSessionId("")).toBeNull();
	});
});
