// 設定の型と既定値（§6.9）。obsidian には依存しない（純粋なデータ定義）。

export type Padding = "comfortable" | "compact" | "none";

/** 改行として送るキー（§6.8・D-41）。`enter` を選ぶと keybindings.json に書く。 */
export type NewlineKey = "enter" | "meta+enter" | "ctrl+enter" | "shift+enter" | "super+enter";

/** `newlineKey === 'enter'` のときに送信として使うキー。 */
export type SubmitKey = "meta+enter" | "ctrl+enter" | "shift+enter" | "super+enter";

export interface AgentSessionsSettings {
	fontFamily: string;
	fontSize: number;
	padding: Padding;
	recentCount: number;
	notifyOnIdle: boolean;
	claudePath: string;
	agentSessionsPath: string;
	pythonPath: string;
	scrollback: number;
	/** 編集領域の高さ（本体に対する %）。 */
	editorHeight: number;
	/** 改行として送るキー（既定 shift+enter）。 */
	newlineKey: NewlineKey;
	/** `newlineKey === 'enter'` のときの送信キー（既定 super+enter）。 */
	submitKey: SubmitKey;
	/** サイドパネルの詳細領域の高さ（px、§6.9・D-43）。 */
	sideDetailHeight: number;
}

export const DEFAULT_SETTINGS: AgentSessionsSettings = {
	fontFamily: 'Menlo, "Hiragino Sans", monospace',
	fontSize: 13,
	padding: "comfortable",
	recentCount: 10,
	notifyOnIdle: true,
	claudePath: "",
	agentSessionsPath: "",
	pythonPath: "",
	scrollback: 5000,
	editorHeight: 40,
	newlineKey: "shift+enter",
	submitKey: "super+enter",
	sideDetailHeight: 220,
};
