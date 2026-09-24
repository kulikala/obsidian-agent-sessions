// Reading, writing, and locking `sessions.json`. Follows the same rules as
// `agentsessions/store.py` (key names, `version: 1`, how the lock is taken, moving aside a
// corrupt file), so the file format stays fully compatible with the Python side.

import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n";
import type { ArchivedSession, StoreSessionEntry } from "../types";

export interface MigratedFrom {
	path: string;
	at: string;
}

export interface Store {
	version: number;
	folded: string[];
	archived: ArchivedSession[];
	/** Legacy record of pending renames. Read and written back unchanged; the plugin itself doesn't use it. */
	pendingRenames: Record<string, string>;
	sessions: Record<string, StoreSessionEntry>;
	/** Category name → palette slot (0-11), never changed once assigned (`category.ts`'s
	 * `assignCategoryColor`). Kept here so the side panel and manager give the same category the same color. */
	categoryColors: Record<string, number>;
	migratedFrom?: MigratedFrom;
}

export function emptyStore(): Store {
	return { version: 1, folded: [], archived: [], pendingRenames: {}, sessions: {}, categoryColors: {} };
}

/** Thrown when the lock can't be acquired within `timeoutMs` (default 2 seconds). */
export class StoreLockError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fromRecord(data: Record<string, unknown>): Store {
	const store: Store = {
		version: typeof data.version === "number" ? data.version : 1,
		folded: Array.isArray(data.folded) ? (data.folded as string[]) : [],
		archived: Array.isArray(data.archived) ? (data.archived as ArchivedSession[]) : [],
		pendingRenames: isRecord(data.pendingRenames) ? (data.pendingRenames as Record<string, string>) : {},
		sessions: isRecord(data.sessions) ? (data.sessions as Record<string, StoreSessionEntry>) : {},
		categoryColors: isRecord(data.categoryColors) ? (data.categoryColors as Record<string, number>) : {},
	};
	if (isRecord(data.migratedFrom)) {
		store.migratedFrom = data.migratedFrom as unknown as MigratedFrom;
	}
	return store;
}

function toRecord(store: Store): Record<string, unknown> {
	const out: Record<string, unknown> = {
		version: store.version,
		folded: store.folded,
		archived: store.archived,
		pendingRenames: store.pendingRenames,
		sessions: store.sessions,
		categoryColors: store.categoryColors,
	};
	if (store.migratedFrom) {
		out.migratedFrom = store.migratedFrom;
	}
	return out;
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		String(d.getFullYear()) +
		pad(d.getMonth() + 1) +
		pad(d.getDate()) +
		pad(d.getHours()) +
		pad(d.getMinutes()) +
		pad(d.getSeconds())
	);
}

/** Moves a corrupt file aside to `<path>.broken-<YYYYmmddHHMMSS>`. */
function moveAside(storePath: string): void {
	const broken = `${storePath}.broken-${timestamp()}`;
	try {
		fs.renameSync(storePath, broken);
	} catch {
		// Even if moving it aside fails, continue on with an empty Store.
	}
}

/** Returns an empty Store if the file doesn't exist. If it's corrupt, moves it aside and returns an empty Store. */
export function loadStore(storePath: string): Store {
	if (!fs.existsSync(storePath)) {
		return emptyStore();
	}
	let text: string;
	try {
		text = fs.readFileSync(storePath, "utf8");
	} catch {
		return emptyStore();
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		moveAside(storePath);
		return emptyStore();
	}
	if (!isRecord(data)) {
		moveAside(storePath);
		return emptyStore();
	}
	return fromRecord(data);
}

/** Writes to tmp then renames. Assumes the caller holds the lock already (see `updateStore`). */
function saveStore(storePath: string, store: Store): void {
	const dir = path.dirname(storePath);
	fs.mkdirSync(dir, { recursive: true });
	const data = JSON.stringify(toRecord(store), null, 1);
	const tmp = path.join(dir, `.sessions.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, data, "utf8");
	try {
		fs.renameSync(tmp, storePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// no-op
		}
		throw err;
	}
}

interface LockOptions {
	timeoutMs?: number;
	retryIntervalMs?: number;
	staleAfterMs?: number;
}

const DEFAULT_LOCK: Required<LockOptions> = {
	timeoutMs: 2000,
	retryIntervalMs: 50,
	staleAfterMs: 10000,
};

/** Blocks synchronously via `Atomics.wait` (a busy-sleep while waiting for the lock). */
function sleepSync(ms: number): void {
	const view = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(view, 0, 0, ms);
}

function clearIfStale(lockPath: string, staleAfterMs: number): void {
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(lockPath).mtimeMs;
	} catch {
		return;
	}
	if (Date.now() - mtimeMs > staleAfterMs) {
		try {
			fs.rmdirSync(lockPath);
		} catch {
			// Fine if this fails because another writer already reclaimed it.
		}
	}
}

/** Takes exclusive ownership via `mkdir`. Retries on `EEXIST`, throws `StoreLockError` after `timeoutMs`. */
function acquireLock(lockPath: string, opts: Required<LockOptions>): void {
	// Create the lock's parent directory (where sessions.json lives) if it doesn't exist yet —
	// calling `mkdirSync(lockPath)` without it would fail with ENOENT.
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		try {
			fs.mkdirSync(lockPath);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				throw err;
			}
			clearIfStale(lockPath, opts.staleAfterMs);
			if (Date.now() >= deadline) {
				throw new StoreLockError(t("error.lockFailed", { path: lockPath }));
			}
			sleepSync(opts.retryIntervalMs);
		}
	}
}

function releaseLock(lockPath: string): void {
	try {
		fs.rmdirSync(lockPath);
	} catch {
		// Ignore if it's already gone.
	}
}

/** Reads under the lock → mutates via `fn(store)` → saves. Returns the mutated Store. */
export function updateStore(storePath: string, fn: (store: Store) => void, opts: LockOptions = {}): Store {
	const merged = { ...DEFAULT_LOCK, ...opts };
	const lockPath = `${storePath}.lock`;
	acquireLock(lockPath, merged);
	try {
		const store = loadStore(storePath);
		fn(store);
		saveStore(storePath, store);
		return store;
	} finally {
		releaseLock(lockPath);
	}
}

// --- Importing the old `claude-sessions.md` ---
//
// The frontmatter is YAML, but rather than add a dependency, this just naively reads the
// `folded:`/`hidden:` keys' `  - "..."` / `  - ...` lines (matching the shape
// `~/.config/dotfiles/cslib/store.py`'s `save_doc` writes). Each `hidden` line is `"<id> | <name>"`.

interface ParsedFrontmatter {
	folded: string[];
	hidden: { id: string; name: string }[];
}

function unquote(raw: string): string {
	const s = raw.trim();
	if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
		const inner = s.slice(1, -1);
		if (s[0] === '"') {
			return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		return inner;
	}
	return s;
}

const KEY_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/;
const ITEM_RE = /^\s*-\s+(.*)$/;

function parseFrontmatter(text: string): ParsedFrontmatter {
	const folded: string[] = [];
	const hidden: { id: string; name: string }[] = [];
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") {
		return { folded, hidden };
	}
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) {
		return { folded, hidden };
	}
	let key: string | null = null;
	for (const line of lines.slice(1, end)) {
		if (key === "folded" || key === "hidden") {
			const itemMatch = ITEM_RE.exec(line);
			if (itemMatch) {
				const value = unquote(itemMatch[1]);
				if (key === "folded") {
					folded.push(value);
				} else {
					const sepIdx = value.indexOf(" | ");
					if (sepIdx >= 0) {
						hidden.push({ id: value.slice(0, sepIdx).trim(), name: value.slice(sepIdx + 3).trim() });
					} else {
						hidden.push({ id: value.trim(), name: "" });
					}
				}
				continue;
			}
		}
		const keyMatch = KEY_RE.exec(line);
		if (keyMatch) {
			key = keyMatch[1];
		}
	}
	return { folded, hidden };
}

/**
 * When `sessions.json` doesn't exist but `mdPath` does, copies the frontmatter's `folded` to
 * `folded` and `hidden` to `archived`, and writes `migratedFrom`. Does nothing and returns
 * `null` if `sessions.json` already exists or `mdPath` doesn't.
 */
export function migrateFromMarkdown(mdPath: string, storePath: string): Store | null {
	if (fs.existsSync(storePath) || !fs.existsSync(mdPath)) {
		return null;
	}
	const text = fs.readFileSync(mdPath, "utf8");
	const parsed = parseFrontmatter(text);

	const lockPath = `${storePath}.lock`;
	acquireLock(lockPath, DEFAULT_LOCK);
	try {
		if (fs.existsSync(storePath)) {
			return null;
		}
		const store = emptyStore();
		store.folded = parsed.folded;
		store.archived = parsed.hidden.map(({ id, name }) => ({ id, name, agent: "claude" }));
		store.migratedFrom = { path: mdPath, at: new Date().toISOString() };
		saveStore(storePath, store);
		return store;
	} finally {
		releaseLock(lockPath);
	}
}
