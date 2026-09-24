// Watches `~/.agents/sessions/status/<id>.json` and formats the status bar text. The file is
// written by `agent-sessions status`, verbatim from the JSON it receives from Claude Code's statusLine.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "./i18n";

export interface StatusInfo {
	model: string | null;
	effort: string | null;
	ctxPercent: number | null;
	fiveHour: number | null;
	sevenDay: number | null;
}

interface RawStatus {
	model?: { display_name?: unknown };
	context_window?: { used_percentage?: unknown };
	rate_limits?: {
		five_hour?: { used_percentage?: unknown };
		seven_day?: { used_percentage?: unknown };
	};
	effort?: unknown;
}

function num(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readStatus(statusDir: string, id: string): StatusInfo | null {
	let raw: RawStatus;
	try {
		raw = JSON.parse(fs.readFileSync(path.join(statusDir, `${id}.json`), "utf8"));
	} catch {
		return null;
	}
	return {
		model: str(raw.model?.display_name),
		effort: str(effortOf(raw.effort)),
		ctxPercent: num(raw.context_window?.used_percentage),
		fiveHour: num(raw.rate_limits?.five_hour?.used_percentage),
		sevenDay: num(raw.rate_limits?.seven_day?.used_percentage),
	};
}

/** Watches the `status/` directory. `get(id)` reads the file fresh every time (a single lightweight JSON file). */
export class StatusLine extends EventEmitter {
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private statusDir: string,
		private debounceMs = 200
	) {
		super();
	}

	get(id: string): StatusInfo | null {
		return readStatus(this.statusDir, id);
	}

	/** The `status/` directory's absolute path (`views/limits.ts` reads the same place). */
	get dir(): string {
		return this.statusDir;
	}

	onChange(cb: () => void): () => void {
		this.on("change", cb);
		return () => this.off("change", cb);
	}

	/** For tests: just fires the change notification (`get` re-reads every time, so there's no state to update). */
	refresh(): void {
		this.emit("change");
	}

	watch(): () => void {
		if (!this.watcher) {
			try {
				this.watcher = fs.watch(this.statusDir, () => this.scheduleRefresh());
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

/**
 * `Opus 5 · high · ctx 42% · rc ● · 5h 37% · 7d 12%`. Model/effort fall back to the "Default"
 * label when absent; the other values fall back to `—`. `rc` reflects whether
 * `~/.claude/sessions` has a `bridgeSessionId` (`registry.ts`'s `RegistryEntry.rc`) — pass
 * `null` when there's no ledger entry at all; only connected (`true`) shows `rc ●`, everything
 * else (`false`/`null`) shows `rc ○`.
 */
/** `effort` can arrive as either a plain string (`high`) or `{level: "high"}`. */
function effortOf(v: unknown): unknown {
	if (v && typeof v === "object" && "level" in (v as Record<string, unknown>)) {
		return (v as Record<string, unknown>).level;
	}
	return v;
}

export function formatStatus(info: StatusInfo | null, rc: boolean | null): string {
	const model = info?.model ?? t("common.default");
	const effort = info?.effort ?? t("common.default");
	const ctx = info?.ctxPercent != null ? `ctx ${Math.round(info.ctxPercent)}%` : "ctx —";
	const rcMark = rc ? "rc ●" : "rc ○";
	const five = info?.fiveHour != null ? `5h ${Math.round(info.fiveHour)}%` : "5h —";
	const seven = info?.sevenDay != null ? `7d ${Math.round(info.sevenDay)}%` : "7d —";
	return [model, effort, ctx, rcMark, five, seven].join(" · ");
}
