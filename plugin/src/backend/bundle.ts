// The `agent-sessions` program (Python) ships inside main.js as plain text (`bundle-files.ts`,
// generated at build time) and is written out to a directory of the user's on request. This
// module is everything about that directory short of the UI: which platforms can run it at all,
// where to put it, finding a usable Python, writing and replacing the files, and reading back
// what's installed. No dependency on `obsidian` (tested directly in vitest).
//
// Layout of an install directory — the same as this repository's, so the launcher finds its
// package the same way (`bin/agent-sessions` imports `agentsessions` from its parent directory):
//
//   <dir>/bin/agent-sessions        the launcher, its shebang set to the Python found
//   <dir>/bin/agent-sessions-code   the `$VISUAL` shim for the built-in editor
//   <dir>/agentsessions/…           the package
//   <dir>/install.json              { version, python } — what `findInstalled` reads back
//
// On Windows the launcher and the shim are `bin/agent-sessions.cmd` and
// `bin/agent-sessions-code.cmd` (`windows.ts`), next to the same Python script.

import * as fs from "node:fs";
import * as path from "node:path";
import { windowsEditorShimSource, windowsLauncherSource } from "./windows";

/** Desktop macOS, Linux (including Linux Obsidian under WSLg) and Windows 10/11 (ConPTY). */
const SUPPORTED_PLATFORMS: readonly string[] = ["darwin", "linux", "win32"];

/** Whether this plugin can run here at all. Mobile has no processes; the plugin loads nothing
 * but an explanation there. */
export function isSupportedPlatform(platform: string, isMobile: boolean): boolean {
	return !isMobile && SUPPORTED_PLATFORMS.includes(platform);
}

export const INSTALL_INFO_FILE = "install.json";
const IS_WINDOWS = process.platform === "win32";
const SCRIPT = path.join("bin", "agent-sessions");
const LAUNCHER = IS_WINDOWS ? path.join("bin", "agent-sessions.cmd") : SCRIPT;
const TOP_LEVEL = ["bin", "agentsessions"] as const;

export interface InstallInfo {
	dir: string;
	version: string;
	/** The interpreter the launcher's shebang names. */
	python: string;
}

export function launcherPath(dir: string): string {
	return path.join(dir, LAUNCHER);
}

// ---- Where to install -------------------------------------------------------------------

/**
 * Install locations in order of preference: the XDG data directory (`$XDG_DATA_HOME`, or its
 * default `~/.local/share`) — the conventional home for per-user program data on Linux, and a
 * common one on macOS too — then this program's own runtime directory as a last resort. macOS's
 * `~/Library/Application Support` is deliberately not a candidate: the space in it would break
 * the `$VISUAL` value Claude Code runs the built-in editor through.
 */
export function installCandidates(
	home: string,
	env: Record<string, string | undefined>,
	platform: string = process.platform
): string[] {
	const out: string[] = [];
	if (platform === "win32") {
		// %LOCALAPPDATA% is the per-user, non-roaming program data folder.
		if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, "agent-sessions"));
		out.push(path.win32.join(home, ".agents", "sessions", "app"));
		return [...new Set(out)];
	}
	const xdg = env.XDG_DATA_HOME;
	if (xdg && path.isAbsolute(xdg)) {
		out.push(path.join(xdg, "agent-sessions"));
	}
	out.push(path.join(home, ".local", "share", "agent-sessions"));
	out.push(path.join(home, ".agents", "sessions", "app"));
	return [...new Set(out)];
}

/** Characters a path may use: it ends up inside a double-quoted hook command in Claude Code's
 * `settings.json` and unquoted in `$VISUAL`, so anything a shell would split on or expand
 * (whitespace, quotes, `$`, backticks, backslashes, globs) rules a location out. */
const SAFE_PATH = /^\/[A-Za-z0-9._/+@,:~-]*$/;
/** Windows: a drive path free of what cmd.exe, PowerShell or bash would act on (`"`, `%`, `!`,
 * `^`, `&`, `|`, `<`, `>`, `` ` ``, `$`, `;`). Spaces are fine — hook commands name the launcher by
 * its 8.3 short path (`agentsessions/claude/setup.py`). */
const SAFE_PATH_WINDOWS = /^[A-Za-z]:\\[^"%!^&|<>`$;]*$/;

export type UnsuitableReason = "characters" | "in-vault" | "not-writable";

/** Why `dir` can't be used, or `null` if it can. `vaultPath` rules out the vault itself (it may
 * be synced, and the program is not a note). */
export function unsuitableReason(
	dir: string,
	vaultPath: string,
	writable: (dir: string) => boolean,
	platform: string = process.platform
): UnsuitableReason | null {
	const windows = platform === "win32";
	if (!(windows ? SAFE_PATH_WINDOWS : SAFE_PATH).test(dir)) {
		return "characters";
	}
	const paths = windows ? path.win32 : path;
	const rel = paths.relative(vaultPath, dir);
	if (rel === "" || (!rel.startsWith("..") && !paths.isAbsolute(rel))) {
		return "in-vault";
	}
	if (!writable(dir)) {
		return "not-writable";
	}
	return null;
}

/** Whether `dir` could be created (if missing) and written to — judged from its nearest
 * existing ancestor's permissions, without creating anything (this runs while the user is
 * still deciding whether to install). */
export function isWritableDir(dir: string): boolean {
	let current = dir;
	for (;;) {
		try {
			if (!fs.statSync(current).isDirectory()) {
				return false;
			}
			fs.accessSync(current, fs.constants.W_OK | fs.constants.X_OK);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				return false;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return false;
		}
		current = parent;
	}
}

export interface InstallDirChoice {
	/** The first usable candidate, or `null` if none is. */
	dir: string | null;
	/** Every candidate passed over on the way, with why. */
	rejected: { dir: string; reason: UnsuitableReason }[];
}

export function chooseInstallDir(
	candidates: string[],
	vaultPath: string,
	writable: (dir: string) => boolean = isWritableDir
): InstallDirChoice {
	const rejected: InstallDirChoice["rejected"] = [];
	for (const dir of candidates) {
		const reason = unsuitableReason(dir, vaultPath, writable);
		if (!reason) {
			return { dir, rejected };
		}
		rejected.push({ dir, reason });
	}
	return { dir: null, rejected };
}

// ---- What's installed ---------------------------------------------------------------------

export function readInstallInfo(dir: string): InstallInfo | null {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(path.join(dir, INSTALL_INFO_FILE), "utf8"));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const { version, python } = raw as Record<string, unknown>;
	if (typeof version !== "string" || typeof python !== "string" || !fs.existsSync(launcherPath(dir))) {
		return null;
	}
	return { dir, version, python };
}

/** The first candidate holding a complete install. */
export function findInstalled(candidates: string[]): InstallInfo | null {
	for (const dir of candidates) {
		const info = readInstallInfo(dir);
		if (info) {
			return info;
		}
	}
	return null;
}

// ---- Writing ------------------------------------------------------------------------------

/** The launcher as bundled, with its first line swapped for a shebang naming `python`
 * directly — so hooks and the daemon run under the interpreter that was checked, whatever
 * `PATH` they happen to inherit. */
export function launcherSource(bundled: string, python: string): string {
	const lines = bundled.split("\n");
	if (lines[0]?.startsWith("#!")) {
		lines.shift();
	}
	return [`#!${python}`, ...lines].join("\n");
}

/**
 * Writes `files` (paths relative to the install directory, as bundled) into `dir`, replacing
 * whatever version is there. Everything is written to a staging directory first and swapped in
 * one top-level entry at a time, so a failure part-way through leaves the previous install
 * untouched rather than half-overwritten.
 */
export function writeBundle(dir: string, files: Record<string, string>, version: string, python: string): InstallInfo {
	fs.mkdirSync(dir, { recursive: true });
	const staging = fs.mkdtempSync(path.join(dir, ".staging-"));
	try {
		for (const [rel, text] of Object.entries(files)) {
			const target = path.join(staging, rel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const isScript = rel === SCRIPT || rel === "bin/agent-sessions";
			fs.writeFileSync(target, isScript && !IS_WINDOWS ? launcherSource(text, python) : text, "utf8");
			if (!IS_WINDOWS && (rel.startsWith(`bin${path.sep}`) || rel.startsWith("bin/"))) {
				fs.chmodSync(target, 0o755);
			}
		}
		if (IS_WINDOWS) {
			fs.writeFileSync(path.join(staging, "bin", "agent-sessions.cmd"), windowsLauncherSource(python), "utf8");
			fs.writeFileSync(path.join(staging, "bin", "agent-sessions-code.cmd"), windowsEditorShimSource(), "utf8");
		}
		for (const top of TOP_LEVEL) {
			const from = path.join(staging, top);
			if (!fs.existsSync(from)) {
				continue;
			}
			const to = path.join(dir, top);
			fs.rmSync(to, { recursive: true, force: true });
			fs.renameSync(from, to);
		}
		const info: InstallInfo = { dir, version, python };
		fs.writeFileSync(path.join(dir, INSTALL_INFO_FILE), JSON.stringify({ version, python }, null, "\t") + "\n", "utf8");
		return info;
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** Removes what `writeBundle` wrote, and `dir` itself if that leaves it empty. */
export function removeBundle(dir: string): void {
	for (const top of TOP_LEVEL) {
		fs.rmSync(path.join(dir, top), { recursive: true, force: true });
	}
	fs.rmSync(path.join(dir, INSTALL_INFO_FILE), { force: true });
	try {
		fs.rmdirSync(dir);
	} catch {
		// Not empty (something else lives there too): leave it.
	}
}

/** How a hook command should name the launcher: `$HOME/…` when it's under the home directory,
 * so a `settings.json` synced between machines with different user names keeps working. */
export function hookLauncher(dir: string, home: string): string {
	const launcher = launcherPath(dir);
	if (IS_WINDOWS) {
		// No `$HOME` in PowerShell's or cmd's syntax; the program writes it as an 8.3 path.
		return launcher;
	}
	const rel = path.relative(home, launcher);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `$HOME/${rel}` : launcher;
}

// ---- Python -------------------------------------------------------------------------------

export const MIN_PYTHON: readonly [number, number] = [3, 9];

/** `3.12` → `[3, 12]`; `null` for anything else. */
export function parsePythonVersion(text: string): [number, number] | null {
	const m = /^(\d+)\.(\d+)\s*$/.exec(text.trim());
	return m ? [Number(m[1]), Number(m[2])] : null;
}

export function isRecentEnough(version: [number, number]): boolean {
	return version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1]);
}

export interface PythonInfo {
	path: string;
	version: string;
}

export interface PythonProbe {
	/** `python3` as the user's shell resolves it, or `null`. */
	locate: () => Promise<string | null>;
	/** Runs a program and resolves with its stdout; rejects if it fails. */
	run: (bin: string, args: string[]) => Promise<string>;
	exists: (path: string) => boolean;
}

/** Fixed places to try after the shell's own `python3`. */
const PYTHON_FALLBACKS = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];

/**
 * The first Python 3.9+ found: the shell's `python3`, then the usual install locations. On macOS,
 * `/usr/bin/python3` is only a stub until the Command Line Tools are installed, and running it
 * then pops up an installer dialog — so it's only tried once `xcode-select -p` says they are.
 */
export async function findPython(isMac: boolean, probe: PythonProbe): Promise<PythonInfo | null> {
	const located = await probe.locate().catch(() => null);
	const candidates = [...new Set([...(located ? [located] : []), ...PYTHON_FALLBACKS])];
	for (const bin of candidates) {
		if (!probe.exists(bin)) {
			continue;
		}
		if (isMac && bin === "/usr/bin/python3") {
			const tools = await probe.run("/usr/bin/xcode-select", ["-p"]).catch(() => null);
			if (!tools) {
				continue;
			}
		}
		const out = await probe.run(bin, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).catch(() => null);
		const version = out ? parsePythonVersion(out) : null;
		if (version && isRecentEnough(version)) {
			return { path: bin, version: `${version[0]}.${version[1]}` };
		}
	}
	return null;
}

/** The first of `candidates` that runs and reports Python 3.9+ (Windows, where the candidates come
 * from `windowsPythonCandidates`). */
export async function findPythonIn(
	candidates: string[],
	run: (bin: string, args: string[]) => Promise<string>
): Promise<PythonInfo | null> {
	for (const bin of candidates) {
		const out = await run(bin, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).catch(() => null);
		const version = out ? parsePythonVersion(out) : null;
		if (version && isRecentEnough(version)) {
			return { path: bin, version: `${version[0]}.${version[1]}` };
		}
	}
	return null;
}
