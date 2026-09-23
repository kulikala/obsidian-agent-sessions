// ターミナルタブの状態（純関数、D-66）。`obsidian` にも `terminal.ts` にも依存しない——
// サイドパネル・マネージャーの行の印も、この状態と CSS クラスを共有する（適用は別の体）。

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
