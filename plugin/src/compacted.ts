// Watches `~/.agents/sessions/compacted/<id>.json`. Only whether the file exists matters —
// if it does, the session just ran /compact (manual or automatic) and hasn't had a next
// instruction sent yet. `agentsessions/hooks.py`'s `_update_compacted` creates it on
// `SessionStart` (source=compact) and removes it on `UserPromptSubmit`/`SessionEnd`. Same shape
// as `registry.ts`/`statusline.ts` (fs.watch plus debounce).

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
 * Holds the set of session ids that just compacted and haven't had input sent yet. Reads
 * synchronously once at construction; `fs.watch` doesn't start until `watch()` is called (tests
 * call `refresh()` directly instead).
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

	/** Re-reads the directory. Can also be called by hand for environments where `fs.watch` doesn't work. */
	refresh(): void {
		this.ids = readIds(this.dir);
		this.emit("change");
	}

	/** Starts `fs.watch` (200ms debounce). Returns a function to stop it. */
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
