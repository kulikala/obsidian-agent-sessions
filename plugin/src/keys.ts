// Enter の分類と、送信キー設定からの動作決定（§6.8・D-50）。xterm にも obsidian にも
// 依存しない純関数。`views/terminal.ts` の `handleKey` と `views/editor-pane.ts` から使う。

import type { SubmitKey } from "./settings";

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

export type EnterClass = SubmitKey | "passthrough";

/**
 * Enter でなければ、または IME 変換中の Enter なら `passthrough`。
 * 修飾は shift・ctrl・alt・cmd（metaKey）・無し（enter）の優先順で 1 つに分類する。
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
 * 分類済みの Enter と送信キーから動作を決める。`passthrough` は IME 中と Enter 以外だけで、
 * Enter の組合せは必ず `submit` か `newline` になる（ターミナルが修飾を区別して送れないため、
 * プラグインがすべて横取りする）。
 */
export function resolveEnterAction(cls: EnterClass, submitKey: SubmitKey): EnterAction {
	if (cls === "passthrough") {
		return "passthrough";
	}
	return cls === submitKey ? "submit" : "newline";
}

/**
 * 動作ごとに PTY へ送る列。`submitKey === 'enter'` なら Claude Code の既定どおり
 * 送信＝`\r`・改行＝`\x1b\r`。それ以外は keybindings.json で逆にしてあるので
 * 送信＝`\x1b\r`（meta+enter）・改行＝`\r`。
 */
export function sendSequence(action: "submit" | "newline", submitKey: SubmitKey): string {
	const swapped = submitKey !== "enter";
	if (action === "submit") {
		return swapped ? "\x1b\r" : "\r";
	}
	return swapped ? "\r" : "\x1b\r";
}

/**
 * `keybindings.json` の `Chat` の中身から送信キーを導く（D-50）。純関数——ファイルは
 * 呼び出し側が `readChatBindings` で読む。
 *
 * - `enter: chat:newline` があり、`cmd+enter`／`super+enter` もあれば `cmd+enter`、無ければ `alt+enter`。
 * - `enter` が無い、または `chat:newline` 以外なら `enter`。
 */
export function deriveSubmitKey(chatBindings: Record<string, string> | undefined): SubmitKey {
	if (chatBindings?.enter !== "chat:newline") {
		return "enter";
	}
	return "cmd+enter" in chatBindings || "super+enter" in chatBindings ? "cmd+enter" : "alt+enter";
}

/** 「送る」ボタンなどに出す送信キーの記号。 */
export const SUBMIT_KEY_SYMBOLS: Record<SubmitKey, string> = {
	enter: "⏎",
	"shift+enter": "⇧⏎",
	"ctrl+enter": "⌃⏎",
	"alt+enter": "⌥⏎",
	"cmd+enter": "⌘⏎",
};

/**
 * 起動時・「ファイルに合わせる」で使う送信キー（D-50）。keybindings.json が Enter を改行に
 * しているかどうか（`deriveSubmitKey` が `enter` か否か）が今の設定と合っていれば今の設定を
 * 保ち（`shift+enter`／`ctrl+enter` はファイルから区別できない）、食い違っていれば導いた値にする。
 */
export function reconcileSubmitKey(chatBindings: Record<string, string> | undefined, current: SubmitKey): SubmitKey {
	const derived = deriveSubmitKey(chatBindings);
	return (derived === "enter") === (current === "enter") ? current : derived;
}
