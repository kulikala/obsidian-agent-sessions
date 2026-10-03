// Runs one headless agent request for "Organize names and categories": `claude -p`,
// `codex exec` or `opencode run` (argv and output parsing in `sessions/organize-agent.ts`).
// The prompt goes in on stdin and stdout is read as it streams, so the dialog can show that
// text is arriving. Claude Code and Codex keep no transcript (and any `-p` / `exec` one would
// be marked a child, which the session list hides); an OpenCode `run` session is deleted
// afterwards by its exact id.

import { spawn } from "child_process";
import { mkdirSync } from "fs";
import {
	headlessArgs,
	opencodeSessionId,
	parseAgentOutput,
	streamedChars,
} from "../sessions/organize-agent";
import type { AgentId } from "../settings";

const TIMEOUT_MS = 180000;

export interface HeadlessRun {
	agent: AgentId;
	bin: string;
	env: NodeJS.ProcessEnv;
	/** A folder with no CLAUDE.md above it, so the run doesn't pick up a project's instructions. */
	cwd: string;
	prompt: string;
	signal?: AbortSignal;
	/** Called with the running total of answer characters received so far. */
	onProgress?: (chars: number) => void;
}

/** Resolves with the model's reply text; rejects on failure, timeout or abort. */
export function runHeadless(run: HeadlessRun): Promise<string> {
	mkdirSync(run.cwd, { recursive: true });
	return new Promise((resolve, reject) => {
		if (run.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const child = spawn(run.bin, headlessArgs(run.agent), {
			cwd: run.cwd,
			env: run.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
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
			clearTimeout(timer);
			run.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = (): void => {
			child.kill();
			finish(() => reject(new Error("aborted")));
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(() => reject(new Error("timed out")));
		}, TIMEOUT_MS);
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
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code) => {
			if (run.agent === "opencode") {
				deleteOpencodeSession(run, stdout);
			}
			finish(() => {
				try {
					resolve(parseAgentOutput(run.agent, stdout));
				} catch (err) {
					const detail = stderr.trim().split("\n").pop() || (err as Error).message;
					reject(new Error(code === 0 ? (err as Error).message : detail));
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
		const del = spawn(run.bin, ["session", "delete", id], {
			cwd: run.cwd,
			env: run.env,
			stdio: "ignore",
			windowsHide: true,
		});
		del.on("error", () => undefined);
	} catch {
		// The session is hidden from the list either way.
	}
}
