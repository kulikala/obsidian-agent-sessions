import { describe, expect, it } from "vitest";
import {
	buildRcServerArgv,
	descendantsOf,
	findRcServer,
	parseProcessLinks,
	plainOutput,
	RC_SERVER_ID,
	rcServerClick,
	rcServerSignal,
	rcServerState,
	rcSessionsAtWork,
	rejectsAutoMode,
	type RcServerFacts,
} from "../../src/sessions/rc-server";
import type { DaemonSession } from "../../src/types";

function server(over: Partial<DaemonSession> = {}): DaemonSession {
	return { id: RC_SERVER_ID, agent: "claude", cwd: "/v", pid: 100, startedAt: 1, clients: 0, exited: null, exitedAt: null, ...over };
}

function facts(over: Partial<RcServerFacts> = {}): RcServerFacts {
	return { enabled: true, daemon: server(), launching: false, signal: null, ...over };
}

describe("rcServerState", () => {
	it("is off whenever the toggle is off, whatever runs", () => {
		expect(rcServerState(facts({ enabled: false }))).toBe("off");
		expect(rcServerState(facts({ enabled: false, daemon: null }))).toBe("off");
		expect(rcServerState(facts({ enabled: false, signal: "ready" }))).toBe("off");
	});

	it("is starting while the server runs without its link yet, or asks a question", () => {
		expect(rcServerState(facts())).toBe("starting");
		expect(rcServerState(facts({ signal: "question" }))).toBe("starting");
	});

	it("is starting while a start is under way and the daemon doesn't list it yet", () => {
		expect(rcServerState(facts({ daemon: null, launching: true }))).toBe("starting");
	});

	it("is listening once the server shows its link", () => {
		expect(rcServerState(facts({ signal: "ready" }))).toBe("listening");
	});

	it("is down when on but no server runs: none in the daemon, or an ended one", () => {
		expect(rcServerState(facts({ daemon: null }))).toBe("down");
		expect(rcServerState(facts({ daemon: server({ exited: 1, exitedAt: 5 }) }))).toBe("down");
		expect(rcServerState(facts({ daemon: server({ exited: 0, exitedAt: 5 }), signal: "ready" }))).toBe("down");
	});
});

describe("rcServerClick", () => {
	it("starts from off, wakes from down, and stops otherwise", () => {
		expect(rcServerClick("off")).toBe("start");
		expect(rcServerClick("down")).toBe("wake");
		expect(rcServerClick("starting")).toBe("stop");
		expect(rcServerClick("listening")).toBe("stop");
	});
});

describe("findRcServer", () => {
	it("finds the server by its daemon id only", () => {
		const other = server({ id: "a1b2" });
		expect(findRcServer([other])).toBeNull();
		expect(findRcServer([other, server()])?.id).toBe(RC_SERVER_ID);
	});
});

describe("buildRcServerArgv", () => {
	it("runs the server for the same folder, in auto mode when asked", () => {
		expect(buildRcServerArgv("/bin/claude", true)).toEqual([
			"/bin/claude",
			"remote-control",
			"--spawn=same-dir",
			"--permission-mode",
			"auto",
		]);
		expect(buildRcServerArgv("/bin/claude", false)).toEqual(["/bin/claude", "remote-control", "--spawn=same-dir"]);
	});

	it("never resumes a single session (`--continue`, `--session-id`)", () => {
		const argv = buildRcServerArgv("claude", true);
		expect(argv).not.toContain("--continue");
		expect(argv).not.toContain("-c");
		expect(argv).not.toContain("--session-id");
	});
});

describe("rcServerSignal", () => {
	it("reads the first-use questions", () => {
		expect(rcServerSignal("Take this session with you.\nEnable Remote Control? (y/n) ")).toBe("question");
		expect(rcServerSignal("Trust this folder? [y/N] ")).toBe("question");
	});

	it("reads the connection link", () => {
		expect(rcServerSignal("Remote Control  https://claude.ai/code?environment=env_01abc\nspace for QR code")).toBe("ready");
	});

	it("goes by whichever came last", () => {
		expect(rcServerSignal("Enable Remote Control? (y/n) y\n…/code?environment=env_1")).toBe("ready");
		expect(rcServerSignal("/code?environment=env_1\nTrust this folder? [y/N]")).toBe("question");
	});

	it("is null before either", () => {
		expect(rcServerSignal("")).toBeNull();
		expect(rcServerSignal("Connecting…")).toBeNull();
	});

	it("reads output with its escape sequences removed", () => {
		const raw = "\x1b[2J\x1b[1;1H\x1b[1mEnable Remote Control?\x1b[0m (y/n) \r\n\x1b]0;claude\x07";
		expect(plainOutput(raw)).toBe("Enable Remote Control? (y/n) \n");
		expect(rcServerSignal(plainOutput(raw))).toBe("question");
	});
});

describe("rejectsAutoMode", () => {
	it("recognises a refused auto mode", () => {
		expect(rejectsAutoMode("error: option '--permission-mode <mode>' argument 'auto' is invalid.")).toBe(true);
		expect(rejectsAutoMode("Permission mode auto is not available for this account")).toBe(true);
	});

	it("ignores other failures and output that only mentions auto mode", () => {
		expect(rejectsAutoMode("Workspace not trusted.")).toBe(false);
		expect(rejectsAutoMode("Permission mode: auto")).toBe(false);
		expect(rejectsAutoMode("")).toBe(false);
	});
});

describe("process tree", () => {
	const ps = "  1     0\n100     1\n101   100\n102   101\n200     1\n  junk\n";

	it("parses ps output", () => {
		expect(parseProcessLinks(ps)).toEqual([
			{ pid: 1, ppid: 0 },
			{ pid: 100, ppid: 1 },
			{ pid: 101, ppid: 100 },
			{ pid: 102, ppid: 101 },
			{ pid: 200, ppid: 1 },
		]);
	});

	it("finds every process below the server", () => {
		expect([...descendantsOf(100, parseProcessLinks(ps))].sort()).toEqual([101, 102]);
	});

	it("counts the server's working sessions only", () => {
		const links = parseProcessLinks(ps);
		const entries = [
			{ pid: 101, status: "busy" },
			{ pid: 102, status: "waiting" },
			{ pid: 102, status: "idle" },
			{ pid: 200, status: "busy" },
		];
		expect(rcSessionsAtWork(100, links, entries)).toBe(2);
		expect(rcSessionsAtWork(100, links, [{ pid: 101, status: "idle" }])).toBe(0);
	});
});
