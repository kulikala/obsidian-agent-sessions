// Classifying the Enter key, and deciding what it should do based on the submit-key setting.
// Pure functions with no dependency on xterm or obsidian. Used by `views/terminal.ts`'s
// `handleKey` and by `views/editor-pane.ts`.

import type { SubmitKey } from "./settings";

/** Only the parts of a keyboard event that classification needs (so tests don't need to construct a real `KeyboardEvent`). */
export interface KeyLike {
	key: string;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	/** True while an IME composition is in progress. */
	isComposing?: boolean;
	/** Enter during an IME composition comes through as `keyCode === 229` in most browsers. */
	keyCode?: number;
}

export type EnterClass = SubmitKey | "passthrough";

/**
 * `passthrough` when the key isn't Enter, or it's Enter during an IME composition.
 * Otherwise classifies by modifier, in priority order shift, ctrl, alt, cmd (metaKey), none (enter).
 */
export function classifyEnter(ev: KeyLike): EnterClass {
	if (ev.key !== "Enter") {
		return "passthrough";
	}
	if (ev.isComposing || ev.keyCode === 229) {
		return "passthrough";
	}
	if (ev.shiftKey) {
		return "shift+enter";
	}
	if (ev.ctrlKey) {
		return "ctrl+enter";
	}
	if (ev.altKey) {
		return "alt+enter";
	}
	if (ev.metaKey) {
		return "cmd+enter";
	}
	return "enter";
}

export type EnterAction = "submit" | "newline" | "passthrough";

/**
 * Decides the action from a classified Enter and the submit-key setting. `passthrough` only
 * happens during IME composition or for non-Enter keys — every Enter combination resolves to
 * either `submit` or `newline` (the plugin intercepts all of them itself, since the terminal
 * can't distinguish modifiers when sending).
 */
export function resolveEnterAction(cls: EnterClass, submitKey: SubmitKey): EnterAction {
	if (cls === "passthrough") {
		return "passthrough";
	}
	return cls === submitKey ? "submit" : "newline";
}

/**
 * The bytes to send to the PTY for each action. When `submitKey === 'enter'`, this matches
 * Claude Code's own default: submit = `\r`, newline = `\x1b\r`. Otherwise keybindings.json
 * swaps them, so submit = `\x1b\r` (meta+enter), newline = `\r`.
 */
export function sendSequence(action: "submit" | "newline", submitKey: SubmitKey): string {
	const swapped = submitKey !== "enter";
	if (action === "submit") {
		return swapped ? "\x1b\r" : "\r";
	}
	return swapped ? "\r" : "\x1b\r";
}

/**
 * Derives the submit key from the contents of `keybindings.json`'s `Chat` block. A pure
 * function — the caller reads the file itself via `readChatBindings`.
 *
 * - If `enter: chat:newline` is set: `cmd+enter` when `cmd+enter`/`super+enter` is also present, otherwise `alt+enter`.
 * - Otherwise (no `enter` key, or it's not `chat:newline`): `enter`.
 */
export function deriveSubmitKey(chatBindings: Record<string, string> | undefined): SubmitKey {
	if (chatBindings?.enter !== "chat:newline") {
		return "enter";
	}
	return "cmd+enter" in chatBindings || "super+enter" in chatBindings ? "cmd+enter" : "alt+enter";
}

/** The submit-key symbol shown on the "send" button etc. (macOS). */
export const SUBMIT_KEY_SYMBOLS: Record<SubmitKey, string> = {
	enter: "⏎",
	"shift+enter": "⇧⏎",
	"ctrl+enter": "⌃⏎",
	"alt+enter": "⌥⏎",
	"cmd+enter": "⌘⏎",
};

/**
 * Non-macOS "send" button labels (spelled out as text). Has no entry for `cmd+enter` since
 * that's not offered as an option on non-macOS — `submitKeyButtonLabel`/
 * `submitKeyStatuslineSymbol` fall back to the macOS symbol in that case.
 */
export const SUBMIT_KEY_LABELS_NON_MAC: Partial<Record<SubmitKey, string>> = {
	enter: "Enter",
	"shift+enter": "Shift+Enter",
	"ctrl+enter": "Ctrl+Enter",
	"alt+enter": "Alt+Enter",
};

/** Short symbols for the non-macOS statusLine (the `submitSymbol` in ui.json). */
export const SUBMIT_KEY_STATUSLINE_SYMBOLS_NON_MAC: Partial<Record<SubmitKey, string>> = {
	enter: "⏎",
	"shift+enter": "S-⏎",
	"ctrl+enter": "C-⏎",
	"alt+enter": "A-⏎",
};

/** Label for the "send" button and built-in editor. macOS gets a symbol, non-macOS gets spelled-out text. */
export function submitKeyButtonLabel(key: SubmitKey, isMac: boolean): string {
	if (isMac) {
		return SUBMIT_KEY_SYMBOLS[key];
	}
	return SUBMIT_KEY_LABELS_NON_MAC[key] ?? SUBMIT_KEY_SYMBOLS[key];
}

/** Label for the statusLine (the `submitSymbol` in ui.json). macOS gets a symbol, non-macOS gets a short text form. */
export function submitKeyStatuslineSymbol(key: SubmitKey, isMac: boolean): string {
	if (isMac) {
		return SUBMIT_KEY_SYMBOLS[key];
	}
	return SUBMIT_KEY_STATUSLINE_SYMBOLS_NON_MAC[key] ?? SUBMIT_KEY_SYMBOLS[key];
}

/**
 * The submit key to use at startup and for "match the file". If keybindings.json making Enter
 * a newline (whether `deriveSubmitKey` returns `enter` or not) agrees with the current setting,
 * keeps the current setting (`shift+enter`/`ctrl+enter` can't be told apart from the file
 * alone); otherwise switches to the derived value.
 */
export function reconcileSubmitKey(chatBindings: Record<string, string> | undefined, current: SubmitKey): SubmitKey {
	const derived = deriveSubmitKey(chatBindings);
	return (derived === "enter") === (current === "enter") ? current : derived;
}

/**
 * Where a Ctrl-held key should go on non-macOS. On macOS, Cmd is Obsidian's modifier key, so
 * every Ctrl combination can safely go to the terminal. On non-macOS, Obsidian's modifier key
 * is Ctrl, and claude itself uses combinations like Ctrl+C/D/G/R/O/S/L/T, so simply handing
 * Ctrl to Obsidian would break those. The default is `terminal` (claude takes priority).
 * **Plain Ctrl+W/Ctrl+P also go to the terminal** — claude's input line uses Ctrl+W for
 * delete-word-back, and Ctrl+P can be used for readline-style history navigation.
 * Ctrl+Shift+W/Ctrl+Shift+P are used instead for the corresponding Obsidian action (close tab,
 * command palette) — Obsidian's default hotkeys for those are bound to the plain Ctrl+W/Ctrl+P
 * combinations, so merely letting the keydown through (`obsidian`) wouldn't trigger them; the
 * caller (`views/terminal.ts`) calls `app.commands.executeCommandById("workspace:close")` /
 * `("command-palette:open")` explicitly (`close-tab`/`command-palette`).
 * The other combinations sent to Obsidian: Ctrl+Shift+<key> (other than `copy`/`paste`/font
 * size/`close-tab`/`command-palette`), Ctrl+Tab, Ctrl+, — Obsidian's default hotkeys for these
 * are bound to the plain combination, so just letting the keydown through triggers them.
 * Returns `passthrough` when `ev.metaKey`/`ev.altKey` is set, or `ev.ctrlKey` isn't (leaving it
 * to the caller's existing branches). IME composition isn't checked here the way it is for
 * Enter, since this set of keys is never used to confirm IME candidates.
 */
export type CtrlKeyRole =
	| "terminal"
	| "obsidian"
	| "copy"
	| "paste"
	| "zoom-in"
	| "zoom-out"
	| "zoom-reset"
	| "close-tab"
	| "command-palette"
	| "passthrough";

export function classifyCtrlKeyNonMac(ev: KeyLike): CtrlKeyRole {
	if (!ev.ctrlKey || ev.metaKey || ev.altKey) {
		return "passthrough";
	}
	const key = ev.key;
	if (ev.shiftKey) {
		// Ctrl+Shift+C/V: copy/paste the terminal's selection (the convention used by Linux terminal apps).
		if (key === "c" || key === "C") {
			return "copy";
		}
		if (key === "v" || key === "V") {
			return "paste";
		}
		// Ctrl+Shift+=/-/0: font size (equivalent to macOS's Cmd +/-/0).
		if (key === "+" || key === "=") {
			return "zoom-in";
		}
		if (key === "_" || key === "-") {
			return "zoom-out";
		}
		if (key === "0" || key === ")") {
			return "zoom-reset";
		}
		// Ctrl+Shift+W/P: close tab / command palette (plain Ctrl+W/Ctrl+P go to the terminal).
		if (key === "w" || key === "W") {
			return "close-tab";
		}
		if (key === "p" || key === "P") {
			return "command-palette";
		}
		// Any other Ctrl+Shift+<key> goes to Obsidian (claude doesn't use Ctrl+Shift combinations).
		return "obsidian";
	}
	if (key === "Tab") {
		return "obsidian"; // Switch tabs.
	}
	if (key === ",") {
		return "obsidian"; // Settings.
	}
	return "terminal"; // Includes Ctrl+W/Ctrl+P, which claude's input line may use.
}
