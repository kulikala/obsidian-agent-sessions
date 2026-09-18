// Enter の分類と、改行キー設定からの動作決定（§6.8・D-41）。xterm にも obsidian にも
// 依存しない純関数。`views/terminal.ts` の `handleKey` から使う。

import type { NewlineKey, SubmitKey } from "./settings";

/** キーボードイベントのうち、分類に要る部分だけ（テストでは本物の `KeyboardEvent` を作らずに済む）。 */
export interface KeyLike {
	key: string;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	/** IME 変換中。 */
	isComposing?: boolean;
	/** IME 変換中の Enter は多くのブラウザで `keyCode === 229` になる。 */
	keyCode?: number;
}

export type EnterClass = "shift+enter" | "meta+enter" | "ctrl+enter" | "super+enter" | "enter" | "passthrough";

/**
 * Enter でなければ、または IME 変換中の Enter なら `passthrough`。
 * 修飾は shift・alt（meta+enter）・ctrl・meta（super+enter）・無し（enter）の優先順で 1 つに分類する。
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
	if (ev.altKey) {
		return "meta+enter";
	}
	if (ev.ctrlKey) {
		return "ctrl+enter";
	}
	if (ev.metaKey) {
		return "super+enter";
	}
	return "enter";
}

export type EnterAction = "newline" | "submit" | "passthrough" | "raw-enter";

export interface EnterKeySettings {
	newlineKey: NewlineKey;
	submitKey: SubmitKey;
}

/**
 * 分類済みの Enter と設定から動作を決める。
 * - 修飾つき（`enter` 以外）で `newlineKey` に一致 → `newline`（`\x1b\r` を送る）
 * - `newlineKey === 'enter'` で `submitKey` に一致 → `submit`
 * - 無修飾 Enter で `newlineKey !== 'enter'` → `submit`
 * - 無修飾 Enter で `newlineKey === 'enter'` → `raw-enter`（`\r` を送る。keybindings.json 側で改行になる）
 * - それ以外 → `passthrough`（xterm の既定に任せる）
 */
export function resolveEnterAction(cls: EnterClass, settings: EnterKeySettings): EnterAction {
	if (cls === "passthrough") {
		return "passthrough";
	}
	if (cls !== "enter" && cls === settings.newlineKey) {
		return "newline";
	}
	if (settings.newlineKey === "enter" && cls === settings.submitKey) {
		return "submit";
	}
	if (cls === "enter" && settings.newlineKey !== "enter") {
		return "submit";
	}
	if (cls === "enter" && settings.newlineKey === "enter") {
		return "raw-enter";
	}
	return "passthrough";
}
