import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	chooseInstallDir,
	findInstalled,
	findPython,
	hookLauncher,
	installCandidates,
	isRecentEnough,
	isSupportedPlatform,
	isWritableDir,
	launcherPath,
	launcherSource,
	parsePythonVersion,
	readInstallInfo,
	removeBundle,
	unsuitableReason,
	writeBundle,
	type PythonProbe,
} from "../../src/backend/bundle";

describe("isSupportedPlatform", () => {
	it("runs on desktop macOS, Linux and Windows only", () => {
		expect(isSupportedPlatform("darwin", false)).toBe(true);
		expect(isSupportedPlatform("linux", false)).toBe(true);
		expect(isSupportedPlatform("win32", false)).toBe(true);
		expect(isSupportedPlatform("freebsd", false)).toBe(false);
		expect(isSupportedPlatform("darwin", true)).toBe(false);
		expect(isSupportedPlatform("linux", true)).toBe(false);
	});
});

describe("installCandidates", () => {
	it("prefers $XDG_DATA_HOME, then ~/.local/share, then the runtime directory", () => {
		expect(installCandidates("/home/u", { XDG_DATA_HOME: "/data" })).toEqual([
			"/data/agent-sessions",
			"/home/u/.local/share/agent-sessions",
			"/home/u/.agents/sessions/app",
		]);
	});

	it("ignores a relative $XDG_DATA_HOME, as the XDG spec says to", () => {
		expect(installCandidates("/home/u", { XDG_DATA_HOME: "data" })[0]).toBe("/home/u/.local/share/agent-sessions");
	});

	it("doesn't list the default twice when $XDG_DATA_HOME is set to it", () => {
		expect(installCandidates("/home/u", { XDG_DATA_HOME: "/home/u/.local/share" })).toEqual([
			"/home/u/.local/share/agent-sessions",
			"/home/u/.agents/sessions/app",
		]);
	});
});

describe("unsuitableReason / chooseInstallDir", () => {
	const writable = () => true;

	it("rejects paths a shell would split or expand", () => {
		for (const dir of ["/Users/Jane Doe/.local/share/agent-sessions", '/a"b', "/a$b", "/a`b", "/a\\b", "/a*b", "rel/dir"]) {
			expect(unsuitableReason(dir, "/vault", writable)).toBe("characters");
		}
		expect(unsuitableReason("/home/u/.local/share/agent-sessions", "/vault", writable)).toBeNull();
	});

	it("rejects the vault and anything inside it", () => {
		expect(unsuitableReason("/vault", "/vault", writable)).toBe("in-vault");
		expect(unsuitableReason("/vault/.local/agent-sessions", "/vault", writable)).toBe("in-vault");
		expect(unsuitableReason("/vault-other/agent-sessions", "/vault", writable)).toBeNull();
	});

	it("rejects a location that can't be written", () => {
		expect(unsuitableReason("/home/u/x", "/vault", () => false)).toBe("not-writable");
	});

	it("takes the first usable candidate and reports the ones it passed over", () => {
		const choice = chooseInstallDir(["/Users/Jane Doe/x", "/ro/x", "/ok/x"], "/vault", (dir) => dir !== "/ro/x");
		expect(choice.dir).toBe("/ok/x");
		expect(choice.rejected).toEqual([
			{ dir: "/Users/Jane Doe/x", reason: "characters" },
			{ dir: "/ro/x", reason: "not-writable" },
		]);
	});

	it("returns no directory when none is usable", () => {
		expect(chooseInstallDir(["/a b"], "/vault", writable).dir).toBeNull();
	});
});

describe("files on disk", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const FILES = {
		"bin/agent-sessions": "#!/usr/bin/env python3\nimport sys\n",
		"bin/agent-sessions-code": "#!/bin/sh\nexec true\n",
		"agentsessions/__init__.py": "VERSION = 1\n",
		"agentsessions/cli/__init__.py": "def main(argv): return 0\n",
	};

	it("isWritableDir judges a missing directory by its nearest existing parent, creating nothing", () => {
		const dir = path.join(tmp, "a", "b", "c");
		expect(isWritableDir(dir)).toBe(true);
		expect(fs.existsSync(path.join(tmp, "a"))).toBe(false);
		fs.writeFileSync(path.join(tmp, "file"), "");
		expect(isWritableDir(path.join(tmp, "file", "x"))).toBe(false);
	});

	it("writeBundle lays the files out, sets the launcher's shebang, and records the install", () => {
		const dir = path.join(tmp, "install");
		const info = writeBundle(dir, FILES, "0.3.0+abc", "/opt/homebrew/bin/python3");
		expect(info).toEqual({ dir, version: "0.3.0+abc", python: "/opt/homebrew/bin/python3" });
		expect(fs.readFileSync(launcherPath(dir), "utf8")).toBe("#!/opt/homebrew/bin/python3\nimport sys\n");
		expect(fs.statSync(launcherPath(dir)).mode & 0o111).not.toBe(0);
		expect(fs.statSync(path.join(dir, "bin", "agent-sessions-code")).mode & 0o111).not.toBe(0);
		expect(fs.readFileSync(path.join(dir, "agentsessions", "cli", "__init__.py"), "utf8")).toContain("def main");
		expect(readInstallInfo(dir)).toEqual(info);
		expect(fs.readdirSync(dir).filter((n) => n.startsWith(".staging-"))).toEqual([]);
	});

	it("writeBundle replaces an older version wholesale (a module dropped upstream doesn't linger)", () => {
		const dir = path.join(tmp, "install");
		writeBundle(dir, { ...FILES, "agentsessions/old.py": "gone = True\n" }, "1", "/usr/bin/python3");
		writeBundle(dir, FILES, "2", "/usr/bin/python3");
		expect(fs.existsSync(path.join(dir, "agentsessions", "old.py"))).toBe(false);
		expect(readInstallInfo(dir)?.version).toBe("2");
	});

	it("findInstalled returns the first candidate with a complete install", () => {
		const a = path.join(tmp, "a");
		const b = path.join(tmp, "b");
		fs.mkdirSync(a);
		fs.writeFileSync(path.join(a, "install.json"), '{"version":"1","python":"/p"}');
		// No launcher next to it: incomplete, so skipped.
		writeBundle(b, FILES, "2", "/usr/bin/python3");
		expect(findInstalled([a, b])?.dir).toBe(b);
		expect(findInstalled([path.join(tmp, "none")])).toBeNull();
	});

	it("removeBundle removes its own files and the directory once empty, nothing else", () => {
		const dir = path.join(tmp, "install");
		writeBundle(dir, FILES, "1", "/usr/bin/python3");
		removeBundle(dir);
		expect(fs.existsSync(dir)).toBe(false);

		writeBundle(dir, FILES, "1", "/usr/bin/python3");
		fs.writeFileSync(path.join(dir, "user-notes.txt"), "keep");
		removeBundle(dir);
		expect(fs.readdirSync(dir)).toEqual(["user-notes.txt"]);
	});
});

describe("launcherSource / hookLauncher", () => {
	it("replaces the shebang, or adds one if missing", () => {
		expect(launcherSource("#!/usr/bin/env python3\nx\n", "/py")).toBe("#!/py\nx\n");
		expect(launcherSource("x\n", "/py")).toBe("#!/py\nx\n");
	});

	it("names a launcher under the home directory through $HOME", () => {
		expect(hookLauncher("/home/u/.local/share/agent-sessions", "/home/u")).toBe(
			"$HOME/.local/share/agent-sessions/bin/agent-sessions"
		);
		expect(hookLauncher("/opt/agent-sessions", "/home/u")).toBe("/opt/agent-sessions/bin/agent-sessions");
	});
});

describe("Python", () => {
	it("parsePythonVersion / isRecentEnough", () => {
		expect(parsePythonVersion("3.12\n")).toEqual([3, 12]);
		expect(parsePythonVersion("Python 3.12")).toBeNull();
		expect(isRecentEnough([3, 9])).toBe(true);
		expect(isRecentEnough([3, 8])).toBe(false);
		expect(isRecentEnough([4, 0])).toBe(true);
	});

	function probe(opts: {
		located?: string | null;
		exists: string[];
		versions: Record<string, string>;
		xcode?: boolean;
	}): PythonProbe & { ran: string[] } {
		const ran: string[] = [];
		return {
			ran,
			locate: () => Promise.resolve(opts.located ?? null),
			exists: (p) => opts.exists.includes(p),
			run: (bin) => {
				ran.push(bin);
				if (bin === "/usr/bin/xcode-select") {
					return opts.xcode ? Promise.resolve("/Library/Developer/CommandLineTools\n") : Promise.reject(new Error("no"));
				}
				const v = opts.versions[bin];
				return v ? Promise.resolve(`${v}\n`) : Promise.reject(new Error("fail"));
			},
		};
	}

	it("prefers the shell's python3 when it's recent enough", async () => {
		const p = probe({ located: "/home/u/.pyenv/shims/python3", exists: ["/home/u/.pyenv/shims/python3", "/usr/bin/python3"], versions: { "/home/u/.pyenv/shims/python3": "3.12", "/usr/bin/python3": "3.10" } });
		expect(await findPython(false, p)).toEqual({ path: "/home/u/.pyenv/shims/python3", version: "3.12" });
	});

	it("skips a Python older than 3.9 and falls back to the usual locations", async () => {
		const p = probe({ located: "/usr/bin/python3", exists: ["/usr/bin/python3", "/usr/local/bin/python3"], versions: { "/usr/bin/python3": "3.8", "/usr/local/bin/python3": "3.11" } });
		expect(await findPython(false, p)).toEqual({ path: "/usr/local/bin/python3", version: "3.11" });
	});

	it("on macOS, never runs the /usr/bin/python3 stub until the Command Line Tools are installed", async () => {
		const without = probe({ exists: ["/usr/bin/python3"], versions: { "/usr/bin/python3": "3.9" }, xcode: false });
		expect(await findPython(true, without)).toBeNull();
		expect(without.ran).not.toContain("/usr/bin/python3");

		const withTools = probe({ exists: ["/usr/bin/python3"], versions: { "/usr/bin/python3": "3.9" }, xcode: true });
		expect(await findPython(true, withTools)).toEqual({ path: "/usr/bin/python3", version: "3.9" });
	});

	it("returns null when nothing usable is found", async () => {
		expect(await findPython(false, probe({ exists: [], versions: {} }))).toBeNull();
	});
});

describe("Windows install locations", () => {
	it("prefers %LOCALAPPDATA%\\agent-sessions", () => {
		expect(installCandidates("C:\\Users\\a", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toEqual([
			"C:\\Users\\a\\AppData\\Local\\agent-sessions",
			"C:\\Users\\a\\.agents\\sessions\\app",
		]);
	});
	it("accepts spaces but not shell metacharacters, and never the vault", () => {
		const ok = () => true;
		expect(unsuitableReason("C:\\Users\\John Smith\\AppData\\Local\\agent-sessions", "D:\\Vault", ok, "win32")).toBeNull();
		expect(unsuitableReason("C:\\Users\\a&b\\agent-sessions", "D:\\Vault", ok, "win32")).toBe("characters");
		expect(unsuitableReason("C:\\Users\\a%x%\\agent-sessions", "D:\\Vault", ok, "win32")).toBe("characters");
		expect(unsuitableReason("D:\\Vault\\app", "D:\\Vault", ok, "win32")).toBe("in-vault");
	});
});
