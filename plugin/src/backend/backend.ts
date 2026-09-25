// Calling `agent-sessions json …` and typing its results, plus the login shell's environment.
// Scanning and detection logic lives on the Python side — this file only calls it and receives results.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { t } from "../i18n";
import { AGENT_IDS, parseEnvLines, type AgentId, type AgentSettings } from "../settings";
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
	env?: NodeJS.ProcessEnv,
	timeoutMs?: number
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { encoding: "utf8", env, timeout: timeoutMs }, (err, stdout, stderr) => {
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

let extraJsonEnv: Record<string, string> = {};

/**
 * Sets the extra env vars overlaid onto every `json …` call from here on: `AGENT_SESSIONS_AGENTS`
 * (comma-separated enabled agent ids — see `agentEnvFor`) and, if the user configured one,
 * Codex's `CODEX_HOME`. Called once from `main.ts`'s `onload` and again whenever the agent
 * settings change. Module-level state read implicitly by `envWithVault`, the same pattern
 * `i18n.ts`'s `setLang`/`t()` uses — simpler than threading a parameter through every
 * `scan`/`live`/`detail`/`usage`/`stats` call site for something that only changes when the user
 * edits Settings.
 */
export function setAgentEnv(vars: Record<string, string>): void {
	extraJsonEnv = vars;
}

/** The env `setAgentEnv` expects, computed from the current agent settings: `AGENT_SESSIONS_AGENTS`
 * (every enabled agent, comma-separated) plus Codex's `CODEX_HOME` if its "environment
 * variables" setting has one (Python reads `CODEX_HOME` straight from its own env on every
 * call — see `agentsessions/agents/codex/rollout.py`'s `codex_home()`). Pure — no I/O. */
export function agentEnvFor(settings: { agents: Record<AgentId, AgentSettings> }): Record<string, string> {
	const enabled = AGENT_IDS.filter((id) => settings.agents[id].enabled);
	const vars: Record<string, string> = { AGENT_SESSIONS_AGENTS: enabled.join(",") };
	const codexHome = parseEnvLines(settings.agents.codex.env).CODEX_HOME;
	if (codexHome) {
		vars.CODEX_HOME = codexHome;
	}
	return vars;
}

/**
 * Overlays `AGENT_SESSIONS_VAULT` (and `setAgentEnv`'s extra vars) onto `process.env`.
 * `agent-sessions` has no default vault, so every call path that invokes `json …` needs to pass
 * this — without it, the Python side loses track of the vault in any environment that has it in
 * neither `env` nor `~/.agents/sessions/vault.json`.
 */
export function envWithVault(vaultPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, ...extraJsonEnv, AGENT_SESSIONS_VAULT: vaultPath };
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

export interface ResolveResult {
	thread: string | null;
	transcript: string | null;
}

/**
 * `json resolve <agent> --pid PID --since EPOCH --cwd CWD`: for an agent with no flag letting
 * the caller assign a new session's own id (Codex — see `buildAgentArgv`), the real id it ended
 * up with, once its transcript exists. `{thread: null, transcript: null}` — not an error — until
 * then (the caller is expected to retry) or for any agent that doesn't need this at all (every
 * agent but Codex). `pid` is the daemon-tracked session's own pid (`DaemonSession.pid`, from
 * `client.list()`); `since` is when that session was started (epoch seconds).
 */
export async function resolve(
	agentSessionsPath: string,
	vaultPath: string,
	agent: AgentId,
	pid: number,
	since: number,
	cwd: string
): Promise<ResolveResult> {
	return runJson(agentSessionsPath, vaultPath, [
		"resolve",
		agent,
		"--pid",
		String(pid),
		"--since",
		String(since),
		"--cwd",
		cwd,
	]) as Promise<ResolveResult>;
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

/** Each agent's executable basename — `command -v <name>`, and the last path segment checked
 * against in `commonBinDirs`' common install locations. */
export const AGENT_BIN_NAME: Record<AgentId, string> = { claude: "claude", codex: "codex" };

/** How long the interactive-shell probe (`execInteractive`) is allowed to run before being killed
 * — guards against a hung/blocking rc file. */
const INTERACTIVE_PROBE_TIMEOUT_MS = 3000;

/**
 * Runs `probe` (a shell command, e.g. `command -v codex`) inside an *interactive* shell
 * (`$SHELL -i -c`, as opposed to `loginEnv`'s `-l -c`) — a tool installed by a version manager
 * (mise, etc.) whose shell integration is wired into `.zshrc`/`.bashrc` rather than a profile file
 * only shows up on `PATH` there; a login-but-non-interactive invocation never sources it. An
 * interactive shell can print prompts, banners, or other rc-file noise to stdout ahead of the
 * probe's own output, so `probe` is wrapped between two unique markers and only the text between
 * them is trusted. `null` on any failure — non-zero exit, timeout, or the markers not found.
 */
async function execInteractive(shell: string, probe: string, timeoutMs = INTERACTIVE_PROBE_TIMEOUT_MS): Promise<string | null> {
	const begin = `__agent_sessions_begin_${Date.now()}__`;
	const end = `__agent_sessions_end_${Date.now()}__`;
	const wrapped = `printf '%s\\n' '${begin}'; ${probe}; printf '%s\\n' '${end}'`;
	try {
		const { stdout } = await execFileText(shell, ["-i", "-c", wrapped], undefined, timeoutMs);
		const startIdx = stdout.indexOf(begin);
		const endIdx = stdout.indexOf(end);
		if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
			return null;
		}
		return stdout.slice(startIdx + begin.length, endIdx).trim() || null;
	} catch {
		return null;
	}
}

/** Plain-data input to `commonBinDirs`, gathered by `gatherCommonBinDirsInput` (filesystem/shell
 * I/O) so the directory-list logic itself stays pure and unit-testable. */
export interface CommonBinDirsInput {
	home: string;
	isMac: boolean;
	/** Directory names under `~/.local/share/mise/installs/node/` (e.g. "24", "24.14.0", "lts"), unsorted. */
	miseNodeVersions: string[];
	/** Directory names under `~/.nvm/versions/node/` (e.g. "v20.11.0"), unsorted. */
	nvmNodeVersions: string[];
	/** `npm config get prefix`'s output, trimmed, or empty if npm isn't available. */
	npmPrefix: string;
}

/**
 * Sorts version-like directory names newest-first: a numeric-dotted version (optionally prefixed
 * with "v") compares component-by-component, descending; a non-numeric label (e.g. "lts") sorts
 * after every numeric version. Ties (including two non-numeric labels) keep their original order.
 * Pure.
 */
export function sortVersionsDesc(versions: string[]): string[] {
	const parse = (v: string): number[] | null => {
		const stripped = v.startsWith("v") ? v.slice(1) : v;
		if (!/^\d+(\.\d+)*$/.test(stripped)) {
			return null;
		}
		return stripped.split(".").map(Number);
	};
	return versions
		.map((v, i) => ({ v, i, parts: parse(v) }))
		.sort((a, b) => {
			if (a.parts && b.parts) {
				const len = Math.max(a.parts.length, b.parts.length);
				for (let k = 0; k < len; k++) {
					const diff = (b.parts[k] ?? 0) - (a.parts[k] ?? 0);
					if (diff !== 0) {
						return diff;
					}
				}
				return a.i - b.i;
			}
			if (a.parts && !b.parts) {
				return -1;
			}
			if (!a.parts && b.parts) {
				return 1;
			}
			return a.i - b.i;
		})
		.map((x) => x.v);
}

/**
 * Common install locations checked when neither shell probe finds a binary — mise's shims
 * (self-resolving; mise looks up the right version internally, so this needs no other help), its
 * per-version node installs newest-first (a node-managed tool like Codex's `codex.js` lives under
 * `installs/node/<version>/bin/`), asdf's shims, volta, nvm's per-version installs newest-first,
 * `~/.local/bin`, `/opt/homebrew/bin` (macOS only), `/usr/local/bin`, and npm's own configured
 * global prefix. Pure — the caller gathers `miseNodeVersions`/`nvmNodeVersions`/`npmPrefix`
 * (filesystem/shell I/O) and passes them in as plain data.
 */
export function commonBinDirs(input: CommonBinDirsInput): string[] {
	const { home, isMac, miseNodeVersions, nvmNodeVersions, npmPrefix } = input;
	const dirs: string[] = [join(home, ".local", "share", "mise", "shims")];
	for (const v of sortVersionsDesc(miseNodeVersions)) {
		dirs.push(join(home, ".local", "share", "mise", "installs", "node", v, "bin"));
	}
	dirs.push(join(home, ".asdf", "shims"));
	dirs.push(join(home, ".volta", "bin"));
	for (const v of sortVersionsDesc(nvmNodeVersions)) {
		dirs.push(join(home, ".nvm", "versions", "node", v, "bin"));
	}
	dirs.push(join(home, ".local", "bin"));
	if (isMac) {
		dirs.push("/opt/homebrew/bin");
	}
	dirs.push("/usr/local/bin");
	if (npmPrefix) {
		dirs.push(join(npmPrefix, "bin"));
	}
	return dirs;
}

function listVersionDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

async function gatherCommonBinDirsInput(shell: string, isMac: boolean): Promise<CommonBinDirsInput> {
	const home = homedir();
	const miseNodeVersions = listVersionDirs(join(home, ".local", "share", "mise", "installs", "node"));
	const nvmNodeVersions = listVersionDirs(join(home, ".nvm", "versions", "node"));
	let npmPrefix = "";
	try {
		const { stdout } = await execFileText(shell, ["-l", "-c", "npm config get prefix"]);
		npmPrefix = stdout.trim();
	} catch {
		// npm isn't installed/on PATH — no extra directory to check.
	}
	return { home, isMac, miseNodeVersions, nvmNodeVersions, npmPrefix };
}

function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Finds `bin`'s path: the login shell's `command -v <bin>` first, then the same probe in an
 * *interactive* shell (`execInteractive` — catches a version manager only activated from
 * `.zshrc`/`.bashrc`), then `commonBinDirs`' fixed locations (first executable match wins). `null`
 * if none of the three finds it. Shared by `resolveAgentBinary` and `detectAgents` so there's one
 * search order for every agent and every caller.
 */
async function locateBinary(bin: string, isMac: boolean): Promise<string | null> {
	const shell = process.env.SHELL || defaultLoginShell(isMac);
	try {
		const { stdout } = await execFileText(shell, ["-l", "-c", `command -v ${bin}`]);
		const path = stdout.trim();
		if (path) {
			return path;
		}
	} catch {
		// Falls through to the interactive-shell probe.
	}
	const interactive = await execInteractive(shell, `command -v ${bin}`);
	if (interactive) {
		return interactive;
	}
	const dirs = commonBinDirs(await gatherCommonBinDirsInput(shell, isMac));
	return dirs.map((dir) => join(dir, bin)).find(isExecutable) ?? null;
}

/**
 * Resolves `agent`'s executable path. If the setting is empty, runs `locateBinary`'s full search
 * (login shell → interactive shell → common locations). Throws `BackendError` if it can't be
 * found. `isMac` (default `true`) picks the fallback shell when `$SHELL` isn't set.
 */
export async function resolveAgentBinary(agent: AgentId, configuredPath: string, isMac = true): Promise<string> {
	if (configuredPath) {
		return configuredPath;
	}
	const bin = AGENT_BIN_NAME[agent];
	const found = await locateBinary(bin, isMac);
	if (!found) {
		throw new BackendError(t("error.agentMissing", { name: bin }));
	}
	return found;
}

/**
 * Prepends `bin`'s own directory onto `env.PATH`. A binary resolved through a version manager is
 * often a `#!/usr/bin/env node` script (Codex's `codex.js`) rather than a real executable — without
 * its own directory on `PATH`, the spawned process's `env node` lookup can fail if node isn't
 * already reachable through whatever `PATH` it inherits (mise's shims resolve the right node
 * version internally, but still need their own directory reachable at all). Harmless for a real
 * ELF/Mach-O binary too, so applied unconditionally, for every agent, at every launch site.
 */
export function withBinDirOnPath<T extends Record<string, string | undefined>>(env: T, bin: string): T {
	const dir = dirname(bin);
	return { ...env, PATH: env.PATH ? `${dir}${delimiter}${env.PATH}` : dir };
}

/** `<bin> --version`, trimmed to its first non-blank line. `null` on any failure (missing, not
 * executable, unrecognized flag, …) — best-effort, shown next to the detected path in Settings. */
export async function agentVersion(bin: string): Promise<string | null> {
	try {
		const { stdout } = await execFileText(bin, ["--version"], withBinDirOnPath(process.env, bin));
		return firstLine(stdout) || null;
	} catch {
		return null;
	}
}

/**
 * The argv for starting/resuming `agent`'s CLI in a PTY. `fresh` picks new-session vs
 * resume-by-id. Codex has no equivalent of Claude's `--session-id` — there's no way for the
 * caller to assign a new session's id; Codex decides its own new thread's id once it starts (see
 * plan/段9-Codex対応.md) — so a fresh Codex launch takes no id-related flag at all, just the bin.
 */
export function buildAgentArgv(agent: AgentId, bin: string, id: string, fresh: boolean): string[] {
	if (agent === "codex") {
		return fresh ? [bin] : [bin, "resume", id];
	}
	return fresh ? [bin, "--session-id", id] : [bin, "--resume", id];
}

/**
 * Auto-detects each agent's binary via `locateBinary`'s full search (login shell → interactive
 * shell → common locations). `null` for an agent neither finds. Used only on first run (`main.ts`'s
 * `onload`, when settings have never saved an `agents` object before) and the settings tab's
 * "Detect again" button — never silently overwrites a path the user already typed in.
 */
export async function detectAgents(isMac = true): Promise<Record<AgentId, string | null>> {
	const result = {} as Record<AgentId, string | null>;
	for (const agent of AGENT_IDS) {
		result[agent] = await locateBinary(AGENT_BIN_NAME[agent], isMac);
	}
	return result;
}
