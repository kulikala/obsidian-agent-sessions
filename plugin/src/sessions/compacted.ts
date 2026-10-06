// Watches `~/.agents/sessions/compacted/<id>.json`. Only whether the file exists matters —
// if it does, the session just ran /compact (manual or automatic) and hasn't had a next
// instruction sent yet. `agentsessions/claude/hooks.py`'s `_update_compacted` creates it on
// `SessionStart` (source=compact) and removes it on `UserPromptSubmit`/`SessionEnd`. Same shape
// as `registry.ts`/`statusline.ts` (fs.watch plus debounce).
//
// The marker is the fast signal; `isCompacted` also reads the transcript (the scan's
// `after_compact`), which outlives a `SessionEnd` — a headless `/compact` that `/exit`s, a
// restart or a resume all end the process and drop the marker.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type { AfterCompact } from "../types";

/**
 * Whether a session counts as compacted: its last substantive input is the compaction itself.
 * Local commands after it (`/rename`, `/model`, `/effort`, `/reload-plugins`, `!` shell commands
 * — the scan's `after_compact` is `"clean"` through them) don't change that; a prompt the model
 * answers does. `"input"` (a prompt sent, nothing answered yet) still counts while the context
 * reads 0% — no model turn has filled it since the compaction.
 */
export function isCompacted(marker: boolean, afterCompact: AfterCompact | undefined, ctxPercent: number | null | undefined): boolean {
	return marker || afterCompact === "clean" || (afterCompact === "input" && ctxPercent === 0);
}

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
	private debounceTimer: number | null = null;

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

	/** Starts `fs.watch` (200ms debounce). Returns a function to stop it. The folder is created
	 * first: on a fresh install the hook hasn't written it yet, and a watch on a missing folder fails
	 * for good. */
	watch(): () => void {
		if (!this.watcher) {
			try {
				fs.mkdirSync(this.dir, { recursive: true });
				this.watcher = fs.watch(this.dir, () => this.scheduleRefresh());
			} catch {
				this.watcher = null;
			}
		}
		return () => this.stopWatch();
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
		this.watcher?.close();
		this.watcher = null;
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}
