// Combines scan results with running-daemon state and tab state, and lets views subscribe to
// changes. No dependency on `obsidian` — the calls into `backend.ts` are injected as functions
// (so they can be mocked in vitest).

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { assignCategoryColor, ensureCategoryColors } from "./category";
import { CompactedTracker } from "./compacted";
import { listCategories } from "./name";
import { Registry } from "./registry";
import { StatusLine } from "./statusline";
import { loadStore, updateStore, type Store } from "./store";
import type { Detail, LiveResult, ScanResult, ScanSession } from "./types";

/** One row: a scan result (from Python) combined with the running-daemon ledger and tab state. */
export interface Row extends ScanSession {
	status: string | null;
	/** The reason when `status === "waiting"` (claude's own "asking"). `null` otherwise. */
	waitingFor: string | null;
	/** Whether the session just compacted and hasn't had the next instruction sent yet (`CompactedTracker`). */
	compacted: boolean;
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
	/** Where the just-compacted marker files live. */
	compactedDir: string;
}

const RESCAN_INTERVAL_MS = 60000;
/** Debounce from a `registry` change to `refreshLive()`. */
const LIVE_DEBOUNCE_MS = 1000;
/** `waitForName`'s rescan interval and give-up timeout. */
const WAIT_NAME_POLL_MS = 300;
const WAIT_NAME_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowFromScan(s: ScanSession, openTabIds: Set<string>, store: Store): Row {
	const archivedEntry = store.archived.find((a) => a.id === s.id);
	return {
		...s,
		status: null,
		waitingFor: null,
		compacted: false,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: openTabIds.has(s.id),
		archived: !!archivedEntry,
	};
}

/**
 * Carries `status`, `waitingFor`, `pid`, `rc`, `daemon`, `exited`, and `compacted` over from the
 * existing Row (`previous`) onto a freshly scanned Row (`fresh`). The scan result (`json scan`)
 * doesn't know any of these (`rowFromScan` fills them all with defaults), and
 * `applyScanResult` is always immediately followed by `applyRegistry`/`applyCompacted` to
 * reapply the registry's and `CompactedTracker`'s current values anyway — but having `mergeRow`
 * itself carry them over too means there's no inconsistent state in between (the asking/compacted
 * markers never flicker off for a moment).
 */
export function mergeRow(fresh: Row, previous: Row | undefined): Row {
	if (!previous) {
		return fresh;
	}
	return {
		...fresh,
		status: previous.status,
		waitingFor: previous.waitingFor,
		pid: previous.pid,
		rc: previous.rc,
		daemon: previous.daemon,
		exited: previous.exited,
		compacted: previous.compacted,
	};
}

/**
 * Combines the scan result (`json scan`), running-daemon state (`json live`), and tab state
 * into one `Map<id, Row>`. All three views share and subscribe to this one instance.
 */
export class SessionIndex extends EventEmitter {
	readonly sessions = new Map<string, Row>();
	readonly registry: Registry;
	readonly statusline: StatusLine;
	/** Just-compacted markers. */
	readonly compactedTracker: CompactedTracker;

	private openTabIds = new Set<string>();
	/** Category name → palette slot (a copy of `sessions.json`'s `categoryColors`). */
	private categoryColors: Record<string, number> = {};
	private detailCache = new Map<string, Detail>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private visibleCount = 0;
	private eventsOffset = 0;
	private eventsWatcher: fs.FSWatcher | null = null;
	private eventsDebounce: ReturnType<typeof setTimeout> | null = null;
	private registryUnsubscribe: () => void;
	private registryIdleUnsubscribe: () => void;
	private compactedUnsubscribe: () => void;
	private liveDebounce: ReturnType<typeof setTimeout> | null = null;

	constructor(private deps: SessionIndexDeps) {
		super();
		this.registry = new Registry(deps.sessionsDir);
		this.statusline = new StatusLine(deps.statusDir);
		this.compactedTracker = new CompactedTracker(deps.compactedDir);
		this.registryUnsubscribe = this.registry.onChange(() => {
			this.applyRegistry();
			this.scheduleLiveRefresh();
			this.emit("change");
		});
		this.compactedUnsubscribe = this.compactedTracker.onChange(() => {
			this.applyCompacted();
			this.emit("change");
		});
		// Drop the detail cache on busy→idle (including right after sending /compact or
		// /rename) so the next getDetail re-reads the new last_command, last_user, etc.
		this.registryIdleUnsubscribe = this.registry.onIdle((id) => this.invalidateDetail(id));
		this.eventsOffset = this.currentEventsLogSize();
	}

	onChange(cb: () => void): () => void {
		this.on("change", cb);
		return () => this.off("change", cb);
	}

	/** Notified when `json scan` fails (the previous result is kept). */
	onError(cb: (message: string) => void): () => void {
		this.on("scanError", cb);
		return () => this.off("scanError", cb);
	}

	/** Rescans every 60 seconds, but only while a view is visible. Returns a function to stop. */
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

	/** Category suggestions for the naming dialog's "Category" field, derived from every session's name. */
	categories(): string[] {
		return listCategories([...this.sessions.values()].map((row) => row.name));
	}

	/**
	 * The display color (palette slot) for `category`. Returns the value already committed to
	 * `sessions.json` if there is one (it never changes). If not yet committed, computes a
	 * tentative slot on the spot without writing it back (used to preview the color while typing
	 * a category in the dialog, until `syncCategoryColors` commits one on the next scan).
	 */
	categoryColorIndex(category: string): number {
		const existing = this.categoryColors[category];
		if (existing !== undefined) {
			return existing;
		}
		return assignCategoryColor({ ...this.categoryColors }, category);
	}

	/**
	 * Re-reads `sessions.json` and reapplies `archived`/`categoryColors`. Lets archiving and
	 * folding show up on screen right away without needing a full rescan.
	 */
	refreshStore(): void {
		const store = loadStore(this.deps.storePath);
		for (const row of this.sessions.values()) {
			row.archived = store.archived.some((a) => a.id === row.id);
		}
		this.categoryColors = { ...store.categoryColors };
		this.emit("change");
	}

	/**
	 * Assigns and writes back a slot for any category in the current session list that
	 * `sessions.json`'s `categoryColors` doesn't have yet (`category.ts`'s
	 * `ensureCategoryColors`). Does nothing (doesn't take the lock) if there's nothing to
	 * assign. If the lock can't be acquired, the UI just falls back to `categoryColorIndex`'s
	 * tentative assignment and this tries again on the next scan.
	 */
	private syncCategoryColors(): void {
		const categories = this.categories();
		if (categories.every((c) => this.categoryColors[c] !== undefined)) {
			return;
		}
		try {
			const updated = updateStore(this.deps.storePath, (store) => {
				ensureCategoryColors(store.categoryColors, categories);
			});
			this.categoryColors = { ...updated.categoryColors };
		} catch {
			// Try again on the next scan.
		}
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

	/** Returns `getDetail`'s cached result synchronously if it's already been fetched, otherwise `null` (doesn't fetch it here). */
	getCachedDetail(id: string): Detail | null {
		return this.detailCache.get(id) ?? null;
	}

	/** Drops `id`'s detail cache entry. The next `getDetail`/`getCachedDetail` re-fetches it. */
	invalidateDetail(id: string): void {
		this.detailCache.delete(id);
	}

	/** A full scan (same as `rescan()`). */
	async scan(): Promise<void> {
		return this.rescan();
	}

	/** With `only` given, rescans just those ids and updates the cache (`json scan --only`). */
	async rescan(only?: string[]): Promise<void> {
		let result: ScanResult;
		try {
			result = await this.deps.scan(only);
		} catch (err) {
			this.emit("scanError", messageOf(err));
			return;
		}
		this.applyScanResult(result, only);
		this.syncCategoryColors();
		this.applyRegistry();
		this.applyCompacted();
		await this.refreshLive();
		this.emit("change");
	}

	/**
	 * Waits for the name `/rename NAME` wrote to show up in `sessions.get(id).name`. `/rename`
	 * doesn't call the model, so it never goes `busy`, and no hook event reaches `events.log`
	 * either — without repeatedly calling `rescan([id])` explicitly, neither `Row.name` nor the
	 * tab title would update until the next periodic scan (`RESCAN_INTERVAL_MS`). `rescan` fires
	 * `change` every time, so once the name matches, subscribers (`TerminalView.refreshName`,
	 * `refreshDeferredTerminalTabs`) redraw themselves. Gives up and returns `false` if
	 * `timeoutMs` passes without a match — the caller doesn't need to do anything in that case,
	 * since the periodic scan will catch up eventually anyway.
	 */
	async waitForName(
		id: string,
		expected: string,
		timeoutMs = WAIT_NAME_TIMEOUT_MS,
		intervalMs = WAIT_NAME_POLL_MS
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.sessions.get(id)?.name === expected) {
				return true;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return false;
			}
			await delay(Math.min(intervalMs, remaining));
			await this.rescan([id]);
		}
	}

	/**
	 * Derives each row's `daemon`/`exited` from `json live`'s `daemon.sessions`. Failures (e.g.
	 * the daemon isn't running) are silently ignored and treated as `daemon:false` — unlike a
	 * `json scan` failure, this never shows a `Notice`. Called: after `start()`'s first scan, on
	 * every `registry` change (1-second debounce), on the 60-second timer, and after `rescan()`.
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

	/** Called when an append to `events.log` is detected (by hand, or from `fs.watch`). */
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
				// Ignore malformed lines.
			}
		}
		if (ids.size > 0) {
			void this.rescan([...ids]);
		}
	}

	/**
	 * Starts `registry.watch()` and watching `events.log`, and does one initial scan. Returns a
	 * function to stop.
	 */
	start(): () => void {
		void this.rescan();
		const stopRegistry = this.registry.watch();
		const stopCompacted = this.compactedTracker.watch();
		if (!this.eventsWatcher) {
			try {
				this.eventsWatcher = fs.watch(this.deps.eventsLogPath, () => this.scheduleEventsCheck());
			} catch {
				this.eventsWatcher = null;
			}
		}
		return () => {
			stopRegistry();
			stopCompacted();
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
		this.compactedUnsubscribe();
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
		this.categoryColors = { ...store.categoryColors };
		if (only && only.length > 0) {
			for (const s of result.sessions) {
				this.sessions.set(s.id, mergeRow(rowFromScan(s, this.openTabIds, store), this.sessions.get(s.id)));
			}
		} else {
			const next = new Map<string, Row>();
			for (const s of result.sessions) {
				next.set(s.id, mergeRow(rowFromScan(s, this.openTabIds, store), this.sessions.get(s.id)));
			}
			this.sessions.clear();
			for (const [id, row] of next) {
				this.sessions.set(id, row);
			}
		}
	}

	/** Mutates rows in place; returns true if `daemon`/`exited` changed for even one of them. */
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
			row.waitingFor = entry?.waitingFor ?? null;
			row.pid = entry?.pid ?? null;
			row.rc = entry?.rc ?? false;
		}
	}

	/** Applies the just-compacted marker to rows. Same shape as `applyRegistry`. */
	private applyCompacted(): void {
		for (const row of this.sessions.values()) {
			row.compacted = this.compactedTracker.has(row.id);
		}
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
