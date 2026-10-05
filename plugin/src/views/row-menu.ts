// The row menu's order and conditions, apart from the `obsidian` `Menu` that draws them, so the
// grouping can be tested in Node. `rows-render.ts`'s `showRowMenu` maps each id to a title, an
// icon and a handler; a separator goes between groups.

import type { Row } from "../sessions/index";

export type RowMenuId =
	| "rename"
	| "moveToCategory"
	| "changeModel"
	| "compact"
	| "restartSession"
	| "usage"
	| "copyId"
	| "archive"
	| "endSession";

export interface RowMenuEntry {
	id: RowMenuId;
	enabled: boolean;
}

export interface RowMenuState {
	/** Whether the row has a name or first prompt to attach a category to. */
	categorizable: boolean;
	justCompacted: boolean;
	canRestart: boolean;
}

/**
 * Groups: naming; the running session (model, compact, restart); information; then end session and
 * archive (in that order), the destructive ones, last. Restart and End session exist for daemon sessions only;
 * Change model for Claude's (running) ones, and disabled for the other agents.
 */
export function rowMenuGroups(row: Pick<Row, "agent" | "daemon">, state: RowMenuState): RowMenuEntry[][] {
	const claude = row.agent === "claude";
	const session: RowMenuEntry[] = [];
	if (row.daemon || !claude) {
		session.push({ id: "changeModel", enabled: claude });
	}
	session.push({ id: "compact", enabled: !state.justCompacted });
	if (row.daemon) {
		session.push({ id: "restartSession", enabled: state.canRestart });
	}
	// Ending comes first: the real flow is end the session, then archive it.
	const last: RowMenuEntry[] = [];
	if (row.daemon) {
		last.push({ id: "endSession", enabled: true });
	}
	last.push({ id: "archive", enabled: true });
	return [
		[
			{ id: "rename", enabled: true },
			{ id: "moveToCategory", enabled: state.categorizable },
		],
		session,
		[
			{ id: "usage", enabled: true },
			{ id: "copyId", enabled: true },
		],
		last,
	];
}
