// `agent-sessions json …` の呼び出しと結果の型（§5）、ログインシェルの環境（§4.2・§7）。
// 走査・判定のロジックは Python 側にある。ここは呼び出しと結果の受け取りだけを持つ。

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n";
import type { Detail, LiveResult, ScanResult, StatsResult, UsageResult } from "./types";

/** `json` サブコマンドが失敗したときの例外。stderr の先頭行を message に持つ。 */
export class BackendError extends Error {}

/** 設定の `agentSessionsPath` が空のときの既定（§6.9）。 */
export function resolveAgentSessionsPath(configured: string): string {
	return configured || join(homedir(), "bin", "agent-sessions");
}

function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0);
	return (line ?? text).trim();
}

function execFileText(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) {
				const e = err as NodeJS.ErrnoException & { stderr?: string };
				e.stderr = stderr;
				reject(e);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

/** `agent-sessions json …` を呼び、stdout を JSON として返す。失敗は `BackendError`。 */
export async function runJson(agentSessionsPath: string, args: string[]): Promise<unknown> {
	try {
		const { stdout } = await execFileText(agentSessionsPath, ["json", ...args]);
		return JSON.parse(stdout);
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr;
		const message = stderr && stderr.trim().length > 0 ? firstLine(stderr) : (err as Error).message;
		throw new BackendError(message);
	}
}

export async function scan(agentSessionsPath: string, only?: string[]): Promise<ScanResult> {
	const args = only && only.length > 0 ? ["scan", "--only", ...only] : ["scan"];
	return runJson(agentSessionsPath, args) as Promise<ScanResult>;
}

export async function live(agentSessionsPath: string): Promise<LiveResult> {
	return runJson(agentSessionsPath, ["live"]) as Promise<LiveResult>;
}

export async function detail(agentSessionsPath: string, id: string): Promise<Detail> {
	return runJson(agentSessionsPath, ["detail", id]) as Promise<Detail>;
}

/** `json usage ID [--from ISO] [--to ISO]`（D-30）。`from`／`to` は ISO8601（UTC）。 */
export async function usage(agentSessionsPath: string, id: string, from?: string, to?: string): Promise<UsageResult> {
	const args = ["usage", id];
	if (from) {
		args.push("--from", from);
	}
	if (to) {
		args.push("--to", to);
	}
	return runJson(agentSessionsPath, args) as Promise<UsageResult>;
}

/** `json stats`（D-54・D-55）：5 時間・7 日の枠の使用状況。 */
export async function stats(agentSessionsPath: string): Promise<StatsResult> {
	return runJson(agentSessionsPath, ["stats"]) as Promise<StatsResult>;
}

const LOGIN_ENV_KEYS = ["PATH", "LANG", "HOME", "USER", "TMPDIR", "CLAUDE_CONFIG_DIR"] as const;

function parseEnvOutput(stdout: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		result[line.slice(0, idx)] = line.slice(idx + 1);
	}
	return result;
}

let cachedLoginEnv: Record<string, string> | null = null;

/**
 * ログインシェルの環境（`PATH`・`LANG`・`HOME`・`USER`・`TMPDIR`・`CLAUDE_CONFIG_DIR`）。
 * Dock から起動した Obsidian の環境は貧弱なため、デーモンの `start` に渡す `env` を
 * これで補う（§4.2）。`$SHELL -l -c env` は 1 回だけ実行してキャッシュする。
 */
export async function loginEnv(): Promise<Record<string, string>> {
	if (cachedLoginEnv) {
		return cachedLoginEnv;
	}
	const shell = process.env.SHELL || "/bin/zsh";
	const { stdout } = await execFileText(shell, ["-l", "-c", "env"]);
	const all = parseEnvOutput(stdout);
	const picked: Record<string, string> = {};
	for (const key of LOGIN_ENV_KEYS) {
		if (all[key] !== undefined) {
			picked[key] = all[key];
		}
	}
	cachedLoginEnv = picked;
	return picked;
}

/** テストで使う：`loginEnv` のキャッシュを消す。 */
export function resetLoginEnvCache(): void {
	cachedLoginEnv = null;
}

/**
 * `claude` の実行パスを決める（§6.9・§7）。設定が空ならログインシェルの
 * `command -v claude` を引く。見つからなければ `BackendError`。
 */
export async function resolveClaude(configuredPath: string): Promise<string> {
	if (configuredPath) {
		return configuredPath;
	}
	const shell = process.env.SHELL || "/bin/zsh";
	try {
		const { stdout } = await execFileText(shell, ["-l", "-c", "command -v claude"]);
		const path = stdout.trim();
		if (!path) {
			throw new BackendError(t("error.claudeMissing"));
		}
		return path;
	} catch (err) {
		if (err instanceof BackendError) {
			throw err;
		}
		throw new BackendError(t("error.claudeMissing"));
	}
}
