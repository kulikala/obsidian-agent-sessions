// Calling `agent-sessions json …` and typing its results, plus the login shell's environment.
// Scanning and detection logic lives on the Python side — this file only calls it and receives results.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "../i18n";
import type { Detail, LiveResult, ScanResult, StatsResult, UsageResult } from "../types";

/** Thrown when a `json` subcommand fails. `message` is stderr's first line. */
export class BackendError extends Error {}

/**
 * The default login shell to fall back on when `$SHELL` isn't set. macOS uses `zsh` (its
 * default shell). Non-macOS uses `/bin/sh` rather than `bash`, since some Ubuntu/WSL2 setups
 * and minimal environments don't have bash — `sh` is POSIX (so `-l -c` still works) and present
 * on essentially every Linux system.
 */
export function defaultLoginShell(isMac: boolean): string {
	return isMac ? "/bin/zsh" : "/bin/sh";
}

/** The default when the `agentSessionsPath` setting is empty. */
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
 * Overlays `AGENT_SESSIONS_VAULT` onto `process.env`. `agent-sessions` has no default vault, so
 * every call path that invokes `json …` needs to pass this — without it, the Python side loses
 * track of the vault in any environment that has it in neither `env` nor
 * `~/.agents/sessions/vault.json`.
 */
export function envWithVault(vaultPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, AGENT_SESSIONS_VAULT: vaultPath };
}

/** Calls `agent-sessions json …` and returns stdout parsed as JSON. Throws `BackendError` on failure. */
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

/** `json usage ID [--from ISO] [--to ISO]`. `from`/`to` are ISO 8601 (UTC). */
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

/** `json stats`: usage within the 5-hour and 7-day windows. */
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
 * The login shell's environment (`PATH`, `LANG`, `HOME`, `USER`, `TMPDIR`,
 * `CLAUDE_CONFIG_DIR`). Obsidian launched from the Dock has a sparse environment, so this fills
 * out the `env` passed to the daemon's `start`. `$SHELL -l -c env` is run once and cached.
 * `isMac` (default `true`) picks the fallback shell when `$SHELL` isn't set (`defaultLoginShell`).
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

/** For use in tests: clears `loginEnv`'s cache. */
export function resetLoginEnvCache(): void {
	cachedLoginEnv = null;
}

/**
 * Resolves the `claude` executable's path. If the setting is empty, looks it up via the login
 * shell's `command -v claude`. Throws `BackendError` if it can't be found. `isMac` (default
 * `true`) picks the fallback shell when `$SHELL` isn't set.
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
