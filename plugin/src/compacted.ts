// `~/.agents/sessions/compacted/<id>.json` の監視（T-77 追補）。ファイルの有無だけを見る
// ——存在すれば「compact 直後（手動・自動とも）で、まだ次の指示を送っていない」。
// `agentsessions/hooks.py` の `_update_compacted` が `SessionStart`（source=compact）で
// 作り、`UserPromptSubmit`・`SessionEnd` で消す。`registry.ts`・`statusline.ts` と同じ形
// （fs.watch＋デバウンス）。

import { EventEmitter } from "node:events";
import * as fs from "node:fs";

const SUFFIX = ".json";

function readIds(dir: string): Set<string> {
	try {
		return new Set(
			fs
				.readdirSync(dir)
				.filter((n) => n.endsWith(SUFFIX))
				.map((n) => n.slice(0, -SUFFIX.length))
		);
	} catch {
		return new Set();
	}
}

/**
 * compact 直後・未入力のセッション id の集合を保持する。構築時に 1 回同期で読み込む。
 * `watch()` を呼ぶまで `fs.watch` は始めない（テストでは `refresh()` を直接呼ぶ）。
 */
export class CompactedTracker extends EventEmitter {
	private ids: Set<string>;
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private dir: string,
		private debounceMs = 200
	) {
		super();
		this.ids = readIds(dir);
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	onChange(cb: () => void): () => void {
		this.on("change", cb);
		return () => this.off("change", cb);
	}

	/** ディレクトリを読み直す。`fs.watch` が使えない環境向けに手動でも呼べる。 */
	refresh(): void {
		this.ids = readIds(this.dir);
		this.emit("change");
	}

	/** `fs.watch` を始める（200 ms デバウンス）。停止用の関数を返す。 */
	watch(): () => void {
		if (!this.watcher) {
			try {
				this.watcher = fs.watch(this.dir, () => this.scheduleRefresh());
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
