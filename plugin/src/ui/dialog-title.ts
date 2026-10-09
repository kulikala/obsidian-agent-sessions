// A dialog's title is the label of the menu item, command or button that opens it — read from
// the same message key, so the two cannot drift apart. A trailing ellipsis, which marks a menu
// item that opens a dialog, is not part of the title. `test/ui/dialog-title.test.ts` checks every
// dialog's title key against the openers.

import { t, type MessageKey } from "../i18n";

/** `label` without a trailing ellipsis ("…" or "..."). */
export function stripEllipsis(label: string): string {
	return label.replace(/\s*(?:…|\.\.\.)$/u, "");
}

/** The title of a dialog opened by the item labelled `key`. */
export function dialogTitle(key: MessageKey): string {
	return stripEllipsis(t(key));
}
