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

/** One entry in `sessions.json`'s `sessions` — the plugin's record of a session it started. */
export interface StoreSessionEntry {
	agent: string;
	cwd: string;
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
}

/** A single turn from `json usage ID`. `ts`/`last_ts` are epoch seconds (`null` if absent). */
export interface UsageTurn {
	index: number;
	ts: number | null;
	prompt: string;
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

/** One window/session usage summary from `json stats`. */
export interface StatsUsage {
	calls: number;
	input: number;
	output: number;
	cache_read: number;
	cache_create: number;
	cost: number;
}

/** One window (5-hour or 7-day) from `json stats`. `start`/`end` are epoch seconds. */
export interface StatsWindow {
	start: number;
	end: number;
	used_percentage: number | null;
	total: StatsUsage;
	sessions: Record<string, StatsUsage>;
}

/** The full output of `json stats`. */
export interface StatsResult {
	windows: {
		five_hour: StatsWindow;
		seven_day: StatsWindow;
	};
}
