// `agent-sessions json …` とデーモンが返す JSON の型（§5・§6.1・§6.5）。
// 走査・判定のロジックは Python 側にある。ここは受け取る形だけを定める。

/** `json scan` の 1 セッション。 */
export interface ScanSession {
	id: string;
	agent: string;
	name: string | null;
	group: string | null;
	label: string | null;
	cwd: string;
	folder: string;
	last_activity: number;
	child: boolean;
	transcript: string | null;
}

/** `json scan` の出力全体。 */
export interface ScanResult {
	sessions: ScanSession[];
	groups: Record<string, string[]>;
}

/** デーモンの `list` が返す 1 セッション（§4.1）。 */
export interface DaemonSession {
	id: string;
	agent: string;
	cwd: string;
	pid: number;
	startedAt: number;
	clients: number;
	exited: number | null;
	exitedAt: number | null;
}

/** `~/.claude/sessions/<pid>.json`（起動中の台帳）を集約したもの。 */
export interface LiveEntry {
	status: string;
	pid: number;
	rc: boolean;
	updated_at: number;
}

/** `json live` の出力（§5）。 */
export interface LiveResult {
	live: Record<string, LiveEntry>;
	daemon: {
		running: boolean;
		sessions: DaemonSession[];
	};
}

/** `json detail ID` の出力（§5）。 */
export interface Detail {
	last_user: string | null;
	last_assistant: string | null;
	tools: string[];
}
