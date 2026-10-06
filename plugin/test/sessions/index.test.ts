import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeRow, SessionIndex, type Row, type SessionIndexDeps } from "../../src/sessions/index";
import { loadStore, updateStore } from "../../src/sessions/store";
import type { Detail, LiveResult, ScanResult, ScanSession } from "../../src/types";

function scanSession(overrides: Partial<ScanSession> & Pick<ScanSession, "id">): ScanSession {
	return {
		agent: "claude",
		name: null,
		group: null,
		label: null,
		cwd: "/v",
		folder: "v",
		last_activity: 0,
		child: false,
		transcript: null,
		...overrides,
	};
}

function emptyLive(): LiveResult {
	return { live: {}, daemon: { running: false, sessions: [] } };
}

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
	return {
		agent: "claude",
		name: null,
		group: null,
		label: null,
		cwd: "/v",
		folder: "v",
		last_activity: 0,
		child: false,
		transcript: null,
		status: null,
		waitingFor: null,
		compacted: false,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

describe("mergeRow (carries the previous Row's in-flight info onto a freshly scanned Row)", () => {
	it("keeps the scan result as-is when there's no previous Row", () => {
		const fresh = row({ id: "a", waitingFor: null, compacted: false });
		expect(mergeRow(fresh, undefined)).toBe(fresh);
	});

	it("carries status/pid/rc/daemon/exited over from the previous Row", () => {
		const fresh = row({ id: "a" });
		const previous = row({ id: "a", status: "busy", pid: 123, rc: true, daemon: true, exited: 1700000000 });
		const merged = mergeRow(fresh, previous);
		expect(merged.status).toBe("busy");
		expect(merged.pid).toBe(123);
		expect(merged.rc).toBe(true);
		expect(merged.daemon).toBe(true);
		expect(merged.exited).toBe(1700000000);
	});

	it(
		"also carries waitingFor/compacted over from the previous Row — so the asking/compacted " +
			"marks don't briefly disappear before applyRegistry/applyCompacted reapply them",
		() => {
			const fresh = row({ id: "a", waitingFor: null, compacted: false });
			const previous = row({ id: "a", waitingFor: "permission prompt", compacted: true });
			const merged = mergeRow(fresh, previous);
			expect(merged.waitingFor).toBe("permission prompt");
			expect(merged.compacted).toBe(true);
		}
	);

	it("doesn't let the previous Row overwrite scan-side values (name, folder, etc.)", () => {
		const fresh = row({ id: "a", name: "New name", folder: "new-folder" });
		const previous = row({ id: "a", name: "Old name", folder: "old-folder" });
		const merged = mergeRow(fresh, previous);
		expect(merged.name).toBe("New name");
		expect(merged.folder).toBe("new-folder");
	});
});

describe("SessionIndex", () => {
	let dir: string;
	let deps: SessionIndexDeps;
	let scanImpl: (only?: string[]) => Promise<ScanResult>;
	let liveImpl: () => Promise<LiveResult>;
	let detailCalls: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-index-"));
		detailCalls = [];
		scanImpl = async () => ({ sessions: [], store: { folded: [], archived: [], pendingRenames: {}, sessions: {} } });
		liveImpl = async () => emptyLive();
		deps = {
			scan: (only) => scanImpl(only),
			live: () => liveImpl(),
			detail: async (id): Promise<Detail> => {
				detailCalls.push(id);
				return { last_user: "hi", last_assistant: null, last_command: null, tools: [] };
			},
			storePath: join(dir, "sessions.json"),
			eventsLogPath: join(dir, "events.log"),
			sessionsDir: join(dir, "sessions"),
			statusDir: join(dir, "status"),
			compactedDir: join(dir, "compacted"),
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is not loaded until the first full scan finishes, even if it fails", async () => {
		scanImpl = async () => {
			throw new Error("boom");
		};
		const index = new SessionIndex(deps);
		expect(index.loaded).toBe(false);
		await index.rescan(["a"]);
		expect(index.loaded).toBe(false);
		await index.scan();
		expect(index.loaded).toBe(true);
	});

	it("fills the sessions map on scan", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: "RIM: Meeting" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		const row = index.sessions.get("a");
		expect(row?.name).toBe("RIM: Meeting");
		expect(row?.hasTab).toBe(false);
		expect(row?.archived).toBe(false);
		expect(row?.daemon).toBe(false);
	});

	it("assigns color indices to categories found by scan and writes them back to sessions.json", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: "RIM: Meeting" }), scanSession({ id: "b", name: "ZERO: Proposal" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		const rimColor = index.categoryColorIndex("RIM");
		const zeroColor = index.categoryColorIndex("ZERO");
		expect(rimColor).not.toBe(zeroColor);
		expect(loadStore(deps.storePath).categoryColors).toEqual({ RIM: rimColor, ZERO: zeroColor });

		// Scanning again doesn't change the assignment (fixed once decided).
		await index.scan();
		expect(index.categoryColorIndex("RIM")).toBe(rimColor);
	});

	it("keeps the previous result and notifies via onError when scan fails", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();
		expect(index.sessions.size).toBe(1);

		const errors: string[] = [];
		index.onError((message) => errors.push(message));
		scanImpl = async () => {
			throw new Error("boom");
		};
		await index.scan();

		expect(index.sessions.size).toBe(1);
		expect(errors).toEqual(["boom"]);
	});

	it("refreshLive reflects daemon/exited (running:false clears everything)", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		liveImpl = async () => ({
			live: {},
			daemon: { running: true, sessions: [{ id: "a", agent: "claude", cwd: "/v", pid: 1, startedAt: 0, clients: 1, exited: null, exitedAt: null }] },
		});
		await index.refreshLive();
		expect(index.sessions.get("a")?.daemon).toBe(true);

		liveImpl = async () => emptyLive();
		await index.refreshLive();
		expect(index.sessions.get("a")?.daemon).toBe(false);
		expect(index.sessions.get("a")?.exited).toBeNull();
	});

	it("hands the daemon's sessions to onDaemonSessions after a live refresh that reached the daemon", async () => {
		const index = new SessionIndex(deps);
		const seen: string[][] = [];
		const stop = index.onDaemonSessions((sessions) => seen.push(sessions.map((s) => s.id)));
		liveImpl = async () => ({
			live: {},
			daemon: { running: true, sessions: [{ id: "x", agent: "codex", cwd: "/v", pid: 1, startedAt: 0, clients: 0, exited: null, exitedAt: null }] },
		});
		await index.refreshLive();
		liveImpl = async () => emptyLive();
		await index.refreshLive();
		stop();
		liveImpl = async () => ({
			live: {},
			daemon: { running: true, sessions: [] },
		});
		await index.refreshLive();
		expect(seen).toEqual([["x"]]);
	});

	it("also reflects live on every scan; an id present in daemon.sessions gets daemon: true", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a" }), scanSession({ id: "b" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		liveImpl = async () => ({
			live: {},
			daemon: {
				running: true,
				sessions: [{ id: "a", agent: "claude", cwd: "/v", pid: 1, startedAt: 0, clients: 1, exited: null, exitedAt: null }],
			},
		});
		const index = new SessionIndex(deps);
		await index.scan();

		expect(index.sessions.get("a")?.daemon).toBe(true);
		expect(index.sessions.get("b")?.daemon).toBe(false);
	});

	it("silently ignores a failure in live (no scanError; stays daemon: false)", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		liveImpl = async () => ({
			live: {},
			daemon: {
				running: true,
				sessions: [{ id: "a", agent: "claude", cwd: "/v", pid: 1, startedAt: 0, clients: 1, exited: null, exitedAt: null }],
			},
		});
		const index = new SessionIndex(deps);
		await index.scan();
		expect(index.sessions.get("a")?.daemon).toBe(true);

		const errors: string[] = [];
		index.onError((message) => errors.push(message));
		liveImpl = async () => {
			throw new Error("daemon not running");
		};
		await index.refreshLive();

		expect(errors).toEqual([]);
		expect(index.sessions.get("a")?.daemon).toBe(false);
	});

	it("setOpenTabs updates hasTab", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a" }), scanSession({ id: "b" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		index.setOpenTabs(["b"]);
		expect(index.sessions.get("a")?.hasTab).toBe(false);
		expect(index.sessions.get("b")?.hasTab).toBe(true);
	});

	it("sets archived by checking store.archived", async () => {
		updateStore(deps.storePath, (s) => {
			s.archived.push({ id: "a", name: "Old name", agent: "claude" });
		});
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a" }), scanSession({ id: "b" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		expect(index.sessions.get("a")?.archived).toBe(true);
		expect(index.sessions.get("b")?.archived).toBe(false);
	});

	it("overlays an OpenCode session's name from sessions.json onto the scanned row (OpenCode has no /rename)", async () => {
		updateStore(deps.storePath, (s) => {
			s.sessions["ses_1"] = { agent: "opencode", cwd: "/v", name: "My name" };
			s.sessions["c1"] = { agent: "claude", cwd: "/v", name: "ignored for claude" };
		});
		scanImpl = async () => ({
			sessions: [
				scanSession({ id: "ses_1", agent: "opencode", name: "Generated title" }),
				scanSession({ id: "ses_2", agent: "opencode", name: "Other title" }),
				scanSession({ id: "c1", agent: "claude", name: "Claude's own" }),
			],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		expect(index.sessions.get("ses_1")?.name).toBe("My name");
		expect(index.sessions.get("ses_2")?.name).toBe("Other title");
		expect(index.sessions.get("c1")?.name).toBe("Claude's own");
	});

	it("shows a Codex session's creation name from sessions.json only until Codex's own title has a name", async () => {
		updateStore(deps.storePath, (s) => {
			s.sessions["t1"] = { agent: "codex", cwd: "/v", daemon: "p1", name: "Test: Codex named" };
			s.sessions["t2"] = { agent: "codex", cwd: "/v", daemon: "p2", name: "Given at creation" };
		});
		scanImpl = async () => ({
			sessions: [
				scanSession({ id: "t1", agent: "codex", name: null }),
				scanSession({ id: "t2", agent: "codex", name: "Renamed in Codex" }),
			],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		expect(index.sessions.get("t1")).toMatchObject({ name: "Test: Codex named", nameStored: true });
		expect(index.sessions.get("t2")?.name).toBe("Renamed in Codex");
		expect(index.sessions.get("t2")?.nameStored).toBeUndefined();
	});

	it("getDetail caches its result", async () => {
		const index = new SessionIndex(deps);
		await index.getDetail("a");
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a"]);
	});

	it("invalidateDetail clears the cache so the next getDetail re-fetches", async () => {
		const index = new SessionIndex(deps);
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a"]);

		index.invalidateDetail("a");
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a", "a"]);
	});

	it("automatically drops the detail cache on a registry busy->idle transition (e.g. after /compact or /rename)", async () => {
		mkdirSync(deps.sessionsDir, { recursive: true });
		const sessionFile = join(deps.sessionsDir, "a.json");
		writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, sessionId: "a", status: "busy" }), "utf8");

		const index = new SessionIndex(deps);
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a"]);

		writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, sessionId: "a", status: "idle" }), "utf8");
		index.registry.refresh();

		await index.getDetail("a");
		expect(detailCalls).toEqual(["a", "a"]);
	});

	it("gives an OpenCode row the status, waiting reason and pid from its status file", async () => {
		const opencodeDir = join(dir, "opencode");
		mkdirSync(opencodeDir, { recursive: true });
		writeFileSync(
			join(opencodeDir, "ses_x.json"),
			JSON.stringify({ status: "waiting", waiting_for: "permission", pid: process.pid, updated_at: 1 }),
			"utf8"
		);
		scanImpl = async () => ({
			sessions: [scanSession({ id: "ses_x", agent: "opencode" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex({ ...deps, opencodeDir });
		await index.scan();

		const row = index.sessions.get("ses_x");
		expect([row?.status, row?.waitingFor, row?.pid]).toEqual(["waiting", "permission", process.pid]);
	});

	it("reports a session /clear ended from events.log, and rescans every id it names", async () => {
		const log = join(dir, "events.log");
		const before = JSON.stringify({ event: "SessionEnd", session_id: "before", reason: "clear" }) + "\n";
		writeFileSync(log, before);
		const index = new SessionIndex(deps);
		const cleared: string[] = [];
		index.onCleared((id) => cleared.push(id));
		const rescanned: (string[] | undefined)[] = [];
		scanImpl = async (only) => {
			rescanned.push(only);
			return { sessions: [], store: { folded: [], archived: [], pendingRenames: {}, sessions: {} } };
		};
		const lines = [
			{ event: "SessionEnd", session_id: "old", reason: "clear" },
			{ event: "SessionStart", session_id: "new", source: "clear" },
			{ event: "SessionEnd", session_id: "quit", reason: "prompt_input_exit" },
			{ event: "Stop", session_id: "new" },
		];
		writeFileSync(log, before + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		index.checkEventsLog();
		expect(cleared).toEqual(["old"]);
		await Promise.resolve();
		expect(rescanned[0]?.sort()).toEqual(["new", "old", "quit"]);
	});

	describe("waitForName (explicitly polled because /rename never goes busy and never hits events.log)", () => {
		it("returns true without calling rescan when the name already matches", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a", name: "New name" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			let scanCalls = 0;
			scanImpl = async () => {
				scanCalls++;
				return {
					sessions: [scanSession({ id: "a", name: "New name" })],
					store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
				};
			};

			expect(await index.waitForName("a", "New name", 200, 5)).toBe(true);
			expect(scanCalls).toBe(0);
		});

		it("returns true once it matches after a few rescans (each rescan also fires change)", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a", name: "Old name" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			let scanCalls = 0;
			let changes = 0;
			index.onChange(() => changes++);
			scanImpl = async (only) => {
				scanCalls++;
				const name = scanCalls >= 3 ? "New name" : "Old name";
				return {
					sessions: [scanSession({ id: "a", name })],
					store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
				};
			};

			expect(await index.waitForName("a", "New name", 500, 5)).toBe(true);
			expect(scanCalls).toBeGreaterThanOrEqual(3);
			expect(changes).toBeGreaterThanOrEqual(3);
			expect(index.sessions.get("a")?.name).toBe("New name");
		});

		it("gives up with false once timeoutMs is reached without a match", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a", name: "Old name" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			expect(await index.waitForName("a", "New name", 20, 5)).toBe(false);
			expect(index.sessions.get("a")?.name).toBe("Old name");
		});
	});

	describe("compacted (merges the just-compacted, no-input-yet mark onto the row)", () => {
		it("row.compacted is true when compactedDir has an <id>.json", async () => {
			mkdirSync(deps.compactedDir, { recursive: true });
			writeFileSync(join(deps.compactedDir, "a.json"), JSON.stringify({ compactedAt: 1 }), "utf8");
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a" }), scanSession({ id: "b" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			expect(index.sessions.get("a")?.compacted).toBe(true);
			expect(index.sessions.get("b")?.compacted).toBe(false);
		});

		it("compacted defaults to false when there's no mark", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			expect(index.sessions.get("a")?.compacted).toBe(false);
		});

		it("a compactedTracker change fires change, and row.compacted goes back to false once the mark is gone", async () => {
			mkdirSync(deps.compactedDir, { recursive: true });
			writeFileSync(join(deps.compactedDir, "a.json"), JSON.stringify({ compactedAt: 1 }), "utf8");
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();
			expect(index.sessions.get("a")?.compacted).toBe(true);

			let changes = 0;
			index.onChange(() => changes++);
			rmSync(join(deps.compactedDir, "a.json"));
			index.compactedTracker.refresh();

			expect(changes).toBe(1);
			expect(index.sessions.get("a")?.compacted).toBe(false);
		});
	});
});
