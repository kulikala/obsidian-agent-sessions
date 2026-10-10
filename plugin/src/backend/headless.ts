// Runs one headless agent request (for "Organize names and categories" and token efficiency):
// `claude -p`, `codex exec` or `opencode run` (argv and output parsing in
// `sessions/organize-agent.ts`).
// The prompt goes in on stdin and stdout is read as it streams, so the dialog can show that
// text is arriving. Claude Code and Codex keep no transcript (and any `-p` / `exec` one would
// be marked a child, which the session list hides); an OpenCode `run` session is deleted
// afterwards by its exact id.

import { spawn } from "child_process";
import { mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import {
	codexMcpServers,
	headlessArgs,
	headlessEnv,
	headlessUsage,
	opencodeSessionId,
	parseAgentOutput,
	streamedChars,
	type HeadlessModel,
	type HeadlessUsage,
} from "../sessions/organize-agent";
import type { AgentId } from "../settings";
import { defaultCodexConfigPath } from "../terminal/codex-config";
import { programInvocation } from "./windows";

const TIMEOUT_MS = 180000;
const STOP_WAIT_MS = 3000;

/** What a finished run gives back: the reply, the raw stdout, and what the run cost. */
export interface HeadlessResult {
	text: string;
	stdout: string;
	usage: HeadlessUsage | null;
}

/** A failed run (error reported, bad output, non-zero exit, timeout or abort), with whatever the
 * CLI printed, so a caller can tell a usage-limit failure from others. */
export class HeadlessError extends Error {
	constructor(
		message: string,
		readonly stdout: string = "",
		readonly stderr: string = ""
	) {
		super(message);
	}
}

export interface HeadlessRun {
	agent: AgentId;
	bin: string;
	env: NodeJS.ProcessEnv;
	/** A folder with no CLAUDE.md above it, so the run doesn't pick up a project's instructions. */
	cwd: string;
	prompt: string;
	/** The Claude Code model (ignored by the other agents). */
	model?: HeadlessModel;
	/** More arguments for the CLI (Codex `-m`, OpenCode `--model`); see `headlessArgs`. */
	extraArgs?: string[];
	/** Milliseconds before the run is stopped (180,000 when left out). */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Called with the running total of answer characters received so far. */
	onProgress?: (chars: number) => void;
}

/** The text of the Codex `config.toml` the run reads (`CODEX_HOME` in its environment), or `null`. */
function readCodexConfig(env: NodeJS.ProcessEnv): string | null {
	try {
		return readFileSync(defaultCodexConfigPath(homedir(), env.CODEX_HOME), "utf8");
	} catch {
		return null;
	}
}

/** Resolves with the reply, the stdout and the usage; rejects with a `HeadlessError` on failure,
 * timeout or abort. */
export function runHeadless(run: HeadlessRun): Promise<HeadlessResult> {
	mkdirSync(run.cwd, { recursive: true });
	return new Promise((resolve, reject) => {
		if (run.signal?.aborted) {
			reject(new HeadlessError("aborted"));
			return;
		}
		// Windows: an npm-installed agent is a `.cmd` shim, which goes through cmd.exe.
		const mcp = run.agent === "codex" ? codexMcpServers(readCodexConfig(run.env)) : [];
		const call = programInvocation(run.bin, headlessArgs(run.agent, run.model, run.extraArgs, mcp));
		const child = spawn(call.file, call.args, {
			cwd: run.cwd,
			env: headlessEnv(run.agent, run.env),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: call.verbatim,
		});
		let stdout = "";
		let stderr = "";
		let pending = "";
		let chars = 0;
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timer);
			run.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		// A stopped run settles once the process has exited (at most `STOP_WAIT_MS` later), so the
		// caller's clean-up doesn't race a process still holding its working folder (Windows).
		const stop = (reason: string): void => {
			if (stopping) {
				return;
			}
			stopping = true;
			child.kill();
			const fail = (): void => finish(() => reject(new HeadlessError(reason, stdout, stderr)));
			child.once("close", fail);
			window.setTimeout(fail, STOP_WAIT_MS);
		};
		let stopping = false;
		const onAbort = (): void => stop("aborted");
		const timer = window.setTimeout(() => stop("timed out"), run.timeoutMs ?? TIMEOUT_MS);
		run.signal?.addEventListener("abort", onAbort);
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout += text;
			if (!run.onProgress) {
				return;
			}
			const lines = (pending + text).split("\n");
			pending = lines.pop() ?? "";
			const before = chars;
			for (const line of lines) {
				chars += streamedChars(run.agent, line);
			}
			if (chars !== before) {
				run.onProgress(chars);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.on("error", (err) => finish(() => reject(new HeadlessError(err.message, stdout, stderr))));
		child.on("close", (code) => {
			if (run.agent === "opencode") {
				deleteOpencodeSession(run, stdout);
			}
			if (stopping) {
				return;
			}
			finish(() => {
				try {
					const text = parseAgentOutput(run.agent, stdout);
					resolve({ text, stdout, usage: headlessUsage(run.agent, stdout) });
				} catch (err) {
					const detail = stderr.trim().split("\n").pop() || (err as Error).message;
					reject(new HeadlessError(code === 0 ? (err as Error).message : detail, stdout, stderr));
				}
			});
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(run.prompt);
	});
}

/** Best effort: removes the `run` session OpenCode just stored, by the id it printed. */
function deleteOpencodeSession(run: HeadlessRun, stdout: string): void {
	const id = opencodeSessionId(stdout);
	if (!id) {
		return;
	}
	try {
		const call = programInvocation(run.bin, ["session", "delete", id]);
		const del = spawn(call.file, call.args, {
			cwd: run.cwd,
			env: run.env,
			stdio: "ignore",
			windowsHide: true,
			windowsVerbatimArguments: call.verbatim,
		});
		del.on("error", () => undefined);
	} catch {
		// The session is hidden from the list either way.
	}
}
