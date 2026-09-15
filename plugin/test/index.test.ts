import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndex, type SessionIndexDeps } from "../src/index";
import { updateStore } from "../src/store";
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
				return { last_user: "hi", last_assistant: null, tools: [] };
			},
			storePath: join(dir, "sessions.json"),
			eventsLogPath: join(dir, "events.log"),
			sessionsDir: join(dir, "sessions"),
			statusDir: join(dir, "status"),
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("scan で sessions map が埋まる", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: "RIM: 会議" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		const row = index.sessions.get("a");
		expect(row?.name).toBe("RIM: 会議");
		expect(row?.hasTab).toBe(false);
		expect(row?.archived).toBe(false);
		expect(row?.daemon).toBe(false);
	});

	it("scan が失敗したら前回の結果を保ち onError で通知する", async () => {
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

	it("refreshLive が daemon/exited を反映する（running:false なら全部消える）", async () => {
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

	it("setOpenTabs が hasTab を更新する", async () => {
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

	it("store.archived を見て archived を立てる", async () => {
		updateStore(deps.storePath, (s) => {
			s.archived.push({ id: "a", name: "旧名", agent: "claude" });
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

	it("走査結果の名前が pendingRename と一致したら onPendingRenameConfirmed で通知する（§6.6）", async () => {
		updateStore(deps.storePath, (s) => {
			s.pendingRenames["a"] = "太郎";
		});
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: null })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();
		expect(index.sessions.get("a")?.pendingRename).toBe("太郎");

		const confirmed: string[][] = [];
		index.onPendingRenameConfirmed((ids) => confirmed.push(ids));

		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: "違う名前" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		await index.scan();
		expect(confirmed).toEqual([]);

		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: "太郎" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		await index.scan();
		expect(confirmed).toEqual([["a"]]);
	});

	it("getDetail はキャッシュする", async () => {
		const index = new SessionIndex(deps);
		await index.getDetail("a");
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a"]);
	});
});
