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

/** 「送る」ボタンなどに出す送信キーの記号（macOS）。 */
export const SUBMIT_KEY_SYMBOLS: Record<SubmitKey, string> = {
	enter: "⏎",
	"shift+enter": "⇧⏎",
	"ctrl+enter": "⌃⏎",
	"alt+enter": "⌥⏎",
	"cmd+enter": "⌘⏎",
};

/**
 * 非 macOS の「送る」ボタン表記（文字表記。§7.2 非macOS対応）。`cmd+enter` は非 macOS の
 * 選択肢に出さないので持たない——`submitKeyButtonLabel`／`submitKeyStatuslineSymbol` は
 * その場合 macOS の記号にフォールバックする。
 */
export const SUBMIT_KEY_LABELS_NON_MAC: Partial<Record<SubmitKey, string>> = {
	enter: "Enter",
	"shift+enter": "Shift+Enter",
	"ctrl+enter": "Ctrl+Enter",
	"alt+enter": "Alt+Enter",
};

/** 非 macOS の statusLine 用の短い記号（ui.json の `submitSymbol`。§14 非macOS対応）。 */
export const SUBMIT_KEY_STATUSLINE_SYMBOLS_NON_MAC: Partial<Record<SubmitKey, string>> = {
	enter: "⏎",
	"shift+enter": "S-⏎",
	"ctrl+enter": "C-⏎",
	"alt+enter": "A-⏎",
};

/** 「送る」ボタン・内蔵エディタの表記。macOS は記号、非 macOS は文字表記。 */
export function submitKeyButtonLabel(key: SubmitKey, isMac: boolean): string {
	if (isMac) {
		return SUBMIT_KEY_SYMBOLS[key];
	}
	return SUBMIT_KEY_LABELS_NON_MAC[key] ?? SUBMIT_KEY_SYMBOLS[key];
}

/** statusLine（ui.json の `submitSymbol`）の表記。macOS は記号、非 macOS は短い文字表記。 */
export function submitKeyStatuslineSymbol(key: SubmitKey, isMac: boolean): string {
	if (isMac) {
		return SUBMIT_KEY_SYMBOLS[key];
	}
	return SUBMIT_KEY_STATUSLINE_SYMBOLS_NON_MAC[key] ?? SUBMIT_KEY_SYMBOLS[key];
}

/**
 * 起動時・「ファイルに合わせる」で使う送信キー（D-50）。keybindings.json が Enter を改行に
 * しているかどうか（`deriveSubmitKey` が `enter` か否か）が今の設定と合っていれば今の設定を
 * 保ち（`shift+enter`／`ctrl+enter` はファイルから区別できない）、食い違っていれば導いた値にする。
 */
export function reconcileSubmitKey(chatBindings: Record<string, string> | undefined, current: SubmitKey): SubmitKey {
	const derived = deriveSubmitKey(chatBindings);
	return (derived === "enter") === (current === "enter") ? current : derived;
}

/**
 * 非 macOS の Ctrl キーの行き先（§7.1 非macOS対応）。macOS は Cmd が Obsidian の修飾キーなので
 * Ctrl はすべてターミナルへ渡せるが、非 macOS は Obsidian の修飾キーが Ctrl で、claude も
 * Ctrl+C／D／G／R／O／S／L／T 等を使うため、単純に Ctrl を Obsidian へ渡すと壊れる。
 * 既定は `terminal`（claude を優先）。**素の Ctrl+W／Ctrl+P もターミナルへ**——claude の
 * 入力欄は Ctrl+W を「1 語削除」に、readline 系の履歴操作で Ctrl+P を使いうるため。
 * 代わりに Ctrl+Shift+W／Ctrl+Shift+P を Obsidian の対応する操作（タブを閉じる・コマンド
 * パレット）に当てる——Obsidian の既定のホットキーは素の Ctrl+W／Ctrl+P 側に付いているので、
 * ただキーイベントを渡す（`obsidian`）だけでは発火しない。呼出側（`views/terminal.ts`）が
 * `app.commands.executeCommandById("workspace:close")`／`("command-palette:open")` を
 * 明示的に呼ぶ（`close-tab`／`command-palette`）。
 * それ以外に Obsidian 側へ渡すのは：Ctrl+Shift+<key>（`copy`／`paste`／フォントサイズ／
 * `close-tab`／`command-palette` を除く）・Ctrl+Tab・Ctrl+,（Obsidian の既定のホットキーが
 * 素のまま付いているので、キーイベントを渡すだけで発火する）。
 * `ev.metaKey`／`ev.altKey` が立っている、または `ev.ctrlKey` が無ければ `passthrough`
 * （呼出側の既存の分岐に任せる）。IME 変換中の判定は呼出側が Enter 用に持つのでここでは見ない
 * （このキー群は IME の変換候補確定に使われないため）。
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
		// Ctrl+Shift+C／V：ターミナルの選択コピー・貼り付け（Linux の端末アプリの慣習）。
		if (key === "c" || key === "C") {
			return "copy";
		}
		if (key === "v" || key === "V") {
			return "paste";
		}
		// Ctrl+Shift+=／−／0：フォントサイズ（macOS の Cmd +／−／0 に相当）。
		if (key === "+" || key === "=") {
			return "zoom-in";
		}
		if (key === "_" || key === "-") {
			return "zoom-out";
		}
		if (key === "0" || key === ")") {
			return "zoom-reset";
		}
		// Ctrl+Shift+W／P：タブを閉じる・コマンドパレット（素の Ctrl+W／Ctrl+P はターミナルへ）。
		if (key === "w" || key === "W") {
			return "close-tab";
		}
		if (key === "p" || key === "P") {
			return "command-palette";
		}
		// それ以外の Ctrl+Shift+<key> は Obsidian へ（claude は Ctrl+Shift の組合せを使わない）。
		return "obsidian";
	}
	if (key === "Tab") {
		return "obsidian"; // タブ切替。
	}
	if (key === ",") {
		return "obsidian"; // 設定。
	}
	return "terminal"; // Ctrl+W／Ctrl+P を含む。claude の入力欄で使われうるため。
}
