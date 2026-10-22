// "End session": the confirmation's optional checkboxes and what they do, as pure functions.
// Depends on neither `obsidian` nor `main.ts`.

import type { MessageKey } from "../i18n";

export interface EndSessionOption {
	id: "archive" | "closeTab";
	labelKey: MessageKey;
}

export interface EndSessionChoices {
	archive: boolean;
	closeTab: boolean;
}

export interface EndSessionDialogModel {
	/** The checkboxes to show, in order; both start unchecked. */
	options: EndSessionOption[];
	choices: EndSessionChoices;
}

/**
 * The End session dialog's optional actions. Archiving is offered unless the row is tab-only
 * (`tabOnly`), since such a row has no recorded session to archive; closing the tab only when a
 * tab owns the session (`openAsTab`), since there is nothing to close otherwise.
 */
export function endSessionDialogModel(openAsTab: boolean, tabOnly = false): EndSessionDialogModel {
	const options: EndSessionOption[] = [];
	if (!tabOnly) {
		options.push({ id: "archive", labelKey: "confirm.endSession.archive" });
	}
	if (openAsTab) {
		options.push({ id: "closeTab", labelKey: "confirm.endSession.closeTab" });
	}
	return { options, choices: { archive: false, closeTab: false } };
}

export interface EndSessionActions {
	/** Ends the session; a rejection means nothing else runs. */
	end: () => Promise<void>;
	archive: () => void;
	closeTab: () => void;
}

/**
 * Ends the session first, then runs the ticked actions in order: archive, then close tab. A
 * failed end rejects before either, so a kill that did not reach the session leaves it untouched.
 * Closing is only honoured when the dialog offered it (`openAsTab`), keeping an unticked box — or
 * a session without a tab — at today's behaviour.
 */
export async function runEndSessionOptions(openAsTab: boolean, choices: EndSessionChoices, actions: EndSessionActions): Promise<void> {
	await actions.end();
	if (choices.archive) {
		actions.archive();
	}
	if (openAsTab && choices.closeTab) {
		actions.closeTab();
	}
}
