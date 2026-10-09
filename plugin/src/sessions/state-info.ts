// What the detail pane says about a session's state (pure functions, no `obsidian` import): the
// state's icon and CSS class (the same ones the row mark uses), its name, and a one-sentence
// explanation; plus the attention kinds the side panel's badge counts (`attention.ts`), each with
// its own icon, name and what to do about it. Tested in test/sessions/state-info.test.ts.

import type { MessageKey } from "../i18n";
import {
	statusGroup,
	STATUS_GROUP_ICON,
	STATUS_LABEL_KEY,
	TERMINAL_STATUS_ICON,
	terminalStatusClass,
	type TerminalStatus,
} from "./terminal-status";

export interface StateInfo {
	icon: string;
	/** The status color/motion class shared with the row mark. */
	cls: string;
	labelKey: MessageKey;
	descKey: MessageKey;
}

export const STATE_DESC_KEY: Record<TerminalStatus, MessageKey> = {
	connecting: "detail.state.connecting",
	working: "detail.state.working",
	"running-shell": "detail.state.runningShell",
	asking: "detail.state.asking",
	waiting: "detail.state.waiting",
	compacted: "detail.state.compacted",
	editing: "detail.state.editing",
	idle: "detail.state.idle",
	detached: "detail.state.detached",
	exited: "detail.state.exited",
	error: "detail.state.error",
};

/** The session's state as the row mark shows it: an archived row is just "Archived". */
export function stateInfo(status: TerminalStatus, archived: boolean): StateInfo {
	if (archived) {
		return {
			icon: STATUS_GROUP_ICON.archived,
			cls: "agent-sessions-status-archived",
			labelKey: "status.group.archived",
			descKey: "detail.state.archived",
		};
	}
	return {
		icon: TERMINAL_STATUS_ICON[status],
		cls: terminalStatusClass(status),
		labelKey: STATUS_LABEL_KEY[status],
		descKey: STATE_DESC_KEY[status],
	};
}

export type AttentionKind = "needs-input" | "needs-review";

export interface AttentionInfo {
	kind: AttentionKind;
	icon: string;
	cls: string;
	labelKey: MessageKey;
	descKey: MessageKey;
}

/**
 * The attention kinds that apply — the same classification the side panel's badge counts
 * (`statusGroup`): `needs-input` for a session asking, `needs-review` for one waiting or just
 * compacted. Empty for everything else, and for archived rows.
 */
export function attentionInfos(status: TerminalStatus, archived: boolean): AttentionInfo[] {
	const group = statusGroup(status, archived);
	if (group === "needs-input") {
		return [
			{
				kind: "needs-input",
				icon: STATUS_GROUP_ICON["needs-input"],
				cls: terminalStatusClass("asking"),
				labelKey: "status.group.needsInput",
				descKey: "detail.attention.needsInput",
			},
		];
	}
	if (group === "needs-review") {
		return [
			{
				kind: "needs-review",
				icon: STATUS_GROUP_ICON["needs-review"],
				cls: terminalStatusClass(status),
				labelKey: "status.group.needsReview",
				descKey: status === "compacted" ? "detail.attention.compacted" : "detail.attention.needsReview",
			},
		];
	}
	return [];
}
