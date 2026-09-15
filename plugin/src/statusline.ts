// `~/.agents/sessions/status/<id>.json` の監視とステータスバーの整形（§6.1）。
// ファイルは `agent-sessions status` が Claude Code の statusLine から受けた
// JSON をそのまま書いたもの。

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

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

/** `status/` ディレクトリの監視。`get(id)` は毎回ファイルを読む（軽い JSON 1 件）。 */
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

	onChange(cb: () => void): () => void {
		this.on("change", cb);
		return () => this.off("change", cb);
	}

	/** テスト向け：変化を通知するだけ（`get` は毎回読むので状態を持たない）。 */
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
 * `Opus 5 · high · ctx 42% · rc ● · 5h 37% · 7d 12%`。
 * モデル・エフォートが無ければ「デフォルト」、他の値が無ければ `—`。
 * `rc` は `~/.claude/sessions` の `bridgeSessionId` の有無（`registry.ts` の
 * `RegistryEntry.rc`）。台帳自体が無ければ `null` を渡し `rc —` になる。
 */
/** `effort` は文字列（`high`）でも `{level: "high"}` でも来る。 */
function effortOf(v: unknown): unknown {
	if (v && typeof v === "object" && "level" in (v as Record<string, unknown>)) {
		return (v as Record<string, unknown>).level;
	}
	return v;
}

export function formatStatus(info: StatusInfo | null, rc: boolean | null): string {
	const model = info?.model ?? "デフォルト";
	const effort = info?.effort ?? "デフォルト";
	const ctx = info?.ctxPercent != null ? `ctx ${Math.round(info.ctxPercent)}%` : "ctx —";
	const rcMark = rc === null ? "rc —" : rc ? "rc ●" : "rc ○";
	const five = info?.fiveHour != null ? `5h ${Math.round(info.fiveHour)}%` : "5h —";
	const seven = info?.sevenDay != null ? `7d ${Math.round(info.sevenDay)}%` : "7d —";
	return [model, effort, ctx, rcMark, five, seven].join(" · ");
}
