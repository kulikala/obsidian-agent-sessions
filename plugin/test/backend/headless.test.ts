import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackendError, buildAgentArgv, runJson } from "../../src/backend/backend";
import { HeadlessError, runHeadless } from "../../src/backend/headless";
import { inRunFolder, RunFolderBusyError } from "../../src/backend/run-folder";
import { addUsage, headlessArgs, headlessUsage, usedTools } from "../../src/sessions/organize-agent";
import { launchStart, opencodeReady, rememberAgent, typesFirstMessage } from "../../src/sessions/new-session";

const CLAUDE_RESULT = readFileSync(join(__dirname, "../fixtures/headless/claude-result.jsonl"), "utf8");
const IS_WINDOWS = process.platform === "win32";

describe("headlessUsage", () => {
	it("Claude Code: the result event's usage (cache included) and total_cost_usd", () => {
		expect(headlessUsage("claude", CLAUDE_RESULT)).toEqual({ input: 12 + 3000 + 500, output: 800, usd: 0.0421 });
	});

	it("Codex: turn.completed usage, no dollars", () => {
		const out = [
			{ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } },
			{ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		expect(headlessUsage("codex", out)).toEqual({ input: 105, output: 21, usd: null });
	});

	it("OpenCode: step_finish tokens and cost", () => {
		const out = JSON.stringify({
			type: "step_finish",
			part: { tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 7, write: 3 } }, cost: 0.5 },
		});
		expect(headlessUsage("opencode", out)).toEqual({ input: 20, output: 6, usd: 0.5 });
	});

	it("is null when the output carries none", () => {
		expect(headlessUsage("claude", '{"type":"result","result":"x"}')).toBeNull();
		expect(headlessUsage("codex", "")).toBeNull();
	});

	it("adds a retry's usage", () => {
		expect(addUsage({ input: 1, output: 2, usd: null }, { input: 3, output: 4, usd: 0.1 })).toEqual({
			input: 4,
			output: 6,
			usd: 0.1,
		});
		expect(addUsage(null, null)).toBeNull();
	});
});

describe("usedTools", () => {
	it("Codex command, file and MCP items, OpenCode tool_use events; replies alone are not tools", () => {
		const codex = (type: string) => JSON.stringify({ type: "item.completed", item: { type, text: "x" } });
		expect(usedTools("codex", codex("command_execution"))).toBe(true);
		expect(usedTools("codex", codex("file_change"))).toBe(true);
		expect(usedTools("codex", [codex("reasoning"), codex("agent_message")].join("\n"))).toBe(false);
		expect(usedTools("opencode", JSON.stringify({ type: "tool_use", part: { tool: "read" } }))).toBe(true);
		expect(usedTools("opencode", JSON.stringify({ type: "text", part: { text: "{}" } }))).toBe(false);
		expect(usedTools("claude", CLAUDE_RESULT)).toBe(false);
	});
});

describe("headlessArgs model and extra arguments", () => {
	it("names opus for Claude Code and appends extra arguments", () => {
		const args = headlessArgs("claude", "opus", ["--x"]);
		expect(args.slice(0, 3)).toEqual(["-p", "--model", "opus"]);
		expect(args[args.length - 1]).toBe("--x");
	});

	it("puts Codex's model before the stdin marker, OpenCode's at the end", () => {
		const codex = headlessArgs("codex", "sonnet", ["-m", "gpt-5.6-terra"]);
		expect(codex.slice(-3)).toEqual(["-m", "gpt-5.6-terra", "-"]);
		expect(headlessArgs("opencode", "sonnet", ["--model", "ollama/qwen"]).slice(-2)).toEqual(["--model", "ollama/qwen"]);
	});
});

describe("buildAgentArgv with a first message (same order as launch.py's build_argv)", () => {
	it("Claude Code: --permission-mode before --, the prompt after it", () => {
		expect(
			buildAgentArgv("claude", "/bin/claude", "abc", true, undefined, false, "Token efficiency: X", {
				prompt: "Fix it",
				permissionMode: "plan",
			})
		).toEqual(["/bin/claude", "--session-id", "abc", "--name=Token efficiency: X", "--permission-mode", "plan", "--", "Fix it"]);
	});

	it("Codex: -- then the prompt; OpenCode: --prompt", () => {
		expect(buildAgentArgv("codex", "/bin/codex", "abc", true, undefined, false, undefined, { prompt: "-p looks like a flag" })).toEqual([
			"/bin/codex",
			"--",
			"-p looks like a flag",
		]);
		expect(buildAgentArgv("opencode", "/bin/oc", "abc", true, undefined, false, undefined, { prompt: "go" })).toEqual([
			"/bin/oc",
			"--prompt",
			"go",
		]);
		expect(
			buildAgentArgv("opencode", "/bin/oc", "abc", true, { ollamaBin: "/bin/ollama", model: "m" }, false, undefined, { prompt: "go" })
		).toEqual(["/bin/ollama", "launch", "opencode", "--model", "m", "-y", "--", "--prompt", "go"]);
	});

	it("plan mode: Codex a read-only sandbox that asks first, OpenCode its plan agent", () => {
		const start = { prompt: "Fix it", permissionMode: "plan" as const };
		expect(buildAgentArgv("codex", "/bin/codex", "abc", true, undefined, true, undefined, start)).toEqual([
			"/bin/codex",
			"--no-daemon",
			"--sandbox",
			"read-only",
			"--ask-for-approval",
			"on-request",
			"--",
			"Fix it",
		]);
		expect(buildAgentArgv("opencode", "/bin/oc", "abc", true, undefined, false, undefined, start)).toEqual([
			"/bin/oc",
			"--agent",
			"plan",
			"--prompt",
			"Fix it",
		]);
		expect(buildAgentArgv("opencode", "/bin/oc", "abc", true, { ollamaBin: "/bin/ollama", model: "m" }, false, undefined, start)).toEqual([
			"/bin/ollama",
			"launch",
			"opencode",
			"--model",
			"m",
			"-y",
			"--",
			"--agent",
			"plan",
			"--prompt",
			"Fix it",
		]);
		expect(buildAgentArgv("codex", "/bin/codex", "abc", false, undefined, false, undefined, start)).toEqual(["/bin/codex", "resume", "abc"]);
	});

	it("a resumed session takes neither", () => {
		expect(buildAgentArgv("claude", "/bin/claude", "abc", false, undefined, false, undefined, { prompt: "x", permissionMode: "plan" })).toEqual([
			"/bin/claude",
			"--resume",
			"abc",
		]);
	});
});

describe("a first message typed in after start", () => {
	it("only OpenCode on Windows, only past the length its command line takes", () => {
		const long = "x".repeat(201);
		expect(typesFirstMessage("opencode", long, "win32")).toBe(true);
		expect(typesFirstMessage("opencode", "x".repeat(200), "win32")).toBe(false);
		expect(typesFirstMessage("opencode", long, "darwin")).toBe(false);
		expect(typesFirstMessage("codex", long, "win32")).toBe(false);
		expect(typesFirstMessage("opencode", undefined, "win32")).toBe(false);
	});

	it("waits for OpenCode's footer", () => {
		expect(opencodeReady("┃  Plan · gpt-oss:20b\n~/vault    12.1K  ctrl+p commands")).toBe(true);
		expect(opencodeReady("~\\Documents\\TestVault   ⠙ Loading plugins…")).toBe(false);
	});
});

describe("newSession options", () => {
	it("remember: false leaves lastNewSessionAgent alone", () => {
		const settings = { lastNewSessionAgent: "codex" as const } as { lastNewSessionAgent: "claude" | "codex" | "opencode" };
		expect(rememberAgent(settings, "claude", { remember: false, prompt: "x" })).toBe(false);
		expect(settings.lastNewSessionAgent).toBe("codex");
		expect(rememberAgent(settings, "claude")).toBe(true);
		expect(settings.lastNewSessionAgent).toBe("claude");
	});

	it("passes only what the launch needs", () => {
		expect(launchStart({ remember: false })).toBeUndefined();
		expect(launchStart({ prompt: "p", permissionMode: "plan", remember: false })).toEqual({ prompt: "p", permissionMode: "plan" });
	});
});

// Each test starts real node processes (the stand-in agents); on a loaded machine that start alone
// can take seconds, which says nothing about the code under test.
describe.skipIf(IS_WINDOWS)("runHeadless and the run folder", { timeout: 30_000 }, () => {
	let tmp: string;
	let base: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "headless-test-"));
		base = join(tmp, "efficiency-run");
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	/** A stand-in `claude`: drains stdin, then prints `output` (or waits for ever). */
	function fakeAgent(output: string | null): string {
		const bin = join(tmp, "fake-claude");
		const body = output === null ? "setInterval(() => {}, 1000);" : `process.stdout.write(${JSON.stringify(output)});`;
		writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => { ${body} });\n`);
		chmodSync(bin, 0o755);
		return bin;
	}

	it("returns the text, the stdout and the usage; the folder is gone afterwards", async () => {
		const bin = fakeAgent(CLAUDE_RESULT);
		const result = await inRunFolder(base, (cwd) => {
			expect(readdirSync(cwd)).toEqual([]);
			return runHeadless({ agent: "claude", bin, env: process.env, cwd, prompt: "data" });
		});
		expect(result.text).toBe('{"findings":[],"dismissed":[]}');
		expect(result.stdout).toBe(CLAUDE_RESULT);
		expect(result.usage).toEqual({ input: 3512, output: 800, usd: 0.0421 });
		expect(readdirSync(base)).toEqual([]);
	});

	it("a failed run rejects with its stdout, and the folder is gone", async () => {
		const failed = JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit" }) + "\n";
		const bin = fakeAgent(failed);
		const err = await inRunFolder(base, (cwd) => runHeadless({ agent: "claude", bin, env: process.env, cwd, prompt: "x" })).catch(
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(HeadlessError);
		expect((err as HeadlessError).stdout).toBe(failed);
		expect(readdirSync(base)).toEqual([]);
	});

	it("times out, and a cancel stops the run; neither leaves the folder", async () => {
		const bin = fakeAgent(null);
		const timedOut = await inRunFolder(base, (cwd) =>
			runHeadless({ agent: "claude", bin, env: process.env, cwd, prompt: "x", timeoutMs: 300 })
		).catch((e: Error) => e.message);
		expect(timedOut).toBe("timed out");
		const controller = new AbortController();
		const pending = inRunFolder(base, (cwd) =>
			runHeadless({ agent: "claude", bin, env: process.env, cwd, prompt: "x", signal: controller.signal })
		).catch((e: Error) => e.message);
		setTimeout(() => controller.abort(), 100);
		expect(await pending).toBe("aborted");
		expect(readdirSync(base)).toEqual([]);
		expect(existsSync(base)).toBe(true);
	});

	it("the run folder has a fixed name, starts empty, refuses a second run and clears a leftover", async () => {
		mkdirSync(join(base, "current"), { recursive: true });
		writeFileSync(join(base, "current", "leftover.txt"), "x");
		let release: () => void = () => undefined;
		const first = inRunFolder(base, (cwd) => {
			expect(cwd).toBe(join(base, "current"));
			expect(readdirSync(cwd)).toEqual([]);
			return new Promise<void>((done) => (release = done));
		});
		await expect(inRunFolder(base, async () => undefined)).rejects.toBeInstanceOf(RunFolderBusyError);
		expect(existsSync(join(base, "current"))).toBe(true);
		release();
		await first;
		expect(readdirSync(base)).toEqual([]);
		await inRunFolder(base, async (cwd) => expect(cwd).toBe(join(base, "current")));
		expect(readdirSync(base)).toEqual([]);
	});

	it("runJson takes a larger buffer for big outputs", async () => {
		const bin = join(tmp, "fake-agent-sessions");
		writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ big: "x".repeat(2 * 1024 * 1024) }));\n`);
		chmodSync(bin, 0o755);
		await expect(runJson(bin, tmp, ["efficiency"])).rejects.toBeInstanceOf(BackendError);
		const out = (await runJson(bin, tmp, ["efficiency"], { timeoutMs: 20000, maxBuffer: 16 * 1024 * 1024 })) as { big: string };
		expect(out.big.length).toBe(2 * 1024 * 1024);
	});
});
