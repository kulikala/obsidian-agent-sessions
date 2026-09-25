// A terminal tab's status, as pure functions. Depends on neither `obsidian` nor `terminal.ts` —
// the side panel's and manager's row markers share this same status and its CSS classes.

import { t, type MessageKey } from "../i18n";
import type { Row } from "./index";

export type TerminalStatus =
	| "connecting"
	| "working"
	| "running-shell"
	| "asking"
	| "waiting"
	| "compacted"
	| "editing"
	| "idle"
	| "detached"
	| "exited"
	| "error";

export interface TerminalStatusInput {
	/** Daemon unreachable, claude missing, or a start failure (an exit reason other than `exited`). */
	error: boolean;
	/** claude has exited. */
	exited: boolean;
	/** The built-in editor is open. */
	editing: boolean;
	/** In the middle of attach/start. */
	connecting: boolean;
	/**
	 * The registry's status — the raw value claude itself writes to
	 * `~/.claude/sessions/<pid>.json` (`null` with no ledger entry). `waiting` is claude's own
	 * value, set while a dialog is open and waiting for an answer (AskUserQuestion, a permission
	 * prompt, elicitation, etc — see the top of `registry.ts`). This is distinct from the
	 * `waiting` (bool) field below despite the shared name — that one means "the turn ended, but
	 * this tab hasn't been viewed yet."
	 */
	registryStatus: "busy" | "shell" | "waiting" | "idle" | null | undefined;
	/** After `busy→idle`, this tab still hasn't been brought to front (distinct from claude's own `waiting` above). */
	waiting: boolean;
	/**
	 * Codex only (T-108) — classified from its own OSC-0 terminal title (`classifyCodexTitleStatus`,
	 * read live via xterm's `onTitleChange`), a far more immediate signal than the daemon's own
	 * rollout-tail-based `registryStatus` for this agent. `null`/`undefined` for Claude always
	 * (it has no equivalent), and for Codex whenever the title carries neither marker — in which
	 * case `registryStatus` alone decides, same as before this field existed.
	 */
	titleStatus?: "working" | "asking" | null;
	/**
	 * Right after a compact (manual `/compact` or automatic context compaction), before the next
	 * instruction has been sent (`CompactedTracker`). Kept as its own state rather than folded
	 * into "waiting for input" (`waiting`), since the context having just been reset is a
	 * distinct thing to signal.
	 */
	compacted: boolean;
	/** Attached to the daemon. */
	attached: boolean;
}

/** Priority order: error > exited > asking (registry `waiting` or Codex's own `titleStatus`) >
 * editing > connecting > running-shell > working (registry `busy` or Codex's own `titleStatus`) >
 * waiting > compacted > detached > idle. */
export function terminalStatus(input: TerminalStatusInput): TerminalStatus {
	if (input.error) {
		return "error";
	}
	if (input.exited) {
		return "exited";
	}
	if (input.registryStatus === "waiting" || input.titleStatus === "asking") {
		return "asking";
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
	if (input.registryStatus === "busy" || input.titleStatus === "working") {
		return "working";
	}
	if (input.waiting) {
		return "waiting";
	}
	if (input.compacted) {
		return "compacted";
	}
	if (!input.attached) {
		return "detached";
	}
	return "idle";
}

/** The icon for each status (Lucide) — matches the icon Claude's own app uses for the same
 * meaning, where one of its 5 status-filter buckets applies (see `StatusGroup` below). */
export const TERMINAL_STATUS_ICON: Record<TerminalStatus, string> = {
	connecting: "loader",
	working: "loader-circle",
	"running-shell": "terminal",
	asking: "hand",
	waiting: "eye",
	compacted: "archive-restore",
	editing: "pencil-line",
	idle: "circle-check",
	detached: "circle-dashed",
	exited: "circle-stop",
	error: "triangle-alert",
};

/** The CSS class shared by the tab header and row markers (color and motion live in `styles.css`). */
export function terminalStatusClass(status: TerminalStatus): string {
	return `agent-sessions-status-${status}`;
}

export const ALL_TERMINAL_STATUSES: readonly TerminalStatus[] = [
	"connecting",
	"working",
	"running-shell",
	"asking",
	"waiting",
	"compacted",
	"editing",
	"idle",
	"detached",
	"exited",
	"error",
];

/** The tooltip key for each status name (`status.*`), shared by the tab header and row markers. */
export const STATUS_LABEL_KEY: Record<TerminalStatus, MessageKey> = {
	connecting: "status.connecting",
	working: "status.working",
	"running-shell": "status.runningShell",
	asking: "status.asking",
	waiting: "status.waiting",
	compacted: "status.compacted",
	editing: "status.editing",
	idle: "status.idle",
	detached: "status.detached",
	exited: "status.exited",
	error: "status.error",
};

// ---- Status groups ----------------------------------------------------------------
//
// A coarser classification layered on top of the 11 `TerminalStatus` values, matching the
// buckets Claude's own app filters sessions by. The fine status still decides the row mark's
// icon/color/tooltip detail (above) — `StatusGroup` is only for the side panel's badge and the
// manager's status-filter menu.

export type StatusGroup = "needs-input" | "needs-review" | "running" | "done" | "error" | "archived";

/** Every group a session can filter/count into, except `archived` (that's a `Row` flag, not
 * derived from `TerminalStatus`) and `error` (no distinct filter bucket — see `statusGroup`'s comment). */
const STATUS_GROUP_OF: Record<TerminalStatus, StatusGroup> = {
	asking: "needs-input",
	waiting: "needs-review",
	compacted: "needs-review",
	connecting: "running",
	working: "running",
	"running-shell": "running",
	idle: "done",
	editing: "done",
	detached: "done",
	exited: "done",
	error: "error",
};

/**
 * `status`'s coarser group, or `archived` regardless of `status` once a session has been
 * archived (`Row.archived`) — archiving is its own terminal bucket, independent of whatever the
 * session's last-known running state was.
 */
export function statusGroup(status: TerminalStatus, archived: boolean): StatusGroup {
	return archived ? "archived" : STATUS_GROUP_OF[status];
}

/** The manager's status-filter menu options: "all" (respects the separate "Show archive"
 * checkbox — see `views/manager-model.ts`'s `matchesStatusFilter`) plus every group except
 * `error` (which has no filter bucket of its own; an errored session simply doesn't show under
 * any specific filter, only under "all"), in the same order Claude's own app lists them. */
export type ManagerStatusFilter = "all" | Exclude<StatusGroup, "error">;

export const MANAGER_STATUS_FILTERS: readonly ManagerStatusFilter[] = [
	"all",
	"needs-input",
	"needs-review",
	"running",
	"done",
	"archived",
];

/** The icon for each group in the manager's status-filter menu — the same icon as the fine
 * status that best represents the group (matches Claude's own app: a hand for "needs input", an
 * eye for "needs review", a spinning arc for "running", a checkmark for "done", a box for
 * "archived"). */
export const STATUS_GROUP_ICON: Record<Exclude<StatusGroup, "error">, string> = {
	"needs-input": "hand",
	"needs-review": "eye",
	running: "loader-circle",
	done: "circle-check",
	archived: "archive",
};

/** The group-level label (`status.group.*`). `error` has no entry — its fine name ("Error")
 * alone is already clear, and it has no filter bucket of its own. */
const STATUS_GROUP_LABEL_KEY: Record<Exclude<StatusGroup, "error">, MessageKey> = {
	"needs-input": "status.group.needsInput",
	"needs-review": "status.group.needsReview",
	running: "status.group.running",
	done: "status.group.done",
	archived: "status.group.archived",
};

/** The manager's status-filter menu item label — `status.group.all` for "all", otherwise the group's own label. */
export function managerStatusFilterLabelKey(filter: ManagerStatusFilter): MessageKey {
	return filter === "all" ? "status.group.all" : STATUS_GROUP_LABEL_KEY[filter];
}

/**
 * The tooltip for a status mark: the group label plus the fine status name (e.g. "Done — Not
 * connected"), or just the fine name when the group has none of its own (`error`). An archived
 * row shows only the group label ("Archived") — the icon already changed to the archive box, so
 * the underlying status no longer matters.
 */
export function statusTooltip(status: TerminalStatus, archived = false): string {
	if (archived) {
		return t("status.group.archived");
	}
	const group = statusGroup(status, false);
	if (group === "error") {
		return t(STATUS_LABEL_KEY[status]);
	}
	return `${t(STATUS_GROUP_LABEL_KEY[group])} — ${t(STATUS_LABEL_KEY[status])}`;
}

/** Priority order (same order as `terminalStatus`'s branches, highest first). Used to combine several views/rows. */
const PRIORITY_ORDER: readonly TerminalStatus[] = [
	"error",
	"exited",
	"asking",
	"editing",
	"connecting",
	"running-shell",
	"working",
	"waiting",
	"compacted",
	"detached",
	"idle",
];

/** Whichever of `a`/`b` has higher priority (combines multiple tabs open on the same session). */
export function higherPriorityStatus(a: TerminalStatus, b: TerminalStatus): TerminalStatus {
	return PRIORITY_ORDER.indexOf(a) <= PRIORITY_ORDER.indexOf(b) ? a : b;
}

/**
 * A row's status without a tab, as far as it can be known: determined only from `row.status`
 * (the registry status already merged into the scan result), `row.exited`, `row.daemon`, and
 * `row.compacted` — so it can only ever come out as `working`, `running-shell`, `asking`,
 * `exited`, `compacted`, `idle`, or `detached` (not running).
 */
export function rowTerminalStatus(row: Row): TerminalStatus {
	return terminalStatus({
		error: false,
		exited: row.exited != null,
		editing: false,
		connecting: false,
		registryStatus: row.status as "busy" | "shell" | "waiting" | "idle" | null | undefined,
		waiting: false,
		compacted: row.compacted,
		attached: row.daemon,
	});
}

/** The minimum `resolveRowStatus` needs to read. `AgentSessionsPlugin` satisfies this structurally. */
export interface TerminalStatusSource {
	terminalStatuses: Map<string, TerminalStatus>;
}

/**
 * A row's status: `source.terminalStatuses`'s value (written by `TerminalView`, the actual
 * status) if a tab is open for that id, otherwise `rowTerminalStatus` (as far as it can be
 * known from `Row` alone).
 */
export function resolveRowStatus(source: TerminalStatusSource, row: Row): TerminalStatus {
	return source.terminalStatuses.get(row.id) ?? rowTerminalStatus(row);
}
