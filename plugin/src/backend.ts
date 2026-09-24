// `agent-sessions json …` の呼び出しと結果の型（§5）、ログインシェルの環境（§4.2・§7）。
// 走査・判定のロジックは Python 側にある。ここは呼び出しと結果の受け取りだけを持つ。

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n";
import type { Detail, LiveResult, ScanResult, StatsResult, UsageResult } from "./types";

/** `json` サブコマンドが失敗したときの例外。stderr の先頭行を message に持つ。 */
export class BackendError extends Error {}

/**
 * `$SHELL` が無いときの既定のログインシェル（§4.2・§7 非macOS対応）。macOS は `zsh`
 * （既定シェル）、非 macOS は `bash`（大半のディストリビューションに入っている）。
 */
export function defaultLoginShell(isMac: boolean): string {
	return isMac ? "/bin/zsh" : "/bin/bash";
}

/** 設定の `agentSessionsPath` が空のときの既定（§6.9）。 */
export function resolveAgentSessionsPath(configured: string): string {
	return configured || join(homedir(), "bin", "agent-sessions");
}

function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0);
	return (line ?? text).trim();
}

function execFileText(
	cmd: string,
	args: string[],
	env?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { encoding: "utf8", env }, (err, stdout, stderr) => {
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

/**
 * `process.env` に `AGENT_SESSIONS_VAULT` を重ねる（T-80）。`agent-sessions` は既定の
 * vault を持たないので、`json …` を呼ぶすべての経路でこれを渡す必要がある——渡さないと
 * env にも `~/.agents/sessions/vault.json` にも無い環境で python 側が vault を見失う。
 */
export function envWithVault(vaultPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, AGENT_SESSIONS_VAULT: vaultPath };
}

/** `agent-sessions json …` を呼び、stdout を JSON として返す。失敗は `BackendError`。 */
export async function runJson(agentSessionsPath: string, vaultPath: string, args: string[]): Promise<unknown> {
	try {
		const { stdout } = await execFileText(agentSessionsPath, ["json", ...args], envWithVault(vaultPath));
		return JSON.parse(stdout);
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr;
		const message = stderr && stderr.trim().length > 0 ? firstLine(stderr) : (err as Error).message;
		throw new BackendError(message);
	}
}

export async function scan(agentSessionsPath: string, vaultPath: string, only?: string[]): Promise<ScanResult> {
	const args = only && only.length > 0 ? ["scan", "--only", ...only] : ["scan"];
	return runJson(agentSessionsPath, vaultPath, args) as Promise<ScanResult>;
}

export async function live(agentSessionsPath: string, vaultPath: string): Promise<LiveResult> {
	return runJson(agentSessionsPath, vaultPath, ["live"]) as Promise<LiveResult>;
}

export async function detail(agentSessionsPath: string, vaultPath: string, id: string): Promise<Detail> {
	return runJson(agentSessionsPath, vaultPath, ["detail", id]) as Promise<Detail>;
}

/** `json usage ID [--from ISO] [--to ISO]`（D-30）。`from`／`to` は ISO8601（UTC）。 */
export async function usage(
	agentSessionsPath: string,
	vaultPath: string,
	id: string,
	from?: string,
	to?: string
): Promise<UsageResult> {
	const args = ["usage", id];
	if (from) {
		args.push("--from", from);
	}
	if (to) {
		args.push("--to", to);
	}
	return runJson(agentSessionsPath, vaultPath, args) as Promise<UsageResult>;
}

/** `json stats`（D-54・D-55）：5 時間・7 日の枠の使用状況。 */
export async function stats(agentSessionsPath: string, vaultPath: string): Promise<StatsResult> {
	return runJson(agentSessionsPath, vaultPath, ["stats"]) as Promise<StatsResult>;
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
 * これで補う（§4.2）。`$SHELL -l -c env` は 1 回だけ実行してキャッシュする。`isMac`（既定
 * `true`）は `$SHELL` が無いときの既定シェルの選び方（非macOS対応。`defaultLoginShell`）。
 */
export async function loginEnv(isMac = true): Promise<Record<string, string>> {
	if (cachedLoginEnv) {
		return cachedLoginEnv;
	}
	const shell = process.env.SHELL || defaultLoginShell(isMac);
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
 * `command -v claude` を引く。見つからなければ `BackendError`。`isMac`（既定 `true`）は
 * `$SHELL` が無いときの既定シェルの選び方（非macOS対応）。
 */
export async function resolveClaude(configuredPath: string, isMac = true): Promise<string> {
	if (configuredPath) {
		return configuredPath;
	}
	const shell = process.env.SHELL || defaultLoginShell(isMac);
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
