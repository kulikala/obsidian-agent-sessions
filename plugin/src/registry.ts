// `~/.claude/sessions/<pid>.json` の監視（状態・pid・rc）（§6.5）。
//
// 各ファイルは 1 プロセスの台帳（`pid, sessionId, cwd, startedAt, procStart,
// version, kind, entrypoint, name, nameSource, updatedAt, status, statusUpdatedAt,
// bridgeSessionId, messagingSocketPath, waitingFor`）。pid が死んでいる台帳は無視する。
//
// `status` は Claude Code 自身が書く生の値（`busy`・`shell`・`idle` に加えて、実機で
// `waiting` も確認した。T-77）。`waiting` は AskUserQuestion・許可プロンプト・elicitation・
// モデル切替の確認など「ダイアログを開いて答えを待っている」ときに Claude Code が自分で
// 付ける値で、`waitingFor` にその理由（`"input needed"`・`"permission prompt"`・
// `"dialog open"` 等、実行ファイルの文字列から採取。公式ドキュメントに payload の詳細な
// 記述は無い）が添う。ターンが終わっただけの通常の待機（次の指示を待つだけ）は `idle` の
// ままで、`waiting` にはならない——`terminal-status.ts` の `asking` はここへ足す。

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RegistryEntry {
	status: string;
	pid: number;
	rc: boolean;
	updatedAt: number;
	/** `status === "waiting"` のときの理由（T-77）。無ければ `undefined`。 */
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
		// ESRCH＝そのプロセスは無い。EPERM 等は存在はしている。
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
 * `~/.claude/sessions` の台帳を保持する。構築時に 1 回同期で読み込む。
 * `watch()` を呼ぶまで `fs.watch` は始めない（テストでは `refresh()` を直接呼ぶ）。
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

	/** `busy`/`shell` → `idle` の遷移を通知する。 */
	onIdle(cb: (id: string) => void): () => void {
		this.on("idle", cb);
		return () => this.off("idle", cb);
	}

	/**
	 * `idle` → `busy`/`shell` の遷移を通知する（§6.7 応答の先頭マーカー）。初めて観測した
	 * id が `busy`/`shell` のときも発火する（新規セッションの最初の応答にもマーカーが付く）。
	 */
	onBusy(cb: (id: string) => void): () => void {
		this.on("busy", cb);
		return () => this.off("busy", cb);
	}

	/**
	 * `id` の状態が `status` になるまで待つ（D-42）。遷移ではなく現在値を見る——既にその状態なら
	 * 即 `true`。以後は `refresh` のたびに見直し、`timeoutMs` で諦めて `false`。
	 * 初めて観測する id でも成り立つ。`busy` は `shell` も含む。
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

	/** ディレクトリを読み直す。`fs.watch` が使えない環境向けに手動でも呼べる。 */
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

	/** `fs.watch` を始める（200 ms デバウンス）。停止用の関数を返す。 */
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
