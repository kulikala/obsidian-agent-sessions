// ターミナルタブの状態（純関数、D-66）。`obsidian` にも `terminal.ts` にも依存しない——
// サイドパネル・マネージャーの行の印も、この状態と CSS クラスを共有する（D-66 追補）。

import type { MessageKey } from "./i18n";
import type { Row } from "./index";

export type TerminalStatus =
	| "connecting"
	| "working"
	| "running-shell"
	| "waiting"
	| "editing"
	| "idle"
	| "detached"
	| "exited"
	| "error";

export interface TerminalStatusInput {
	/** デーモン不通・claude 不在・起動失敗（`exited` を除く終了理由がある）。 */
	error: boolean;
	/** claude が終了した。 */
	exited: boolean;
	/** 内蔵エディタが開いている。 */
	editing: boolean;
	/** attach／start の途中。 */
	connecting: boolean;
	/** registry の状態（`busy`・`shell`・`idle`。台帳が無ければ `null`）。 */
	registryStatus: "busy" | "shell" | "idle" | null | undefined;
	/** `busy→idle` の後、まだそのタブを前面にしていない。 */
	waiting: boolean;
	/** デーモンに attach 済み。 */
	attached: boolean;
}

/** 優先順：error＞exited＞editing＞connecting＞running-shell＞working＞waiting＞detached＞idle。 */
export function terminalStatus(input: TerminalStatusInput): TerminalStatus {
	if (input.error) {
		return "error";
	}
	if (input.exited) {
		return "exited";
	}
	if (input.editing) {
		return "editing";
	}
	if (input.connecting) {
		return "connecting";
	}
	if (input.registryStatus === "shell") {
		return "running-shell";
	}
	if (input.registryStatus === "busy") {
		return "working";
	}
	if (input.waiting) {
		return "waiting";
	}
	if (!input.attached) {
		return "detached";
	}
	return "idle";
}

/** 状態ごとのアイコン（Lucide、§D-66 の表）。 */
export const TERMINAL_STATUS_ICON: Record<TerminalStatus, string> = {
	connecting: "loader",
	working: "loader-circle",
	"running-shell": "terminal",
	waiting: "bell-dot",
	editing: "pencil-line",
	idle: "square-terminal",
	detached: "square-dashed",
	exited: "circle-stop",
	error: "triangle-alert",
};

/** タブ見出し・行の印に共通で立てる CSS クラス（色・動きは `styles.css` 側）。 */
export function terminalStatusClass(status: TerminalStatus): string {
	return `agent-sessions-status-${status}`;
}

export const ALL_TERMINAL_STATUSES: readonly TerminalStatus[] = [
	"connecting",
	"working",
	"running-shell",
	"waiting",
	"editing",
	"idle",
	"detached",
	"exited",
	"error",
];

/** 状態名の tooltip キー（`status.*`。タブ見出し・行の印で共有。D-66 追補）。 */
export const STATUS_LABEL_KEY: Record<TerminalStatus, MessageKey> = {
	connecting: "status.connecting",
	working: "status.working",
	"running-shell": "status.runningShell",
	waiting: "status.waiting",
	editing: "status.editing",
	idle: "status.idle",
	detached: "status.detached",
	exited: "status.exited",
	error: "status.error",
};

/** 優先順（`terminalStatus` の分岐順と同じ、高い方が先）。複数ビュー・行の合成に使う（D-66 追補）。 */
const PRIORITY_ORDER: readonly TerminalStatus[] = [
	"error",
	"exited",
	"editing",
	"connecting",
	"running-shell",
	"working",
	"waiting",
	"detached",
	"idle",
];

/** `a`・`b` のうち優先順の高い方（同じセッションに複数タブがあるときの合成。D-66 追補）。 */
export function higherPriorityStatus(a: TerminalStatus, b: TerminalStatus): TerminalStatus {
	return PRIORITY_ORDER.indexOf(a) <= PRIORITY_ORDER.indexOf(b) ? a : b;
}

/**
 * タブが無い行の状態（分かる範囲。D-66 追補）：`row.status`（走査結果に合成済みの registry
 * 状態）・`row.exited`・`row.daemon` だけで決まる分——`working`・`running-shell`・`exited`・
 * `idle`・`detached`（＝起動中でない）のどれかにしかならない。
 */
export function rowTerminalStatus(row: Row): TerminalStatus {
	return terminalStatus({
		error: false,
		exited: row.exited != null,
		editing: false,
		connecting: false,
		registryStatus: row.status as "busy" | "shell" | "idle" | null | undefined,
		waiting: false,
		attached: row.daemon,
	});
}

/** `resolveRowStatus` が読む最小限。`AgentSessionsPlugin` はこれを満たす（構造的に）。 */
export interface TerminalStatusSource {
	terminalStatuses: Map<string, TerminalStatus>;
}

/**
 * 行の状態：その id のタブが開いていれば `source.terminalStatuses` の値（`TerminalView` が
 * 書く、実際の状態）、無ければ `rowTerminalStatus`（`Row` だけから分かる範囲。D-66 追補）。
 */
export function resolveRowStatus(source: TerminalStatusSource, row: Row): TerminalStatus {
	return source.terminalStatuses.get(row.id) ?? rowTerminalStatus(row);
}
