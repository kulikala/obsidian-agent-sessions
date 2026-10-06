// Watches `~/.claude/sessions/<pid>.json` (status, pid, rc) and, when given a second directory,
// OpenCode's `~/.agents/sessions/opencode/<ses_id>.json` (see `readOpencodeEntries`).
//
// Each file is a single process's record (`pid, sessionId, cwd, startedAt, procStart,
// version, kind, entrypoint, name, nameSource, updatedAt, status, statusUpdatedAt,
// bridgeSessionId, messagingSocketPath, waitingFor`). Records whose pid is no longer alive are ignored.
//
// `status` is the raw value Claude Code itself writes (`busy`, `shell`, `idle`, plus `waiting`,
// confirmed on a real install). `waiting` is a value Claude Code sets itself whenever it has
// opened a dialog and is waiting for an answer — AskUserQuestion, a permission prompt,
// elicitation, confirming a model switch, etc. — and comes with `waitingFor` giving the reason
// (strings like `"input needed"`, `"permission prompt"`, `"dialog open"`, gathered from the
// executable; there's no documented spec for this payload). Ordinary idle time after a turn
// just ends (simply waiting for the next instruction) stays `idle` and never becomes `waiting`
// — `terminal-status.ts`'s `asking` builds on this.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RegistryEntry {
	status: string;
	pid: number;
	rc: boolean;
	updatedAt: number;
	/** The reason when `status === "waiting"`. `undefined` otherwise. */
	waitingFor?: string;
	/** The working directory the process was started in, when its record has one. */
	cwd?: string;
	/** When the process started (ms since the epoch), when its record has one. */
	startedAt?: number;
}

interface RawSessionRecord {
	pid?: unknown;
	sessionId?: unknown;
	status?: unknown;
	updatedAt?: unknown;
	statusUpdatedAt?: unknown;
	bridgeSessionId?: unknown;
	waitingFor?: unknown;
	cwd?: unknown;
	startedAt?: unknown;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH means the process doesn't exist; EPERM etc. mean it does.
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function readEntries(sessionsDir: string): Map<string, RegistryEntry> {
	const out = new Map<string, RegistryEntry>();
	let names: string[];
	try {
		names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".json"));
	} catch {
		return out;
	}
	for (const name of names) {
		let raw: RawSessionRecord;
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"));
			if (!parsed || typeof parsed !== "object") {
				continue;
			}
			raw = parsed;
		} catch {
			continue;
		}
		if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") {
			continue;
		}
		if (!isAlive(raw.pid)) {
			continue;
		}
		out.set(raw.sessionId, {
			status: typeof raw.status === "string" ? raw.status : "idle",
			pid: raw.pid,
			rc: !!raw.bridgeSessionId,
			updatedAt:
				typeof raw.updatedAt === "number"
					? raw.updatedAt
					: typeof raw.statusUpdatedAt === "number"
						? raw.statusUpdatedAt
						: 0,
			waitingFor: typeof raw.waitingFor === "string" ? raw.waitingFor : undefined,
			...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
			...(typeof raw.startedAt === "number" ? { startedAt: raw.startedAt } : {}),
		});
	}
	return out;
}

/**
 * OpenCode's status files, one per session, written by the plugin `agent-sessions setup
 * --opencode` installs (`agentsessions/agents/opencode/plugin_js.py`):
 * `{status: busy|idle|waiting, waiting_for: "permission"|"question"|"", pid, cwd, updated_at}`
 * (seconds). The id is the file name. The pid is the OpenCode process, so a dead one is a
 * stale file and is ignored.
 */
function readOpencodeEntries(dir: string): Map<string, RegistryEntry> {
	const out = new Map<string, RegistryEntry>();
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
	} catch {
		return out;
	}
	for (const name of names) {
		let raw: { pid?: unknown; status?: unknown; waiting_for?: unknown; updated_at?: unknown };
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
			if (!parsed || typeof parsed !== "object") {
				continue;
			}
			raw = parsed;
		} catch {
			continue;
		}
		if (typeof raw.pid !== "number" || !isAlive(raw.pid)) {
			continue;
		}
		if (raw.status !== "busy" && raw.status !== "idle" && raw.status !== "waiting") {
			continue;
		}
		out.set(name.slice(0, -".json".length), {
			status: raw.status,
			pid: raw.pid,
			rc: false,
			updatedAt: typeof raw.updated_at === "number" ? raw.updated_at * 1000 : 0,
			waitingFor: typeof raw.waiting_for === "string" && raw.waiting_for ? raw.waiting_for : undefined,
		});
	}
	return out;
}

/** How often `watch()` retries a sessions folder that doesn't exist yet. */
const RETRY_WATCH_MS = 5000;

function isBusyLike(status: string): boolean {
	return status === "busy" || status === "shell";
}

/**
 * Holds the ledger read from `~/.claude/sessions`, plus OpenCode's status files when
 * `opencodeDir` is given (their ids are `ses_…`, so they never collide with Claude's). Reads
 * synchronously once at construction; `fs.watch` doesn't start until `watch()` is called (tests
 * call `refresh()` directly instead).
 */
export class Registry extends EventEmitter {
	private entries: Map<string, RegistryEntry>;
	/** Old id → the id the ledger knows the session by (`setAlias`). */
	private aliases = new Map<string, string>();
	private watchers: fs.FSWatcher[] = [];
	private debounceTimer: number | null = null;
	/** Retries watching `sessionsDir` while it doesn't exist yet (an agent installed after the
	 * plugin loaded creates it on its first run). */
	private retryTimer: number | null = null;

	constructor(
		private sessionsDir: string,
		private debounceMs = 200,
		private opencodeDir: string | null = null,
		private retryWatchMs = RETRY_WATCH_MS
	) {
		super();
		this.entries = this.read();
	}

	private read(): Map<string, RegistryEntry> {
		const entries = readEntries(this.sessionsDir);
		if (this.opencodeDir) {
			for (const [id, entry] of readOpencodeEntries(this.opencodeDir)) {
				entries.set(id, entry);
			}
		}
		return entries;
	}

	get(id: string): RegistryEntry | null {
		return this.entries.get(this.resolve(id)) ?? null;
	}

	/**
	 * Says that the ledger knows the session started under `from` by the id `to` (an agent that
	 * restarted itself under a new session id — `successor.ts`). Callers that still hold the old
	 * id (`get`, `waitFor`) are answered from `to`'s entry. Fires `change` so a pending `waitFor`
	 * looks again.
	 */
	setAlias(from: string, to: string): void {
		if (from === to || this.aliases.get(from) === to) {
			return;
		}
		this.aliases.set(from, to);
		this.emit("change");
	}

	/** The id `id` is known by in the ledger: itself unless `setAlias` redirected it. */
	resolve(id: string): string {
		return this.aliases.get(id) ?? id;
	}

	all(): Map<string, RegistryEntry> {
		return this.entries;
	}

	onChange(cb: () => void): () => void {
		this.on("change", cb);
		return () => this.off("change", cb);
	}

	/** Fires on a `busy`/`shell` → `idle` transition. */
	onIdle(cb: (id: string) => void): () => void {
		this.on("idle", cb);
		return () => this.off("idle", cb);
	}

	/**
	 * Fires on an `idle` → `busy`/`shell` transition (used for the response marker at the start
	 * of a jump). Also fires the first time an id is observed at all, if it's already
	 * `busy`/`shell` (so a new session's first response still gets a marker).
	 */
	onBusy(cb: (id: string) => void): () => void {
		this.on("busy", cb);
		return () => this.off("busy", cb);
	}

	/**
	 * Waits until `id`'s state becomes `status`. Checks the current value, not a transition — if
	 * it's already in that state, resolves `true` right away. Otherwise re-checks on every
	 * `refresh` and gives up (`false`) after `timeoutMs`. Works even for an id that's never been
	 * observed before. `busy` also matches `shell`.
	 */
	waitFor(id: string, status: "idle" | "busy", timeoutMs: number): Promise<boolean> {
		return this.waitUntil(id, (entry) => (status === "busy" ? isBusyLike(entry.status) : entry.status === "idle"), timeoutMs);
	}

	/** Like `waitFor`, for any condition on `id`'s entry (`syncRemoteControlTitle`: connected and idle). */
	waitUntil(id: string, test: (entry: RegistryEntry) => boolean, timeoutMs: number): Promise<boolean> {
		const matches = (): boolean => {
			const entry = this.entries.get(this.resolve(id));
			return !!entry && test(entry);
		};
		if (matches()) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => {
				this.off("change", check);
				resolve(false);
			}, timeoutMs);
			const check = () => {
				if (matches()) {
					window.clearTimeout(timer);
					this.off("change", check);
					resolve(true);
				}
			};
			this.on("change", check);
		});
	}

	/** Re-reads the directory. Can also be called by hand for environments where `fs.watch` doesn't work. */
	refresh(): void {
		const next = this.read();
		const prev = this.entries;
		this.entries = next;
		for (const [id, entry] of next) {
			const before = prev.get(id);
			if (before && isBusyLike(before.status) && entry.status === "idle") {
				this.emit("idle", id);
			}
			if ((!before || !isBusyLike(before.status)) && isBusyLike(entry.status)) {
				this.emit("busy", id);
			}
		}
		this.emit("change");
	}

	/** Starts `fs.watch` (200ms debounce). Returns a function to stop it. */
	watch(): () => void {
		if (this.watchers.length === 0) {
			if (!this.watchDir(this.sessionsDir)) {
				this.retryWatch();
			}
			if (this.opencodeDir) {
				// The plugin creates this folder on its first write; watching needs it to exist.
				try {
					fs.mkdirSync(this.opencodeDir, { recursive: true });
				} catch {
					// Watching it fails below, and OpenCode stays unwatched.
				}
				this.watchDir(this.opencodeDir);
			}
		}
		return () => this.stopWatch();
	}

	private watchDir(dir: string): boolean {
		try {
			this.watchers.push(fs.watch(dir, () => this.scheduleRefresh()));
			return true;
		} catch {
			// A folder that can't be watched just isn't watched.
			return false;
		}
	}

	/** Tries again every few seconds until `sessionsDir` can be watched, then reads it at once. */
	private retryWatch(): void {
		this.retryTimer = window.setInterval(() => {
			if (this.watchDir(this.sessionsDir)) {
				this.clearRetry();
				this.refresh();
			}
		}, this.retryWatchMs);
	}

	private clearRetry(): void {
		if (this.retryTimer) {
			window.clearInterval(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private scheduleRefresh(): void {
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.refresh();
		}, this.debounceMs);
	}

	private stopWatch(): void {
		this.clearRetry();
		for (const watcher of this.watchers) {
			watcher.close();
		}
		this.watchers = [];
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}
