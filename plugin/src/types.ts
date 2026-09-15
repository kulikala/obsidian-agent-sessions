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

/** `sessions.json` のアーカイブ 1 件（§3）。 */
export interface ArchivedSession {
	id: string;
	name: string;
	agent: string;
}

/** `sessions.json` の `sessions` の 1 件（§3）。プラグインが起動したセッションの控え。 */
export interface StoreSessionEntry {
	agent: string;
	cwd: string;
}

/** `sessions.json` の内容（§3）。 */
export interface SessionStore {
	folded: string[];
	archived: ArchivedSession[];
	pendingRenames: Record<string, string>;
	sessions: Record<string, StoreSessionEntry>;
}

/** `json scan` の出力全体（§5）。 */
export interface ScanResult {
	sessions: ScanSession[];
	store: SessionStore;
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

/** `json usage ID` の 1 ターン（D-30）。`ts` は epoch 秒。 */
export interface UsageTurn {
	index: number;
	ts: number;
	prompt: string;
	calls: number;
	input: number;
	cache_create: number;
	cache_read: number;
	output: number;
	thinking: number;
	models: Record<string, number>;
}

/** `json usage ID` の合計（D-30）。 */
export interface UsageTotal {
	calls: number;
	input: number;
	cache_create: number;
	cache_read: number;
	output: number;
	thinking: number;
}

/** `json usage ID` の出力全体（D-30）。`from`／`to` は epoch 秒（指定が無ければ `null`）。 */
export interface UsageResult {
	turns: UsageTurn[];
	total: UsageTotal;
	from: number | null;
	to: number | null;
}
