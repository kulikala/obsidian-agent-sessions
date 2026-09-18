// 走査結果＋起動中＋タブの合成、購読（D-2・D-8・D-11・D-17）。
// `obsidian` には依存しない。呼び出しは `backend.ts` の関数を注入して受け取る
// （vitest でモックできるように）。

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { Registry } from "./registry";
import { StatusLine } from "./statusline";
import { loadStore, type Store } from "./store";
import type { Detail, LiveResult, ScanResult, ScanSession } from "./types";

/** 走査結果（Python）に、起動中の台帳とタブの状態を合成した 1 行。 */
export interface Row extends ScanSession {
	status: string | null;
	pid: number | null;
	rc: boolean;
	daemon: boolean;
	exited: number | null;
	hasTab: boolean;
	archived: boolean;
}

export interface SessionIndexDeps {
	scan: (only?: string[]) => Promise<ScanResult>;
	live: () => Promise<LiveResult>;
	detail: (id: string) => Promise<Detail>;
	storePath: string;
	eventsLogPath: string;
	sessionsDir: string;
	statusDir: string;
}

const RESCAN_INTERVAL_MS = 60000;
/** `registry` の変化から `refreshLive()` までのデバウンス（§6.1・§6.3）。 */
const LIVE_DEBOUNCE_MS = 1000;

function rowFromScan(s: ScanSession, openTabIds: Set<string>, store: Store): Row {
	const archivedEntry = store.archived.find((a) => a.id === s.id);
	return {
		...s,
		status: null,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: openTabIds.has(s.id),
		archived: !!archivedEntry,
	};
}

/**
 * 走査結果（`json scan`）・起動中（`json live`）・タブの状態を 1 つの
 * `Map<id, Row>` に合成する。3 つのビューがこれを 1 つ共有して購読する（§6.2）。
 */
export class SessionIndex extends EventEmitter {
	readonly sessions = new Map<string, Row>();
	readonly registry: Registry;
	readonly statusline: StatusLine;

	private openTabIds = new Set<string>();
	private detailCache = new Map<string, Detail>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private visibleCount = 0;
	private eventsOffset = 0;
	private eventsWatcher: fs.FSWatcher | null = null;
	private eventsDebounce: ReturnType<typeof setTimeout> | null = null;
	private registryUnsubscribe: () => void;
	private registryIdleUnsubscribe: () => void;
	private liveDebounce: ReturnType<typeof setTimeout> | null = null;

	constructor(private deps: SessionIndexDeps) {
		super();
		this.registry = new Registry(deps.sessionsDir);
		this.statusline = new StatusLine(deps.statusDir);
		this.registryUnsubscribe = this.registry.onChange(() => {
			this.applyRegistry();
			this.scheduleLiveRefresh();
			this.emit("change");
		});
		// busy→idle（/compact・/rename の送信が終わった直後を含む）で detail のキャッシュを
		// 捨てる。次の getDetail が新しい last_command・last_user 等を読み直す。
		this.registryIdleUnsubscribe = this.registry.onIdle((id) => this.invalidateDetail(id));
		this.eventsOffset = this.currentEventsLogSize();
	}

	onChange(cb: () => void): () => void {
		this.on("change", cb);
		return () => this.off("change", cb);
	}

	/** `json scan` が失敗したときに通知する（前回の結果は保たれる）。 */
	onError(cb: (message: string) => void): () => void {
		this.on("scanError", cb);
		return () => this.off("scanError", cb);
	}

	/** ビューが見えている間だけ 60 秒毎に再走査する。停止用の関数を返す。 */
	addVisible(): () => void {
		this.visibleCount++;
		this.ensureTimer();
		return () => {
			this.visibleCount = Math.max(0, this.visibleCount - 1);
			this.ensureTimer();
		};
	}

	setOpenTabs(ids: string[]): void {
		this.openTabIds = new Set(ids);
		for (const row of this.sessions.values()) {
			row.hasTab = this.openTabIds.has(row.id);
		}
		this.emit("change");
	}

	/**
	 * `sessions.json` を読み直し、`archived` だけを再適用する。
	 * 走査をやり直さなくても、アーカイブ・折畳をすぐ画面に反映できる。
	 */
	refreshStore(): void {
		const store = loadStore(this.deps.storePath);
		for (const row of this.sessions.values()) {
			row.archived = store.archived.some((a) => a.id === row.id);
		}
		this.emit("change");
	}

	async getDetail(id: string): Promise<Detail> {
		const cached = this.detailCache.get(id);
		if (cached) {
			return cached;
		}
		const detail = await this.deps.detail(id);
		this.detailCache.set(id, detail);
		return detail;
	}

	/** `getDetail` が既に取得済みならそれを同期で返す。無ければ `null`（ここでは取得しない）。 */
	getCachedDetail(id: string): Detail | null {
		return this.detailCache.get(id) ?? null;
	}

	/** `id` の detail キャッシュを捨てる。次の `getDetail`/`getCachedDetail` は読み直す。 */
	invalidateDetail(id: string): void {
		this.detailCache.delete(id);
	}

	/** 全走査（`rescan()` と同じ）。 */
	async scan(): Promise<void> {
		return this.rescan();
	}

	/** `only` が有れば該当 ID だけ再走査してキャッシュを更新する（`json scan --only`）。 */
	async rescan(only?: string[]): Promise<void> {
		let result: ScanResult;
		try {
			result = await this.deps.scan(only);
		} catch (err) {
			this.emit("scanError", messageOf(err));
			return;
		}
		this.applyScanResult(result, only);
		this.applyRegistry();
		await this.refreshLive();
		this.emit("change");
	}

	/**
	 * `json live` の `daemon.sessions` から行ごとの `daemon`／`exited` を導く（§6.1・§6.3）。
	 * 失敗（デーモン未起動など）は静かに無視し、`daemon:false` として扱う——`json scan` の
	 * 失敗と違って `Notice` は出さない。呼出：`start()` の初回走査の後・`registry` の変化
	 * のたび（1 秒デバウンス）・60 秒タイマー・`rescan()` の後。
	 */
	async refreshLive(): Promise<void> {
		let result: LiveResult;
		try {
			result = await this.deps.live();
		} catch {
			result = { live: {}, daemon: { running: false, sessions: [] } };
		}
		if (this.applyLive(result)) {
			this.emit("change");
		}
	}

	/** `events.log` の追記を検知したら呼ぶ（手動でも、`fs.watch` からでも）。 */
	checkEventsLog(): void {
		let text: string;
		try {
			const fd = fs.openSync(this.deps.eventsLogPath, "r");
			try {
				const stat = fs.fstatSync(fd);
				if (stat.size <= this.eventsOffset) {
					this.eventsOffset = Math.min(this.eventsOffset, stat.size);
					return;
				}
				const length = stat.size - this.eventsOffset;
				const buf = Buffer.alloc(length);
				fs.readSync(fd, buf, 0, length, this.eventsOffset);
				this.eventsOffset = stat.size;
				text = buf.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return;
		}
		const ids = new Set<string>();
		for (const line of text.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			try {
				const event = JSON.parse(line) as { session_id?: string };
				if (event.session_id) {
					ids.add(event.session_id);
				}
			} catch {
				// 壊れた行は無視。
			}
		}
		if (ids.size > 0) {
			void this.rescan([...ids]);
		}
	}

	/**
	 * `registry.watch()` と `events.log` の監視を始め、最初の 1 回を走査する。
	 * 停止用の関数を返す。
	 */
	start(): () => void {
		void this.rescan();
		const stopRegistry = this.registry.watch();
		if (!this.eventsWatcher) {
			try {
				this.eventsWatcher = fs.watch(this.deps.eventsLogPath, () => this.scheduleEventsCheck());
			} catch {
				this.eventsWatcher = null;
			}
		}
		return () => {
			stopRegistry();
			this.eventsWatcher?.close();
			this.eventsWatcher = null;
			if (this.eventsDebounce) {
				clearTimeout(this.eventsDebounce);
				this.eventsDebounce = null;
			}
		};
	}

	dispose(): void {
		this.registryUnsubscribe();
		this.registryIdleUnsubscribe();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.liveDebounce) {
			clearTimeout(this.liveDebounce);
			this.liveDebounce = null;
		}
	}

	private scheduleEventsCheck(): void {
		if (this.eventsDebounce) {
			clearTimeout(this.eventsDebounce);
		}
		this.eventsDebounce = setTimeout(() => {
			this.eventsDebounce = null;
			this.checkEventsLog();
		}, 200);
	}

	private scheduleLiveRefresh(): void {
		if (this.liveDebounce) {
			clearTimeout(this.liveDebounce);
		}
		this.liveDebounce = setTimeout(() => {
			this.liveDebounce = null;
			void this.refreshLive();
		}, LIVE_DEBOUNCE_MS);
	}

	private currentEventsLogSize(): number {
		try {
			return fs.statSync(this.deps.eventsLogPath).size;
		} catch {
			return 0;
		}
	}

	private ensureTimer(): void {
		const shouldRun = this.visibleCount > 0;
		if (shouldRun && !this.timer) {
			this.timer = setInterval(() => {
				void this.rescan();
			}, RESCAN_INTERVAL_MS);
		} else if (!shouldRun && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private applyScanResult(result: ScanResult, only: string[] | undefined): void {
		const store = loadStore(this.deps.storePath);
		if (only && only.length > 0) {
			for (const s of result.sessions) {
				this.sessions.set(s.id, this.mergeRow(rowFromScan(s, this.openTabIds, store), this.sessions.get(s.id)));
			}
		} else {
			const next = new Map<string, Row>();
			for (const s of result.sessions) {
				next.set(s.id, this.mergeRow(rowFromScan(s, this.openTabIds, store), this.sessions.get(s.id)));
			}
			this.sessions.clear();
			for (const [id, row] of next) {
				this.sessions.set(id, row);
			}
		}
	}

	/** 走査で作った Row に、既存 Row が持っていた起動中情報を引き継ぐ。 */
	private mergeRow(fresh: Row, previous: Row | undefined): Row {
		if (!previous) {
			return fresh;
		}
		return {
			...fresh,
			status: previous.status,
			pid: previous.pid,
			rc: previous.rc,
			daemon: previous.daemon,
			exited: previous.exited,
		};
	}

	/** 行を書き換え、1 件でも `daemon`／`exited` が変わったら真を返す。 */
	private applyLive(result: LiveResult): boolean {
		const running = result.daemon.running;
		const byId = new Map(result.daemon.sessions.map((s) => [s.id, s]));
		let changed = false;
		for (const row of this.sessions.values()) {
			const d = running ? byId.get(row.id) : undefined;
			const daemon = !!d;
			const exited = d ? d.exited : null;
			if (row.daemon !== daemon || row.exited !== exited) {
				changed = true;
			}
			row.daemon = daemon;
			row.exited = exited;
		}
		return changed;
	}

	private applyRegistry(): void {
		for (const row of this.sessions.values()) {
			const entry = this.registry.get(row.id);
			row.status = entry?.status ?? null;
			row.pid = entry?.pid ?? null;
			row.rc = entry?.rc ?? false;
		}
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
