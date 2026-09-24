import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeRow, SessionIndex, type Row, type SessionIndexDeps } from "../src/index";
import { loadStore, updateStore } from "../src/store";
import type { Detail, LiveResult, ScanResult, ScanSession } from "../src/types";

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
