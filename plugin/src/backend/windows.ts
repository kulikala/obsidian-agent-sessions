// Native Windows: finding programs, the environment sessions start with, Python, WinGet, and the
// `.cmd` launcher. The rest of the plugin calls these instead of the login-shell probes it uses on
// macOS/Linux (there is no login shell to ask on Windows).
//
// Pure helpers take their inputs as arguments (tested in vitest on any OS); the I/O wrappers
// below them read the registry, the file system and run programs.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Pure ---------------------------------------------------------------------------------

/** `PATHEXT` as a lower-case extension list (`.exe`, `.cmd`, …), with a sane default. */
export function pathExts(pathext: string | undefined): string[] {
	const list = (pathext || ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e.startsWith("."));
	return list.length ? list : [".exe", ".cmd"];
}

/** Joins PATH-like lists (`;`), dropping empties and duplicates (case-insensitively, as Windows
 * compares paths), keeping the first occurrence's order. */
export function mergeWindowsPath(...lists: (string | undefined)[]): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const raw of (list ?? "").split(";")) {
			const dir = raw.trim();
			const key = dir.toLowerCase().replace(/[\\/]+$/, "");
			if (!dir || seen.has(key)) continue;
			seen.add(key);
			out.push(dir);
		}
	}
	return out.join(";");
}

/** Expands `%NAME%` references against `env` (names compared case-insensitively). */
export function expandWindowsVars(text: string, env: Record<string, string | undefined>): string {
	const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
	return text.replace(/%([^%]+)%/g, (all, name: string) => lower.get(name.toLowerCase()) ?? all);
}

/** Directories programs installed per-user tend to land in without being on Obsidian's PATH yet:
 * WinGet's command links, Claude Code's native installer, npm's global bin (Codex's and OpenCode's
 * `.cmd` shims), OpenCode's own install folder. */
export function extraProgramDirs(env: Record<string, string | undefined>): string[] {
	const out: string[] = [];
	if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
	if (env.USERPROFILE) out.push(path.win32.join(env.USERPROFILE, ".local", "bin"));
	if (env.APPDATA) out.push(path.win32.join(env.APPDATA, "npm"));
	if (env.USERPROFILE) out.push(path.win32.join(env.USERPROFILE, ".opencode", "bin"));
	return out;
}

/** The Microsoft Store's "App execution alias" for python.exe/python3.exe: a 0-byte placeholder
 * in `…\Microsoft\WindowsApps` that only opens the Store (exit 9009) unless a Store Python is
 * installed. Never offered as Python. */
export function isStorePythonStub(file: string, size: number): boolean {
	return /\\microsoft\\windowsapps\\python3?\.exe$/i.test(file) && size === 0;
}

/** Version-sorted (newest first) python.exe candidates under python.org's per-user and all-users
 * install folders (`Python313`, `Python313-arm64`, `Python312-32`, …). `dirNames` maps each root
 * to its sub-folder names. */
export function pythonOrgCandidates(roots: { root: string; dirNames: string[] }[]): string[] {
	const found: { file: string; major: number; minor: number }[] = [];
	for (const { root, dirNames } of roots) {
		for (const name of dirNames) {
			const m = /^Python(\d)(\d+)(?:-(?:arm64|32))?$/i.exec(name);
			if (!m) continue;
			found.push({ file: path.win32.join(root, name, "python.exe"), major: Number(m[1]), minor: Number(m[2]) });
		}
	}
	found.sort((a, b) => b.major - a.major || b.minor - a.minor);
	return found.map((f) => f.file);
}

/** The launcher as a `.cmd`: UTF-8 Python, the interpreter that was checked, and the bundled
 * script next to it (`%~dp0` is the `.cmd`'s own folder). */
export function windowsLauncherSource(python: string): string {
	return ["@echo off", "set PYTHONUTF8=1", `"${python}" "%~dp0agent-sessions" %*`, ""].join("\r\n");
}

/** The built-in editor's shim as a `.cmd` (its basename has to contain "code"; see
 * bin/agent-sessions-code). */
export function windowsEditorShimSource(): string {
	return ["@echo off", `call "%~dp0agent-sessions.cmd" edit %*`, ""].join("\r\n");
}

/** `[python, script]` from a launcher `.cmd` written by `windowsLauncherSource`, so the plugin can
 * run the program directly — `execFile` refuses `.cmd` files, and going through `cmd.exe` would
 * re-parse every argument. `null` for anything else. */
export function parseWindowsLauncher(cmdText: string, cmdPath: string): [string, string] | null {
	const m = /^"([^"]+)" "%~dp0([^"]+)" %\*\s*$/m.exec(cmdText);
	if (!m) return null;
	return [m[1], path.win32.join(path.win32.dirname(cmdPath), m[2])];
}

/** How to start a program without a shell: `file`, `args`, and whether Node must pass `args` to
 * Windows as written (`windowsVerbatimArguments`, for the `cmd.exe /c` form). */
export interface Invocation {
	file: string;
	args: string[];
	verbatim?: boolean;
}

/** Characters `cmd.exe` gives a meaning to (and space, which ends a word there). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a batch file run through `cmd.exe /d /s /c`: quoted the way the C runtime
 * (Node, the program the batch file starts) reads it back, then every `cmd.exe` metacharacter
 * escaped with `^` twice, once for the `/c` line and once more for the batch file's own `%*` line,
 * which cmd parses again. The scheme cross-spawn uses for npm's shims. */
export function cmdShimArgument(arg: string): string {
	let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
	quoted = `"${quoted}"`;
	return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** `file args` as a `cmd.exe /d /s /c "…"` invocation. Node refuses to start a `.cmd`/`.bat` itself
 * (EINVAL) — npm installs Codex and OpenCode as such shims (`codex.cmd`, `opencode.cmd`) — and
 * `shell: true` would leave the quoting to chance. Pure. */
export function cmdShimInvocation(file: string, args: string[], comspec: string): Invocation {
	const line = [file.replace(CMD_META, "^$1"), ...args.map(cmdShimArgument)].join(" ");
	return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** Whether `file` is a batch script Windows runs through `cmd.exe`. */
export function isBatchFile(file: string): boolean {
	return /\.(cmd|bat)$/i.test(file);
}

// ---- I/O ----------------------------------------------------------------------------------

function run(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, env }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		});
	});
}

/** A registry `Path`/value via `reg query` (no PowerShell start-up cost). `""` if missing. */
async function regValue(key: string, name: string): Promise<string> {
	try {
		const out = await run("reg.exe", ["query", key, "/v", name], 5000);
		const m = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, "im").exec(out);
		return m ? m[1].trim() : "";
	} catch {
		return "";
	}
}

let cachedEnv: Record<string, string> | null = null;

/**
 * The environment a session starts with on Windows: Obsidian's own, with `PATH` re-read from the
 * registry (user + machine — so something installed after Obsidian started, e.g. by WinGet, is
 * found without restarting Obsidian) plus `extraProgramDirs`, and `PYTHONUTF8=1`. Cached; `fresh`
 * re-reads it (after an install).
 */
export async function windowsEnv(fresh = false): Promise<Record<string, string>> {
	if (cachedEnv && !fresh) return cachedEnv;
	const base: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) base[k] = v;
	}
	const [machine, user] = await Promise.all([
		regValue("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Path"),
		regValue("HKCU\\Environment", "Path"),
	]);
	const pathKey = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "Path";
	const merged = mergeWindowsPath(
		expandWindowsVars(machine, base),
		expandWindowsVars(user, base),
		base[pathKey],
		extraProgramDirs(base).join(";")
	);
	delete base[pathKey];
	base.Path = merged;
	base.PYTHONUTF8 = "1";
	cachedEnv = base;
	return base;
}

function fileSize(file: string): number | null {
	try {
		const st = fs.statSync(file);
		return st.isFile() ? st.size : null;
	} catch {
		return null;
	}
}

/** `name`'s full path on `PATH` (with `PATHEXT`), skipping the Store's Python stub. */
export async function locateWindowsProgram(name: string): Promise<string | null> {
	const env = await windowsEnv();
	const exts = path.win32.extname(name) ? [""] : pathExts(env.PATHEXT);
	for (const dir of (env.Path ?? "").split(";")) {
		if (!dir) continue;
		for (const ext of exts) {
			const file = path.win32.join(dir, name + ext);
			const size = fileSize(file);
			if (size === null || isStorePythonStub(file, size)) continue;
			// WinGet's links are 0-byte reparse points too, but real programs: only the python stub is excluded.
			return file;
		}
	}
	return null;
}

/** Python candidates, best first: the `py` launcher's own pick, python.org's install folders, then
 * `python.exe` on PATH. The caller checks each one's version by running it. */
export async function windowsPythonCandidates(): Promise<string[]> {
	const env = await windowsEnv();
	const out: string[] = [];
	const py = await locateWindowsProgram("py.exe");
	if (py) {
		try {
			const exe = (await run(py, ["-3", "-c", "import sys; print(sys.executable)"], 15000, env)).trim();
			if (exe) out.push(exe);
		} catch {
			// No Python 3 registered with the launcher.
		}
	}
	const roots = [
		env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Programs", "Python") : "",
		env.ProgramFiles ?? env.PROGRAMFILES ?? "",
	].filter(Boolean);
	out.push(
		...pythonOrgCandidates(
			roots.map((root) => {
				let dirNames: string[] = [];
				try {
					dirNames = fs.readdirSync(root);
				} catch {
					// Not there.
				}
				return { root, dirNames };
			})
		)
	);
	const onPath = await locateWindowsProgram("python.exe");
	if (onPath) out.push(onPath);
	return [...new Set(out)];
}

/** Whether `file` exists without following it — an App Execution Alias in `WindowsApps` can't be
 * `stat`ed, only `lstat`ed. */
function aliasExists(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/** `winget.exe`, if this Windows has it (App Installer; on a fresh install it can take a while
 * before the Store registers it). */
export async function locateWinget(): Promise<string | null> {
	const env = await windowsEnv();
	if (env.LOCALAPPDATA) {
		const file = path.win32.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe");
		// An App Execution Alias: `stat` (and so `existsSync`) fails on it with EACCES, but it runs.
		if (aliasExists(file)) return file;
	}
	return locateWindowsProgram("winget.exe");
}

/** The WinGet packages the plugin can install for the user. */
export const WINGET_PACKAGES = {
	python: "Python.Python.3.13",
	claude: "Anthropic.ClaudeCode",
} as const;

export type WingetPackage = keyof typeof WINGET_PACKAGES;

/** The arguments for a quiet, per-user (no administrator prompt) WinGet install. Pure. */
export function wingetInstallArgs(pkg: WingetPackage): string[] {
	return [
		"install",
		"--exact",
		"--id",
		WINGET_PACKAGES[pkg],
		"--scope",
		"user",
		"--silent",
		"--accept-package-agreements",
		"--accept-source-agreements",
		"--disable-interactivity",
	];
}

/** Installs `pkg` with WinGet; resolves when done, rejects with WinGet's output on failure. The
 * cached environment is refreshed afterwards, so the new program is found right away. */
export async function wingetInstall(pkg: WingetPackage): Promise<void> {
	const winget = await locateWinget();
	if (!winget) throw new Error("winget-missing");
	try {
		await run(winget, wingetInstallArgs(pkg), 15 * 60 * 1000, await windowsEnv());
	} catch (err) {
		// "Already installed" exits non-zero too; whether it worked is judged by finding the program.
		const out = (err as { stdout?: string }).stdout ?? "";
		if (!/already installed|既にインストール/i.test(out)) {
			await windowsEnv(true);
			throw err;
		}
	}
	await windowsEnv(true);
}

/**
 * How to run `cmd args` without a shell: on Windows a launcher `.cmd` written by
 * `windowsLauncherSource` becomes `python script args` (with `PYTHONUTF8=1` added to `env` by the
 * caller via `windowsEnv`), and any other `.cmd`/`.bat` (an agent's npm shim) goes through
 * `cmd.exe` (`cmdShimInvocation`); everything else is returned unchanged.
 */
export function programInvocation(cmd: string, args: string[]): Invocation {
	if (process.platform !== "win32" || !isBatchFile(cmd)) {
		return { file: cmd, args };
	}
	try {
		const parsed = parseWindowsLauncher(fs.readFileSync(cmd, "utf8"), cmd);
		if (parsed) {
			return { file: parsed[0], args: [parsed[1], ...args] };
		}
	} catch {
		// Not readable: still a batch file, so it goes through cmd.exe and fails there with its own path.
	}
	return cmdShimInvocation(cmd, args, process.env.ComSpec || process.env.COMSPEC || "cmd.exe");
}
