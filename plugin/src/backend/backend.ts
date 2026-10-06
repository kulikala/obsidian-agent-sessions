// Calling `agent-sessions json …` and typing its results, plus the login shell's environment.
// Scanning and detection logic lives on the Python side — this file only calls it and receives results.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { t } from "../i18n";
import { AGENT_IDS, parseEnvLines, type AgentId, type AgentSettings } from "../settings";
import type { Detail, RawActivityResult, LiveResult, ScanResult, StatsResult, UsageResult } from "../types";
import { locateWindowsProgram, programInvocation, windowsEnv } from "./windows";

const IS_WINDOWS = process.platform === "win32";

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
	// Windows: a launcher `.cmd` runs as `python script …` and an agent's npm shim through
	// `cmd.exe` (execFile refuses `.cmd` files), with UTF-8 Python and no console window popping
	// up per call.
	const call = programInvocation(cmd, args);
	const callEnv = IS_WINDOWS ? { ...(env ?? process.env), PYTHONUTF8: "1" } : env;
	return new Promise((resolve, reject) => {
		const options = { encoding: "utf8" as const, env: callEnv, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: call.verbatim };
		execFile(call.file, call.args, options, (err, stdout, stderr) => {
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

/** The variables OpenCode locates its database and plugin folder by; the Python side reads them
 * from its own env (`agentsessions/agents/opencode/db.py`, `setup.py`), so they must match what
 * OpenCode itself runs with. */
const OPENCODE_XDG_VARS = ["XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const;

/** The env `setAgentEnv` expects, computed from the current agent settings: `AGENT_SESSIONS_AGENTS`
 * (every enabled agent, comma-separated) plus Codex's `CODEX_HOME` if its "environment
 * variables" setting has one (Python reads `CODEX_HOME` straight from its own env on every
 * call — see `agentsessions/agents/codex/rollout.py`'s `codex_home()`), and OpenCode's
 * `XDG_DATA_HOME` / `XDG_CONFIG_HOME`: from its own "environment variables" setting, else from
 * `login` (the login shell's env, which is what a session launches with; Obsidian's own env
 * usually lacks what a shell rc exports). Pure — no I/O. */
export function agentEnvFor(
	settings: { agents: Record<AgentId, AgentSettings> },
	login: Record<string, string> = {}
): Record<string, string> {
	const enabled = AGENT_IDS.filter((id) => settings.agents[id].enabled);
	const vars: Record<string, string> = { AGENT_SESSIONS_AGENTS: enabled.join(",") };
	const codexHome = parseEnvLines(settings.agents.codex.env).CODEX_HOME;
	if (codexHome) {
		vars.CODEX_HOME = codexHome;
	}
	const opencodeEnv = parseEnvLines(settings.agents.opencode.env);
	for (const name of OPENCODE_XDG_VARS) {
		const value = opencodeEnv[name] || login[name];
		if (value) {
			vars[name] = value;
		}
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

/**
 * `json activity --raw --from ISO --to ISO`: each session's unjoined activity (turns and runs)
 * overlapping the range, to be joined with whatever gap is wanted on this side.
 */
export async function activityRaw(
	agentSessionsPath: string,
	vaultPath: string,
	from: Date,
	to: Date
): Promise<RawActivityResult> {
	return runJson(agentSessionsPath, vaultPath, [
		"activity",
		"--raw",
		"--from",
		from.toISOString(),
		"--to",
		to.toISOString(),
	]) as Promise<RawActivityResult>;
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

/**
 * `json ppid PID…`: each running pid's parent pid, as `{"<pid>": <ppid>}` (a pid that isn't
 * running is left out). `null` when the process table can't be read — callers then go without it.
 */
export async function parentPids(
	agentSessionsPath: string,
	vaultPath: string,
	pids: readonly number[]
): Promise<Record<string, number> | null> {
	const out = (await runJson(agentSessionsPath, vaultPath, ["ppid", ...pids.map(String)])) as {
		parents?: Record<string, number> | null;
	};
	return out.parents ?? null;
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
 * Merges two `PATH`-shaped, delimiter-joined strings: every entry of `login`, in order, then
 * every entry of `interactive` not already present, in order. Drops empty entries. Pure.
 */
export function mergePath(login: string, interactive: string): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const dir of [...login.split(delimiter), ...interactive.split(delimiter)]) {
		if (!dir || seen.has(dir)) {
			continue;
		}
		seen.add(dir);
		merged.push(dir);
	}
	return merged.join(delimiter);
}

/**
 * The login shell's environment (`PATH`, `LANG`, `HOME`, `USER`, `TMPDIR`,
 * `CLAUDE_CONFIG_DIR`). Obsidian launched from the Dock has a sparse environment, so this fills
 * out the `env` passed to the daemon's `start`. `$SHELL -l -c env` is run once and cached.
 * `isMac` (default `true`) picks the fallback shell when `$SHELL` isn't set (`defaultLoginShell`).
 *
 * `PATH` also gets whatever an *interactive* shell (`$SHELL -i -c 'echo $PATH'`, the same
 * `execInteractive` probe `locateBinary` uses — marker-wrapped, 3-second timeout) adds on top,
 * merged in with `mergePath` (login entries first, then any new ones from the interactive shell).
 * A tool installed by a version manager (mise, nvm, …) whose shell integration is wired into
 * `.zshrc`/`.bashrc` rather than a profile file doesn't reach a login-but-non-interactive `PATH`
 * at all — without this, not just this plugin's own `command -v` lookups but *the launched
 * session itself* (and anything it shells out to, like another Claude Code plugin's own hook
 * script) can fail to find node/whatever the version manager manages. If the interactive probe
 * fails or times out, `PATH` is just the login shell's own, unchanged — this never blocks a
 * session from starting.
 */
export async function loginEnv(isMac = true): Promise<Record<string, string>> {
	if (cachedLoginEnv) {
		return cachedLoginEnv;
	}
	if (IS_WINDOWS) {
		// No login shell to ask: the whole environment, with PATH re-read from the registry.
		cachedLoginEnv = await windowsEnv();
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
	const interactivePath = await execInteractive(shell, "echo $PATH");
	if (interactivePath) {
		picked.PATH = mergePath(picked.PATH ?? "", interactivePath);
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
export const AGENT_BIN_NAME: Record<AgentId, string> = { claude: "claude", codex: "codex", opencode: "opencode" };

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
	// OpenCode's own install script puts the binary here.
	dirs.push(join(home, ".opencode", "bin"));
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
	if (IS_WINDOWS) {
		return locateWindowsProgram(bin);
	}
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

/** `locateBinary` for any program (e.g. `python3`), not only an agent's CLI. */
export function locateProgram(bin: string, isMac: boolean): Promise<string | null> {
	return locateBinary(bin, isMac);
}

/** Runs `cmd` and resolves with its stdout (rejects on a non-zero exit, like `execFileText`). */
export async function runProgram(
	cmd: string,
	args: string[],
	timeoutMs = 60000,
	env: NodeJS.ProcessEnv = process.env
): Promise<string> {
	const { stdout } = await execFileText(cmd, args, env, timeoutMs);
	return stdout;
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
	// Windows spells it `Path`; adding a second, differently-cased key would leave which one the
	// child sees to chance.
	const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	const current = env[key];
	return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir };
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
 * plan/段9-Codex対応.md) — so a fresh Codex launch takes no id-related flag at all, just the bin. OpenCode is the same
 * (`opencode` / `opencode --session <id>`); with `opencodeLaunch` it goes through
 * `ollama launch opencode --model <M> -y -- …` instead.
 *
 * `codexNoDaemon` adds `--no-daemon` (Windows, when the binary has it: `codexNoDaemon`): Codex's TUI
 * otherwise attaches to, or first installs, a shared background app-server, which refuses a package
 * laid out differently from npm's (WinGet's: "the CLI package does not match this platform or
 * executable").
 */
export function buildAgentArgv(
	agent: AgentId,
	bin: string,
	id: string,
	fresh: boolean,
	opencodeLaunch?: OpencodeLaunch,
	codexNoDaemon = false,
): string[] {
	if (agent === "codex") {
		const own = codexNoDaemon ? [bin, "--no-daemon"] : [bin];
		return fresh ? own : [...own, "resume", id];
	}
	if (agent === "opencode") {
		// OpenCode can't be told a new session's id either (like Codex): a fresh launch takes no
		// id flag; a resume passes `--session <id>`.
		const tail = fresh ? [] : ["--session", id];
		if (opencodeLaunch) {
			return [opencodeLaunch.ollamaBin, "launch", "opencode", "--model", opencodeLaunch.model, "-y", "--", ...tail];
		}
		return [bin, ...tail];
	}
	return fresh ? [bin, "--session-id", id] : [bin, "--resume", id];
}

/** Where an interactive Codex runs with `--no-daemon` (see `buildAgentArgv`). */
export const CODEX_NO_DAEMON_PLATFORMS: readonly string[] = ["win32"];

/** Whether `codex --help` lists `--no-daemon` (Codex builds before the shared app-server lack it and
 * refuse an unknown flag). Pure. */
export function helpListsNoDaemon(help: string): boolean {
	return /(^|\s)--no-daemon\b/m.test(help);
}

const codexNoDaemonCache = new Map<string, Promise<boolean>>();

/** Whether Codex at `bin` should start with `--no-daemon` on `platform`: only where
 * `CODEX_NO_DAEMON_PLATFORMS` says so, and only when its `--help` lists the flag (asked once per
 * binary; a failed `--help` counts as no). */
export function codexNoDaemon(bin: string, platform: string = process.platform): Promise<boolean> {
	if (!CODEX_NO_DAEMON_PLATFORMS.includes(platform)) {
		return Promise.resolve(false);
	}
	let known = codexNoDaemonCache.get(bin);
	if (!known) {
		known = execFileText(bin, ["--help"], withBinDirOnPath(process.env, bin), 15000).then(
			({ stdout }) => helpListsNoDaemon(stdout),
			() => false
		);
		codexNoDaemonCache.set(bin, known);
	}
	return known;
}

/** OpenCode started through `ollama launch opencode`: the ollama binary and the (non-empty) model. */
export interface OpencodeLaunch {
	ollamaBin: string;
	model: string;
}

/**
 * `ollama list`'s model names (first column, header row dropped). `[]` if ollama is missing,
 * stopped, or prints nothing — best-effort, feeds the settings dropdown only.
 */
export async function listOllamaModels(ollamaBin: string): Promise<string[]> {
	try {
		const { stdout } = await execFileText(ollamaBin, ["list"], process.env, 8000);
		return parseOllamaList(stdout);
	} catch {
		return [];
	}
}

/** Parses `ollama list` output: a header line (`NAME  ID  SIZE  MODIFIED`), then one model per line. */
export function parseOllamaList(output: string): string[] {
	const names: string[] = [];
	for (const line of output.split("\n").slice(1)) {
		const name = line.trim().split(/\s+/)[0];
		if (name) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Auto-detects a single agent's binary via `locateBinary`'s full search (login shell →
 * interactive shell → common locations). `null` if not found. Backs both `detectAgents` (every
 * agent, first run) and the settings tab's per-agent "Find again" button (T-117 — refinds just
 * the one agent the button is on, rather than re-probing every agent's binary for an unrelated
 * button click).
 */
export async function detectAgent(agent: AgentId, isMac = true): Promise<string | null> {
	return locateBinary(AGENT_BIN_NAME[agent], isMac);
}

/**
 * Auto-detects each agent's binary (`detectAgent`, run in turn). `null` for an agent neither
 * finds. Used only on first run (`main.ts`'s `onload`, when settings have never saved an `agents`
 * object before) — never silently overwrites a path the user already typed in.
 */
export async function detectAgents(isMac = true): Promise<Record<AgentId, string | null>> {
	const result = {} as Record<AgentId, string | null>;
	for (const agent of AGENT_IDS) {
		result[agent] = await detectAgent(agent, isMac);
	}
	return result;
}
