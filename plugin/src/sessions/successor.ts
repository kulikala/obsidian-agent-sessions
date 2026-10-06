// Claude Code sometimes starts again right after it was launched with `--session-id <tabId>`: the
// one-time "auto mode" acknowledgement and the first run after a login re-exec it, and the new
// process (`claude --permission-mode auto`, without `--session-id`) writes its ledger record
// (`~/.claude/sessions/<pid>.json`) and its transcript under an id of its own. The tab's id then
// never shows up in the ledger. These pure functions decide which ledger entry is the continuation
// of which tab; `main.ts` links the two (`sessions.json`'s `daemon` field, the same link a Codex
// thread gets) and swaps the tab over to the real id. `/clear` changes the id without a new
// process: the ledger record of the tab's own pid names the new id (`planInPlace`). No `obsidian`
// here, so it is tested in plain Node (test/sessions/successor.test.ts).

/** How long after a tab's session began a restarted process may still be taken for it. */
export const SUCCESSOR_WINDOW_MS = 2 * 60_000;
/** Slack for a start time that is only known to the second. */
const START_SLACK_MS = 2_000;

/** A running Claude session of the plugin whose own id the ledger doesn't know. */
export interface SuccessorTab {
	/** The tab's current id (what the ledger is missing). */
	id: string;
	cwd: string;
	/** When the daemon started the session (ms since the epoch). */
	startedAt: number;
	/** The pid the daemon started (`DaemonSession.pid`), when known. */
	daemonPid: number | null;
}

/** A ledger entry that might be a restarted process. */
export interface SuccessorCandidate {
	id: string;
	pid: number;
	cwd?: string;
	/** ms since the epoch. */
	startedAt?: number;
}

export interface SuccessorLink {
	tabId: string;
	successorId: string;
}

/** A folder path compared the way the filesystem does: separators and a trailing one don't matter,
 * and a drive path ignores case. */
export function normalizeFolder(p: string): string {
	let s = p.replace(/\\/g, "/");
	while (s.length > 1 && s.endsWith("/")) {
		s = s.slice(0, -1);
	}
	return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
}

/** Whether `c` was started in the tab's folder within `SUCCESSOR_WINDOW_MS` after the tab began. */
function startedAfter(tab: SuccessorTab, c: SuccessorCandidate): boolean {
	return (
		c.cwd !== undefined &&
		c.startedAt !== undefined &&
		normalizeFolder(c.cwd) === normalizeFolder(tab.cwd) &&
		c.startedAt >= tab.startedAt - START_SLACK_MS &&
		c.startedAt <= tab.startedAt + SUCCESSOR_WINDOW_MS
	);
}

/** The ledger entries that could be the continuation of at least one tab, without looking at
 * parent processes: not owned by any open tab or daemon session, and started in the tab's folder
 * soon after the tab began. Used to decide whether asking for parent pids is worth a process. */
export function possibleSuccessors(
	tabs: readonly SuccessorTab[],
	candidates: readonly SuccessorCandidate[],
	owned: (id: string) => boolean
): SuccessorCandidate[] {
	return candidates.filter((c) => !owned(c.id) && tabs.some((tab) => startedAfter(tab, c)));
}

/**
 * Which tab each unowned ledger entry continues. Candidates are taken earliest first, so two
 * restarts in a row pair up in the order they began.
 *
 * With the parent pids (`parents`: pid → ppid, `null` when they could not be read), a candidate
 * belongs to the tab whose daemon child is its parent; a candidate whose own parent is not in the
 * map falls back on the folder-and-time rule. By that rule alone a candidate is linked only when
 * exactly one tab could be its origin — with several waiting tabs in the same folder it would be a
 * guess.
 */
export function planSuccessors(args: {
	tabs: readonly SuccessorTab[];
	candidates: readonly SuccessorCandidate[];
	owned: (id: string) => boolean;
	parents: Readonly<Record<string, number>> | null;
}): SuccessorLink[] {
	const links: SuccessorLink[] = [];
	const taken = new Set<string>();
	const sorted = [...possibleSuccessors(args.tabs, args.candidates, args.owned)].sort(
		(a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)
	);
	for (const c of sorted) {
		const free = args.tabs.filter((tab) => !taken.has(tab.id) && startedAfter(tab, c));
		const parent = args.parents?.[String(c.pid)];
		let tab: SuccessorTab | undefined;
		if (parent !== undefined) {
			tab = free.find((t) => t.daemonPid === parent);
			// A parent that isn't any tab's process (a shell the user typed `claude` into) is not a
			// restart. When the tabs' own pids are unknown the parent says nothing either way.
			if (tab === undefined && free.some((t) => t.daemonPid === null) && free.length === 1) {
				tab = free[0];
			}
		} else if (free.length === 1) {
			tab = free[0];
		}
		if (tab !== undefined) {
			taken.add(tab.id);
			links.push({ tabId: tab.id, successorId: c.id });
		}
	}
	return links;
}

/**
 * Claude Code's `/clear` keeps the process and starts a new session id in it: the ledger record
 * of the tab's own process (`pid` = the daemon child) then names an id the tab doesn't have. Each
 * such tab is linked to that id, unless another tab or daemon session holds it (`heldElsewhere`).
 * Whether it was `/clear` (and not, say, `/resume`) is the `SessionEnd` hook's to say.
 */
export function planInPlace(
	tabs: readonly SuccessorTab[],
	candidates: readonly SuccessorCandidate[],
	heldElsewhere: (id: string, tab: SuccessorTab) => boolean
): SuccessorLink[] {
	const links: SuccessorLink[] = [];
	for (const tab of tabs) {
		const c = tab.daemonPid === null ? undefined : candidates.find((c) => c.pid === tab.daemonPid);
		if (c !== undefined && c.id !== tab.id && !heldElsewhere(c.id, tab)) {
			links.push({ tabId: tab.id, successorId: c.id });
		}
	}
	return links;
}
