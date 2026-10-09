// The header shared by the dialogs that act on one session: the function name as the title, and
// under it the session itself (agent mark, name, category chip). The pure part: what the target
// line shows. `dialog-header.ts` draws it.

import { sessionDisplayName } from "../sessions/name";
import { splitName } from "../sessions/tree";

/** The fields of a session the header needs. A `Row` fits. */
export interface SessionTarget {
	id: string;
	agent: string;
	name: string | null;
	label: string | null;
}

export interface SessionHeaderModel {
	agent: string;
	/** The name without its category, the same text as the row's. */
	label: string;
	/** The category shown as a chip, `null` when the session has none. */
	category: string | null;
	/** The full label, for when the visible one is cut with an ellipsis. */
	tooltip: string;
}

export function buildSessionHeader(target: SessionTarget): SessionHeaderModel {
	const [category, label] = target.name ? splitName(target.name) : [null, sessionDisplayName(target)];
	return { agent: target.agent, label, category: category || null, tooltip: label };
}
