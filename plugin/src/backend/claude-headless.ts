// Runs one headless Claude Code request (`claude -p`) for "Organize names and categories".
// The prompt goes in on stdin and the reply comes back as the CLI's JSON output
// (`parseClaudeOutput`). The run keeps no transcript (`--no-session-persistence`), and any it
// did write would be an `sdk-cli` one, which the session list hides.

import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { claudeHeadlessArgs, parseClaudeOutput } from "../sessions/organize";

const TIMEOUT_MS = 180000;

export interface HeadlessRun {
	bin: string;
	env: NodeJS.ProcessEnv;
	/** A folder with no CLAUDE.md above it, so the run doesn't pick up a project's instructions. */
	cwd: string;
	prompt: string;
	model?: string;
	signal?: AbortSignal;
}

/** Resolves with the model's reply text; rejects on failure, timeout or abort. */
export function runClaudeHeadless(run: HeadlessRun): Promise<string> {
	mkdirSync(run.cwd, { recursive: true });
	return new Promise((resolve, reject) => {
		if (run.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const child = spawn(run.bin, claudeHeadlessArgs(run.model ?? "haiku"), {
			cwd: run.cwd,
			env: run.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
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
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code) =>
			finish(() => {
				try {
					resolve(parseClaudeOutput(stdout));
				} catch (err) {
					const detail = stderr.trim().split("\n").pop() || (err as Error).message;
					reject(new Error(code === 0 ? (err as Error).message : detail));
				}
			})
		);
		child.stdin.on("error", () => undefined);
		child.stdin.end(run.prompt);
	});
}
