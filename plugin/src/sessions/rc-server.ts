// The Remote Control server: one `claude remote-control` process in the vault folder, run in a
// daemon PTY, that creates a new Claude Code session for each connection from claude.ai/code or the
// Claude app. The side panel's nav shows it as a toggle. Pure: the state, the command line, and what
// the server's own output says. `rc-server-control.ts` drives it.

import type { DaemonSession } from "../types";

/** The daemon id the server runs under. Not a Claude session id, so it never matches a row. */
export const RC_SERVER_ID = "rc-server";

/**
 * - `off`: the toggle is off.
 * - `starting`: on, and the server runs (or is being started) but has not shown its connection link yet.
 * - `listening`: on, and the server shows its connection link.
 * - `down`: on, but no server runs. Only a click starts it again.
 */
export type RcServerState = "off" | "starting" | "listening" | "down";

export interface RcServerFacts {
	/** The toggle's saved position (`settings.rcServerEnabled`). */
	enabled: boolean;
	/** The server's daemon session, if the daemon has one. */
	daemon: DaemonSession | null;
	/** A start the user asked for is under way (the daemon may not list the process yet). */
	launching: boolean;
	/** What the server's output said last. */
	signal: RcServerSignal;
}

export function rcServerState(facts: RcServerFacts): RcServerState {
	if (!facts.enabled) {
		return "off";
	}
	const running = facts.daemon !== null && facts.daemon.exited === null;
	if (!running) {
		return facts.launching ? "starting" : "down";
	}
	return facts.signal === "ready" ? "listening" : "starting";
}

/** The server's daemon session in the daemon's list. */
export function findRcServer(sessions: readonly DaemonSession[]): DaemonSession | null {
	return sessions.find((s) => s.id === RC_SERVER_ID) ?? null;
}

/** What a click on the toggle does in each state. Starting the server is only ever a click. */
export type RcServerClick = "start" | "stop" | "wake";

export function rcServerClick(state: RcServerState): RcServerClick {
	switch (state) {
		case "off":
			return "start";
		case "down":
			return "wake";
		default:
			return "stop";
	}
}

/**
 * `claude remote-control --spawn=same-dir [--permission-mode auto]`. Every session the server creates
 * works in the server's own folder. Started again in the same folder, the same command brings back the
 * sessions the server had (Claude Code keeps them for about four hours).
 */
export function buildRcServerArgv(bin: string, autoMode: boolean): string[] {
	const argv = [bin, "remote-control", "--spawn=same-dir"];
	return autoMode ? [...argv, "--permission-mode", "auto"] : argv;
}

/**
 * - `question`: the server waits for an answer in its terminal (trusting the folder, enabling Remote
 *   Control on first use).
 * - `ready`: the server shows its connection link.
 * - `null`: neither yet.
 */
export type RcServerSignal = "question" | "ready" | null;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal output as plain text: escape sequences and carriage returns removed. */
export function plainOutput(raw: string): string {
	return raw.replace(ANSI, "").replace(/\r/g, "");
}

const QUESTIONS = [/Enable Remote Control\?/i, /\btrust\b[^\n]*\?/i, /\[y\/N\]|\(y\/n\)/i];
const READY = [/\/code\?environment=/, /space for QR code/i];

/** The last of the server's question and connection link in `text` (plain output, oldest first). */
export function rcServerSignal(text: string): RcServerSignal {
	const last = (patterns: RegExp[]): number =>
		Math.max(-1, ...patterns.map((p) => lastIndexOf(text, p)));
	const question = last(QUESTIONS);
	const ready = last(READY);
	if (question < 0 && ready < 0) {
		return null;
	}
	return ready > question ? "ready" : "question";
}

function lastIndexOf(text: string, pattern: RegExp): number {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
	let at = -1;
	for (const m of text.matchAll(global)) {
		at = m.index ?? at;
	}
	return at;
}

const LINK = /https:\/\/claude\.ai\/code\?environment=[\w-]+/g;

/** The last connection link (`https://claude.ai/code?environment=…`) in `text` (plain output), or `null`. */
export function rcConnectLink(text: string): string | null {
	const links = text.match(LINK);
	return links ? links[links.length - 1] : null;
}

/** Whether the server's output says it refused `--permission-mode auto`, so it can start again without it. */
export function rejectsAutoMode(text: string): boolean {
	return /permission[- ]mode/i.test(text) && /\bauto\b/.test(text) && /invalid|not (?:available|allowed|supported)|unknown|unavailable|disabled/i.test(text);
}

/** A process and its parent (`ps -A -o pid=,ppid=`). */
export interface ProcessLink {
	pid: number;
	ppid: number;
}

/** `ps -A -o pid=,ppid=` output as process links. */
export function parseProcessLinks(text: string): ProcessLink[] {
	const out: ProcessLink[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (m) {
			out.push({ pid: Number(m[1]), ppid: Number(m[2]) });
		}
	}
	return out;
}

/** The processes below `root` (children, their children, …). */
export function descendantsOf(root: number, links: readonly ProcessLink[]): Set<number> {
	const children = new Map<number, number[]>();
	for (const { pid, ppid } of links) {
		const list = children.get(ppid);
		if (list) {
			list.push(pid);
		} else {
			children.set(ppid, [pid]);
		}
	}
	const found = new Set<number>();
	const queue = [root];
	while (queue.length > 0) {
		const next = queue.shift() as number;
		for (const child of children.get(next) ?? []) {
			if (!found.has(child)) {
				found.add(child);
				queue.push(child);
			}
		}
	}
	return found;
}

/** The server's sessions that are working (busy, or waiting for an answer): stopping the server
 * interrupts them. Idle ones come back when the server starts again. */
export function rcSessionsAtWork(
	serverPid: number,
	links: readonly ProcessLink[],
	entries: Iterable<{ pid: number; status: string }>
): number {
	const below = descendantsOf(serverPid, links);
	let count = 0;
	for (const entry of entries) {
		if (below.has(entry.pid) && (entry.status === "busy" || entry.status === "waiting")) {
			count++;
		}
	}
	return count;
}
