// When a terminal tab connects to its daemon session. xterm can only be sized (and mounted) in a
// pane that has room, but a pane can have none — a narrow window with both sidebars open leaves the
// root pane at width 0 — and a tab waiting for room would never start its session. Pure, so it is
// tested in plain Node (test/terminal/pane-size.test.ts).

/** The size a session starts (or attaches) at when the pane hasn't been measured. */
export const FALLBACK_SIZE = { cols: 80, rows: 24 } as const;

/** How long a tab waits for its pane to get a size before connecting at `FALLBACK_SIZE`. */
export const NO_ROOM_ATTACH_MS = 1500;

/** Whether the pane has room for the terminal at all. */
export function paneHasRoom(size: { width: number; height: number }): boolean {
	return size.width > 0 && size.height > 0;
}

/**
 * What a tab with a session id does about connecting now: `attach` right away (the terminal is
 * mounted in a pane with room, or the wait for room is over), `wait` for the pane to get a size,
 * or `idle` when there is no session to connect to.
 */
export function attachPlan(args: {
	hasId: boolean;
	opened: boolean;
	size: { width: number; height: number };
	waitedForRoom: boolean;
}): "attach" | "wait" | "idle" {
	if (!args.hasId) {
		return "idle";
	}
	if (args.opened && paneHasRoom(args.size)) {
		return "attach";
	}
	return args.waitedForRoom ? "attach" : "wait";
}

/** The size to give the daemon: the terminal's own, or `FALLBACK_SIZE` when it has none to speak of
 * (xterm reports 0 columns in a pane without width). The pane's real size follows as a resize. */
export function launchSize(cols: number, rows: number): { cols: number; rows: number } {
	return cols >= 2 && rows >= 1 ? { cols, rows } : { ...FALLBACK_SIZE };
}
