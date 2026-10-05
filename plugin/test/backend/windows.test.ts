import { describe, expect, it } from "vitest";
import {
	cmdShimArgument,
	cmdShimInvocation,
	expandWindowsVars,
	extraProgramDirs,
	isBatchFile,
	isStorePythonStub,
	mergeWindowsPath,
	parseWindowsLauncher,
	pathExts,
	programInvocation,
	shimInShortDir,
	shortPathLine,
	pythonOrgCandidates,
	windowsLauncherSource,
	wingetInstallArgs,
} from "../../src/backend/windows";

describe("pathExts", () => {
	it("lower-cases PATHEXT and falls back to a default", () => {
		expect(pathExts(".COM;.EXE;.BAT;.CMD")).toEqual([".com", ".exe", ".bat", ".cmd"]);
		expect(pathExts(undefined)).toEqual([".com", ".exe", ".bat", ".cmd"]);
	});
});

describe("mergeWindowsPath", () => {
	it("keeps the first occurrence, comparing case-insensitively and ignoring trailing slashes", () => {
		expect(mergeWindowsPath("C:\\A;C:\\b\\", "c:\\a;C:\\B;;C:\\C", undefined)).toBe("C:\\A;C:\\b\\;C:\\C");
	});
});

describe("expandWindowsVars", () => {
	it("expands %NAME% case-insensitively and leaves unknown names alone", () => {
		expect(expandWindowsVars("%USERPROFILE%\\x;%nope%", { UserProfile: "C:\\Users\\a" })).toBe("C:\\Users\\a\\x;%nope%");
	});
});

describe("isStorePythonStub", () => {
	it("is the 0-byte WindowsApps alias only", () => {
		expect(isStorePythonStub("C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe", 0)).toBe(true);
		expect(isStorePythonStub("C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe", 0)).toBe(true);
		expect(isStorePythonStub("C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe", 0)).toBe(false);
		expect(isStorePythonStub("C:\\Python313\\python.exe", 0)).toBe(false);
	});
});

describe("pythonOrgCandidates", () => {
	it("orders python.org folders newest first, including arm64 and 32-bit builds", () => {
		expect(
			pythonOrgCandidates([
				{ root: "C:\\L", dirNames: ["Python39", "Launcher", "Python313-arm64"] },
				{ root: "C:\\P", dirNames: ["Python312-32"] },
			])
		).toEqual(["C:\\L\\Python313-arm64\\python.exe", "C:\\P\\Python312-32\\python.exe", "C:\\L\\Python39\\python.exe"]);
	});
});

describe("windows launcher", () => {
	it("round-trips through parseWindowsLauncher", () => {
		const text = windowsLauncherSource("C:\\Program Files\\Python313\\python.exe");
		expect(text).toContain("set PYTHONUTF8=1");
		expect(parseWindowsLauncher(text, "C:\\Users\\a\\AppData\\Local\\agent-sessions\\bin\\agent-sessions.cmd")).toEqual([
			"C:\\Program Files\\Python313\\python.exe",
			"C:\\Users\\a\\AppData\\Local\\agent-sessions\\bin\\agent-sessions",
		]);
		expect(parseWindowsLauncher("@echo hi", "C:\\x.cmd")).toBeNull();
	});
});

describe("wingetInstallArgs", () => {
	it("installs quietly for the current user only", () => {
		const args = wingetInstallArgs("claude");
		expect(args).toEqual(expect.arrayContaining(["install", "--exact", "--id", "Anthropic.ClaudeCode", "--scope", "user", "--silent"]));
	});
});

describe("extraProgramDirs", () => {
	it("adds WinGet's links, ~\\.local\\bin, npm's global bin and OpenCode's own folder", () => {
		const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", USERPROFILE: "C:\\Users\\a", APPDATA: "C:\\Users\\a\\AppData\\Roaming" };
		expect(extraProgramDirs(env)).toEqual([
			"C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links",
			"C:\\Users\\a\\.local\\bin",
			"C:\\Users\\a\\AppData\\Roaming\\npm",
			"C:\\Users\\a\\.opencode\\bin",
		]);
		expect(extraProgramDirs({})).toEqual([]);
	});
});

describe("npm shims through cmd.exe", () => {
	it("recognizes batch files by extension, in any case", () => {
		expect(isBatchFile("C:\\npm\\codex.cmd")).toBe(true);
		expect(isBatchFile("C:\\npm\\OPENCODE.CMD")).toBe(true);
		expect(isBatchFile("C:\\x\\run.bat")).toBe(true);
		expect(isBatchFile("C:\\x\\opencode.exe")).toBe(false);
		expect(isBatchFile("/usr/local/bin/codex")).toBe(false);
	});

	it("quotes each argument for the C runtime and escapes cmd's metacharacters twice", () => {
		expect(cmdShimArgument("exec")).toBe('^^^"exec^^^"');
		expect(cmdShimArgument("")).toBe('^^^"^^^"');
		expect(cmdShimArgument("a b")).toBe('^^^"a^^^ b^^^"');
		expect(cmdShimArgument('{"a":true}')).toBe('^^^"{\\^^^"a\\^^^":true}^^^"');
		expect(cmdShimArgument("C:\\dir\\")).toBe('^^^"C:\\dir\\\\^^^"');
		expect(cmdShimArgument("a&b|c<d>e%f!g^h")).toBe('^^^"a^^^&b^^^|c^^^<d^^^>e^^^%f^^^!g^^^^h^^^"');
	});

	it("runs the shim as one verbatim `cmd.exe /d /s /c` line", () => {
		expect(cmdShimInvocation("C:\\Users\\A B\\npm\\codex.cmd", ["exec", "-"], "C:\\Windows\\system32\\cmd.exe")).toEqual({
			file: "C:\\Windows\\system32\\cmd.exe",
			args: ["/d", "/s", "/c", '"C:\\Users\\A^ B\\npm\\codex.cmd ^^^"exec^^^" ^^^"-^^^""'],
			verbatim: true,
		});
	});

	it("leaves programs alone off Windows", () => {
		if (process.platform === "win32") {
			return;
		}
		expect(programInvocation("/usr/local/bin/codex.cmd", ["exec"])).toEqual({ file: "/usr/local/bin/codex.cmd", args: ["exec"] });
	});
});

describe("the editor shim without spaces", () => {
	it("asks cmd.exe for a path's 8.3 form", () => {
		expect(shortPathLine("C:\\Users\\Jane Doe\\AppData\\Local\\agent-sessions\\bin")).toBe(
			'for %I in ("C:\\Users\\Jane Doe\\AppData\\Local\\agent-sessions\\bin") do @echo %~sI'
		);
	});

	it("keeps the shim's own name, which has to contain \"code\"", () => {
		expect(
			shimInShortDir("C:\\Users\\Jane Doe\\AppData\\Local\\agent-sessions\\bin\\agent-sessions-code.cmd", "C:\\Users\\JANEDO~1\\AppData\\Local\\AGENT-~1\\bin")
		).toBe("C:\\Users\\JANEDO~1\\AppData\\Local\\AGENT-~1\\bin\\agent-sessions-code.cmd");
	});
});
