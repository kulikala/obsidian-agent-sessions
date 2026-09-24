// Watches `~/.claude/sessions/<pid>.json` (status, pid, rc).
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
}

interface RawSessionRecord {
	pid?: unknown;
	sessionId?: unknown;
	status?: unknown;
	updatedAt?: unknown;
	statusUpdatedAt?: unknown;
	bridgeSessionId?: unknown;
	waitingFor?: unknown;
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
			raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"));
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
		});
	}
	return out;
}

function isBusyLike(status: string): boolean {
	return status === "busy" || status === "shell";
}

/**
 * Holds the ledger read from `~/.claude/sessions`. Reads synchronously once at construction;
 * `fs.watch` doesn't start until `watch()` is called (tests call `refresh()` directly instead).
 */
export class Registry extends EventEmitter {
	private entries: Map<string, RegistryEntry>;
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private sessionsDir: string,
		private debounceMs = 200
	) {
		super();
		this.entries = readEntries(sessionsDir);
	}

	get(id: string): RegistryEntry | null {
		return this.entries.get(id) ?? null;
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
		const matches = (): boolean => {
			const entry = this.entries.get(id);
			if (!entry) {
				return false;
			}
			return status === "busy" ? isBusyLike(entry.status) : entry.status === "idle";
		};
		if (matches()) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.off("change", check);
				resolve(false);
			}, timeoutMs);
			const check = () => {
				if (matches()) {
					clearTimeout(timer);
					this.off("change", check);
					resolve(true);
				}
			};
			this.on("change", check);
		});
	}

	/** Re-reads the directory. Can also be called by hand for environments where `fs.watch` doesn't work. */
	refresh(): void {
		const next = readEntries(this.sessionsDir);
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
		if (!this.watcher) {
			try {
				this.watcher = fs.watch(this.sessionsDir, () => this.scheduleRefresh());
			} catch {
				this.watcher = null;
			}
		}
		return () => this.stopWatch();
	}

	private scheduleRefresh(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.refresh();
		}, this.debounceMs);
	}

	private stopWatch(): void {
		this.watcher?.close();
		this.watcher = null;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}
