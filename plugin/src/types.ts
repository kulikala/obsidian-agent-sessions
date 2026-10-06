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
	/** From the most recent `turn_context` — Codex only, additive: absent (not `null`)
	 * from the JSON object entirely for Claude, or for a Codex session with no `turn_context` yet.
	 * Claude's own model/effort come from statusLine instead (`sessions/statusline.ts`), which
	 * wins over these when present (`views/detail.ts`'s `renderBadges`, `views/manager.ts`'s model/
	 * effort columns). */
	model?: string;
	effort?: string;
	/** Claude Code's `/goal` (`sessions/goal.ts`); `null` without one, after `/goal clear`, and for
	 * other agents. Absent from an older CLI's output. */
	goal?: SessionGoal | null;
	/** Claude only, additive: present while the transcript's last compaction hasn't been answered
	 * by the model (`sessions/compacted.ts`'s `isCompacted`). */
	after_compact?: AfterCompact;
}

/** A session's `/goal`, from the latest `goal_status` line of its transcript. Times are epoch seconds. */
export interface SessionGoal {
	condition: string;
	/** The evaluator found the condition met (Claude Code then removes the goal). */
	met: boolean;
	/** The evaluator judged the condition impossible (also removes the goal). */
	failed?: boolean;
	/** The evaluator's latest explanation; `null` before its first run. */
	reason: string | null;
	/** When the goal was set. */
	since: number | null;
	/** When its latest status was written. */
	updated: number | null;
}

/** What has followed the last compaction (`agentsessions/sessions/scan.py`'s `read_after_compact`):
 * `"clean"` — only local commands; `"input"` — a prompt with no reply yet. */
export type AfterCompact = "clean" | "input";

/** One archived entry in `sessions.json`. */
export interface ArchivedSession {
	id: string;
	name: string;
	agent: string;
}

/** One entry in `sessions.json`'s `sessions` — the plugin's record of a session it started.
 * `daemon`: only for a Codex or OpenCode session (no flag lets the caller assign a new session's
 * own id — see `backend.ts`'s `buildAgentArgv`) — the daemon-tracked placeholder id the tab
 * actually started under, once `json resolve <agent>` has learned this entry's key is the real
 * thread id (design.md §3.3). Absent for Claude (and for a session not yet resolved), where the
 * daemon id and this entry's own key are simply the same id.
 * `name`: for OpenCode, which has no `/rename`, the name the user gave, overlaid on the row; for
 * Codex, the name given at creation, shown until Codex's own title has one (`sessions/index.ts`'s
 * `rowFromScan`). */
export interface StoreSessionEntry {
	agent: string;
	cwd: string;
	daemon?: string;
	name?: string;
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
	/** The last few human prompts, oldest first (Claude Code only; absent for the other agents and older programs). */
	recent_user?: string[];
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
	/** The priced calls only (an older helper sends `null` for a turn with any unpriced call). */
	cost: number;
	tools: Record<string, number>;
	estimated: boolean;
	/** Calls with no price (a Codex model missing from the price list, an OpenCode reply with no
	 * recorded cost), left out of `cost`. Absent from an older helper and from Claude Code. */
	unpriced_calls?: number;
	/** True when any call has no price (Codex, OpenCode). */
	unknown_cost?: boolean;
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
	/** See `UsageTurn.unpriced_calls`. */
	unpriced_calls?: number;
	unknown_cost?: boolean;
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

/** One window/session usage summary from `json stats`. `unknown_cost`: true when
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
	/** Calls left out of `cost` because they have no price (Codex only; absent for Claude). */
	unpriced_calls?: number;
}

/** One window (5-hour, 7-day, or any other length an agent reports) from `json stats`.
 * `start`/`end` are epoch seconds. `used_percentage` can be `null` — not just while data hasn't
 * arrived yet (Claude's existing "no status/*.json yet" case), but permanently for a window
 * length this agent's account doesn't track a quota for at all (e.g. a Codex account on a 30-day-only plan has `used_percentage: null` on
 * both its `five_hour` and `seven_day` entries). `minutes` is the window's own length
 * — needed since an agent can report a window of any length, not just 5h/7d.
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
	/** Whether the window's limit has been reached: the agent rejected a request for it inside the
	 * window, or `used_percentage` reads 100 or more (`used_percentage` then reads at least 100).
	 * Absent from an older helper's output, read as `false`. */
	exhausted?: boolean;
	/** When the limit was first hit inside the window (epoch seconds); `null` when only the
	 * percentage says so. */
	exhausted_at?: number | null;
}

/**
 * One agent's windows (or the Claude-only top-level ones) — always has `five_hour`/`seven_day`
 * (present even when `used_percentage` is `null`, i.e. not tracked for this agent), plus zero or
 * more additional real windows Codex (or a future agent) reports, each keyed `window_<minutes>m`
 * (e.g. `window_43200m` for a 30-day quota). A plain string-keyed map rather
 * than a fixed two-field shape, since the extra keys aren't known in advance; `orderedWindows`
 * (`manager-model.ts`) is the usual way to iterate every entry in a stable, length-sorted order.
 */
export type StatsWindows = Record<string, StatsWindow>;

/** The full output of `json stats`. `windows` is always present (Claude's own, unconditionally —
 * kept for backward compat even once `agents` is read instead, per lnx-py). `agents` has an entry only for a currently-enabled agent, each with the identical `StatsWindows`
 * shape as the top-level `windows` — `agents.claude.windows` duplicates the top-level content. */
export interface StatsResult {
	windows: StatsWindows;
	agents?: Record<string, { windows: StatsWindows }>;
}

/**
 * One human turn in a block: it starts with the person's input (a typed prompt, a slash command,
 * or their answer to a question the agent asked) and lasts until the agent's last output before
 * the next input. Notifications and sub-agent work count toward the block's time but are not turns.
 */
export interface ActivityTurn {
	/** The part of the turn inside the block. */
	start: number;
	end: number;
	/** Seconds of work in that part (idle stretches of 30 minutes or more are not counted). */
	active: number;
	/** The first ~200 characters of the input (a slash command is one line, `/model best`); for an
	 * `answer`, the answer itself. */
	prompt: string;
	kind: "prompt" | "answer";
	/** The agent's last answer in the turn (first ~400 characters); empty when it gave none. */
	reply: string;
}

/** A block of work: turns less than the gap apart, joined. Epoch seconds. */
export interface ActivitySpan {
	start: number;
	end: number;
	turns: ActivityTurn[];
}

/** One session's working time from `json activity`. */
export interface ActivitySession {
	id: string;
	agent: string;
	name: string | null;
	label: string | null;
	/** The part of the name before `': '`, if any. */
	category: string | null;
	child: boolean;
	/** When the session first worked, at any time (epoch seconds): its place in the calendar's left-to-right order. */
	first: number;
	spans: ActivitySpan[];
}

/** One turn as `json activity --raw` gives it (every kind; only prompts and answers are listed once blocks are built). */
export interface RawTurn {
	/** When it started; also the key runs point at. */
	start: number;
	end: number;
	prompt: string;
	kind: "prompt" | "answer" | "resume";
	reply: string;
}

/** A stretch of work: one segment of a turn (`turn` = that turn's start) or a sub-agent run (`null`). */
export interface RawRun {
	start: number;
	end: number;
	turn: number | null;
}

/** One session's unjoined activity from `json activity --raw`. */
export interface RawSession {
	id: string;
	agent: string;
	name: string | null;
	label: string | null;
	category: string | null;
	child: boolean;
	/** The session's earliest activity, in the range or not (epoch seconds); absent from an older program. */
	first?: number | null;
	turns: RawTurn[];
	runs: RawRun[];
}

/** The full output of `json activity --raw`. */
export interface RawActivityResult {
	sessions: RawSession[];
}
