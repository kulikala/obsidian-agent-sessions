// Types for the JSON returned by `agent-sessions json …` and the daemon. Scanning and
// detection logic lives on the Python side — this only defines the shape received here.

/** A single session from `json scan`. */
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

/** One archived entry in `sessions.json`. */
export interface ArchivedSession {
	id: string;
	name: string;
	agent: string;
}

/** One entry in `sessions.json`'s `sessions` — the plugin's record of a session it started.
 * `daemon`: only for a Codex session (no flag lets the caller assign a new session's own id —
 * see `backend.ts`'s `buildAgentArgv`) — the daemon-tracked placeholder id the tab actually
 * started under, once `json resolve codex` has learned this entry's key is the real thread id
 * (design.md §3.3). Absent for Claude (and for a Codex session not yet resolved), where the
 * daemon id and this entry's own key are simply the same id. */
export interface StoreSessionEntry {
	agent: string;
	cwd: string;
	daemon?: string;
}

/** The contents of `sessions.json`. */
export interface SessionStore {
	folded: string[];
	archived: ArchivedSession[];
	pendingRenames: Record<string, string>;
	sessions: Record<string, StoreSessionEntry>;
}

/** The full output of `json scan`. */
export interface ScanResult {
	sessions: ScanSession[];
	store: SessionStore;
}

/** A single session as returned by the daemon's `list`. */
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

/** A summary aggregated from `~/.claude/sessions/<pid>.json` (the ledger of running sessions). */
export interface LiveEntry {
	status: string;
	pid: number;
	rc: boolean;
	updated_at: number;
}

/** The output of `json live`. */
export interface LiveResult {
	live: Record<string, LiveEntry>;
	daemon: {
		running: boolean;
		sessions: DaemonSession[];
	};
}

/** The output of `json detail ID`. */
export interface Detail {
	last_user: string | null;
	last_assistant: string | null;
	/** The most recent slash command's name (e.g. `/compact`; arguments aren't included). `null` if there isn't one. */
	last_command: string | null;
	tools: string[];
	/** The most recent turn's model/effort, for an agent with no statusLine (Codex) — `statusInfo`
	 * (Claude's own live statusLine data) is preferred when it has a value; this is the fallback.
	 * Optional/absent rather than `null` so older Python builds that don't send these yet degrade
	 * to exactly today's behavior (falls through to "Default" the same as if they were never asked for). */
	model?: string | null;
	effort?: string | null;
}

/** A single turn from `json usage ID`. `ts`/`last_ts` are epoch seconds (`null` if absent). */
export interface UsageTurn {
	index: number;
	ts: number | null;
	prompt: string;
	/** True for the pseudo-turn representing everything before the first real prompt (`prompt` is empty in that case). */
	before_first?: boolean;
	calls: number;
	input: number;
	cache_create: number;
	cache_read: number;
	output: number;
	thinking: number;
	cost: number;
	tools: Record<string, number>;
	estimated: boolean;
	last_ts: number | null;
	context_last: number;
	models: Record<string, number>;
}

/** The totals from `json usage ID`. `duration` is the number of seconds from `first_ts` to `last_ts`. */
export interface UsageTotal {
	calls: number;
	input: number;
	cache_create: number;
	cache_read: number;
	output: number;
	thinking: number;
	cost: number;
	tools: Record<string, number>;
	estimated: boolean;
	duration: number | null;
	first_ts: number | null;
	last_ts: number | null;
	context_last: number;
}

/** The full output of `json usage ID`. `from`/`to` are epoch seconds (`null` if not given). */
export interface UsageResult {
	turns: UsageTurn[];
	total: UsageTotal;
	from: number | null;
	to: number | null;
}

/** One window/session usage summary from `json stats`. `unknown_cost` (T-103/T-104): true when
 * this total/entry includes a call from a model not in the price table (Codex only for now —
 * Claude's is always false) — `cost` is then a floor, not the true total, the same convention as
 * `json usage`'s per-turn `unknown_cost`. */
export interface StatsUsage {
	calls: number;
	input: number;
	output: number;
	cache_read: number;
	cache_create: number;
	cost: number;
	unknown_cost: boolean;
}

/** One window (5-hour, 7-day, or any other length an agent reports) from `json stats`.
 * `start`/`end` are epoch seconds. `used_percentage` can be `null` — not just while data hasn't
 * arrived yet (Claude's existing "no status/*.json yet" case), but permanently for a window
 * length this agent's account doesn't track a quota for at all (T-103/T-104's confirmed
 * real-world case — e.g. a Codex account on a 30-day-only plan has `used_percentage: null` on
 * both its `five_hour` and `seven_day` entries). `minutes` is the window's own length (T-104
 * addendum) — needed since an agent can report a window of any length, not just 5h/7d.
 * `label_key` is Python's best-effort i18n hint for it; the plugin computes its own label from
 * `minutes` instead (`windowLabel` in `manager-model.ts`) rather than depending on this string
 * matching a pre-registered key, so it's not otherwise used here. */
export interface StatsWindow {
	start: number;
	end: number;
	used_percentage: number | null;
	total: StatsUsage;
	sessions: Record<string, StatsUsage>;
	minutes: number;
	label_key: string;
}

/**
 * One agent's windows (or the Claude-only top-level ones) — always has `five_hour`/`seven_day`
 * (present even when `used_percentage` is `null`, i.e. not tracked for this agent), plus zero or
 * more additional real windows Codex (or a future agent) reports, each keyed `window_<minutes>m`
 * (T-104 addendum — e.g. `window_43200m` for a 30-day quota). A plain string-keyed map rather
 * than a fixed two-field shape, since the extra keys aren't known in advance; `orderedWindows`
 * (`manager-model.ts`) is the usual way to iterate every entry in a stable, length-sorted order.
 */
export type StatsWindows = Record<string, StatsWindow>;

/** The full output of `json stats`. `windows` is always present (Claude's own, unconditionally —
 * kept for backward compat even once `agents` is read instead, per lnx-py). `agents` (T-103/
 * T-104) has an entry only for a currently-enabled agent, each with the identical `StatsWindows`
 * shape as the top-level `windows` — `agents.claude.windows` duplicates the top-level content. */
export interface StatsResult {
	windows: StatsWindows;
	agents?: Record<string, { windows: StatsWindows }>;
}
