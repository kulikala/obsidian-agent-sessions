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
 * The End session dialog's optional actions. Archiving is always offered; closing the tab only
 * when a tab owns the session (`openAsTab`), since there is nothing to close otherwise.
 */
export function endSessionDialogModel(openAsTab: boolean): EndSessionDialogModel {
	const options: EndSessionOption[] = [{ id: "archive", labelKey: "confirm.endSession.archive" }];
	if (openAsTab) {
		options.push({ id: "closeTab", labelKey: "confirm.endSession.closeTab" });
	}
	return { options, choices: { archive: false, closeTab: false } };
}

export interface EndSessionActions {
	archive: () => void;
	closeTab: () => void;
}

/**
 * Runs the ticked actions after the session ended. Closing is only honoured when the dialog
 * offered it (`openAsTab`), keeping an unticked box — or a session without a tab — at today's
 * behaviour.
 */
export function runEndSessionOptions(openAsTab: boolean, choices: EndSessionChoices, actions: EndSessionActions): void {
	if (choices.archive) {
		actions.archive();
	}
	if (openAsTab && choices.closeTab) {
		actions.closeTab();
	}
}
