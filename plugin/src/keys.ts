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

/**
 * `keybindings.json` の `Chat` の中身から、設定（`newlineKey`／`submitKey`）を導く
 * （§6.8・D-41 追補）。ユーザーが手で（または他のツールで）`keybindings.json` を書いた
 * 場合に、プラグインの設定をそれに合わせて自動で追随させるために使う。純関数——
 * `keybindings.json` 自体は読み書きしない（呼び出し側が `readChatBindings` で読み、
 * 結果が非 `null` のときだけ設定に反映する）。
 *
 * - `Chat.enter === 'chat:newline'`：`newlineKey` を `'enter'` に。`submitKey` は
 *   `cmd+enter`／`super+enter` があれば `super+enter`、無く `meta+enter` があれば
 *   `meta+enter`、どちらも無ければ既定（`super+enter`）。
 * - それ以外（`enter` が無い、または `chat:submit`）：現在の設定が `newlineKey === 'enter'`
 *   なら既定の `shift+enter` に戻す（`submitKey` はそのまま）。
 * - 結果が現在の設定と同じなら（変更不要）`null`。
 */
export function deriveKeysFromKeybindings(
	chatBindings: Record<string, string> | undefined,
	settings: EnterKeySettings
): EnterKeySettings | null {
	const isNewlineMode = chatBindings?.enter === "chat:newline";

	if (isNewlineMode) {
		const hasSuper = "cmd+enter" in chatBindings || "super+enter" in chatBindings;
		const submitKey: SubmitKey = hasSuper ? "super+enter" : "meta+enter" in chatBindings ? "meta+enter" : "super+enter";
		if (settings.newlineKey === "enter" && settings.submitKey === submitKey) {
			return null;
		}
		return { newlineKey: "enter", submitKey };
	}

	if (settings.newlineKey === "enter") {
		return { newlineKey: "shift+enter", submitKey: settings.submitKey };
	}
	return null;
}
