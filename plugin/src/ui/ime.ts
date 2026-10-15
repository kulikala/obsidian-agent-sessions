// Keydown handling for the dialogs' text fields while an IME is composing (pure, no `obsidian`
// import). Enter, Tab, the arrow keys and Escape belong to the IME then: Enter commits the
// composition, so it must not also pick the highlighted category suggestion.

import { isComposing, type KeyLike } from "../terminal/keys";

/** `handler`, skipped for every keydown that arrives during an IME composition. */
export function ignoreWhileComposing<E extends KeyLike>(handler: (evt: E) => void): (evt: E) => void {
	return (evt) => {
		if (isComposing(evt)) {
			return;
		}
		handler(evt);
	};
}
