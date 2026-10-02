import { describe, expect, it } from "vitest";
import {
	expandWindowsVars,
	isStorePythonStub,
	mergeWindowsPath,
	parseWindowsLauncher,
	pathExts,
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
