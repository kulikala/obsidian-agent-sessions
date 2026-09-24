// A terminal tab's status, as pure functions. Depends on neither `obsidian` nor `terminal.ts` —
// the side panel's and manager's row markers share this same status and its CSS classes.

import type { MessageKey } from "../i18n";
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
	 * Right after a compact (manual `/compact` or automatic context compaction), before the next
	 * instruction has been sent (`CompactedTracker`). Kept as its own state rather than folded
	 * into "waiting for input" (`waiting`), since the context having just been reset is a
	 * distinct thing to signal.
	 */
	compacted: boolean;
	/** Attached to the daemon. */
	attached: boolean;
}

/** Priority order: error > exited > asking > editing > connecting > running-shell > working > waiting > compacted > detached > idle. */
export function terminalStatus(input: TerminalStatusInput): TerminalStatus {
	if (input.error) {
		return "error";
	}
	if (input.exited) {
		return "exited";
	}
	if (input.registryStatus === "waiting") {
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
	if (input.registryStatus === "busy") {
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

/** The icon for each status (Lucide). */
export const TERMINAL_STATUS_ICON: Record<TerminalStatus, string> = {
	connecting: "loader",
	working: "loader-circle",
	"running-shell": "terminal",
	asking: "message-circle-question",
	waiting: "bell-dot",
	compacted: "archive-restore",
	editing: "pencil-line",
	idle: "square-terminal",
	detached: "square-dashed",
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
