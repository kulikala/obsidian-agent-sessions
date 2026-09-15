// `sessions.json` の読み書きとロック（§3・§3.1）。
// `agentsessions/store.py` と同じ規則（キー名・`version: 1`・ロックの取り方・
// 壊れたファイルの退避）で、ファイル形式は Python 側と完全互換にする。

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchivedSession, StoreSessionEntry } from "./types";

export interface MigratedFrom {
	path: string;
	at: string;
}

export interface Store {
	version: number;
	folded: string[];
	archived: ArchivedSession[];
	pendingRenames: Record<string, string>;
	sessions: Record<string, StoreSessionEntry>;
	migratedFrom?: MigratedFrom;
}

export function emptyStore(): Store {
	return { version: 1, folded: [], archived: [], pendingRenames: {}, sessions: {} };
}

/** ロックが `timeoutMs`（既定 2 秒）で取れなかったときの例外。 */
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

/** 壊れたファイルを `<path>.broken-<YYYYmmddHHMMSS>` に退避する。 */
function moveAside(storePath: string): void {
	const broken = `${storePath}.broken-${timestamp()}`;
	try {
		fs.renameSync(storePath, broken);
	} catch {
		// 退避できなくても読み込みは空の Store で続ける。
	}
}

/** 無ければ空の Store。壊れていれば退避して空の Store を返す。 */
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

/** tmp に書いて rename。呼び出し側がロックの中で呼ぶ前提（`updateStore` 参照）。 */
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

/** `Atomics.wait` で同期的にブロックする（ロック待ちの busy-sleep）。 */
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
			// 他の書き手が既に取り直していれば失敗してよい。
		}
	}
}

/** `mkdir` で排他を取る。`EEXIST` なら再試行し、`timeoutMs` で `StoreLockError`。 */
function acquireLock(lockPath: string, opts: Required<LockOptions>): void {
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
				throw new StoreLockError(`ロックが取れない: ${lockPath}`);
			}
			sleepSync(opts.retryIntervalMs);
		}
	}
}

function releaseLock(lockPath: string): void {
	try {
		fs.rmdirSync(lockPath);
	} catch {
		// 既に消えていれば無視。
	}
}

/** ロックの中で読み→`fn(store)` で書き換え→保存。書き換えた Store を返す。 */
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

// --- 旧 `claude-sessions.md` の取り込み（§3） ---
//
// frontmatter は YAML だが、依存を増やさず `folded:`・`hidden:` の
// `  - "..."` / `  - ...` 行だけを素朴に読む（`~/.config/dotfiles/cslib/store.py`
// の `save_doc` が書く形と同じ）。`hidden` の各行は `"<id> | <name>"`。

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
 * `sessions.json` が無く `mdPath` があれば、frontmatter の `folded` → `folded`、
 * `hidden` → `archived` に写し、`migratedFrom` を書く。`sessions.json` が既に
 * あるか `mdPath` が無ければ何もせず `null` を返す。
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
