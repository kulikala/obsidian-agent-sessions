import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndex, type SessionIndexDeps } from "../src/index";
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

	it("scan で見つかったカテゴリに色番号を割り当て sessions.json へ書き戻す（T-70）", async () => {
		scanImpl = async () => ({
			sessions: [scanSession({ id: "a", name: "RIM: 会議" }), scanSession({ id: "b", name: "ZERO: 提案" })],
			store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
		});
		const index = new SessionIndex(deps);
		await index.scan();

		const rimColor = index.categoryColorIndex("RIM");
		const zeroColor = index.categoryColorIndex("ZERO");
		expect(rimColor).not.toBe(zeroColor);
		expect(loadStore(deps.storePath).categoryColors).toEqual({ RIM: rimColor, ZERO: zeroColor });

		// もう一度走査しても割当は変わらない（一度決めたら不変）。
		await index.scan();
		expect(index.categoryColorIndex("RIM")).toBe(rimColor);
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

	it("scan のたびに live も反映し、daemon.sessions に含まれる id は daemon: true になる（§6.1・§6.3）", async () => {
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

	it("live が失敗しても静かに無視する（scanError は出さず daemon: false のまま）", async () => {
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
			throw new Error("daemon 未起動");
		};
		await index.refreshLive();

		expect(errors).toEqual([]);
		expect(index.sessions.get("a")?.daemon).toBe(false);
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

	it("getDetail はキャッシュする", async () => {
		const index = new SessionIndex(deps);
		await index.getDetail("a");
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a"]);
	});

	it("invalidateDetail はキャッシュを消し、次の getDetail が呼び直す", async () => {
		const index = new SessionIndex(deps);
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a"]);

		index.invalidateDetail("a");
		await index.getDetail("a");
		expect(detailCalls).toEqual(["a", "a"]);
	});

	it("registry の busy→idle で detail キャッシュを自動で捨てる（/compact・/rename の後を想定）", async () => {
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

	describe("waitForName（T-72：/rename は busy にならず events.log にも来ないので明示的に待つ）", () => {
		it("既に一致していれば rescan を呼ばずに true", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a", name: "新しい名前" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			let scanCalls = 0;
			scanImpl = async () => {
				scanCalls++;
				return {
					sessions: [scanSession({ id: "a", name: "新しい名前" })],
					store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
				};
			};

			expect(await index.waitForName("a", "新しい名前", 200, 5)).toBe(true);
			expect(scanCalls).toBe(0);
		});

		it("数回の再走査の後に一致すれば true（rescan のたび change も発火する）", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a", name: "旧名" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			let scanCalls = 0;
			let changes = 0;
			index.onChange(() => changes++);
			scanImpl = async (only) => {
				scanCalls++;
				const name = scanCalls >= 3 ? "新しい名前" : "旧名";
				return {
					sessions: [scanSession({ id: "a", name })],
					store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
				};
			};

			expect(await index.waitForName("a", "新しい名前", 500, 5)).toBe(true);
			expect(scanCalls).toBeGreaterThanOrEqual(3);
			expect(changes).toBeGreaterThanOrEqual(3);
			expect(index.sessions.get("a")?.name).toBe("新しい名前");
		});

		it("timeoutMs に達しても一致しなければ false で諦める", async () => {
			scanImpl = async () => ({
				sessions: [scanSession({ id: "a", name: "旧名" })],
				store: { folded: [], archived: [], pendingRenames: {}, sessions: {} },
			});
			const index = new SessionIndex(deps);
			await index.scan();

			expect(await index.waitForName("a", "新しい名前", 20, 5)).toBe(false);
			expect(index.sessions.get("a")?.name).toBe("旧名");
		});
	});
});
