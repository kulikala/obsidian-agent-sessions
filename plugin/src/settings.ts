// 設定の型と既定値（§6.9）。obsidian には依存しない（純粋なデータ定義）。

import type { LanguageSetting } from "./i18n";

export type Padding = "comfortable" | "compact" | "none";

/**
 * 送信キー（§6.8・D-50）。`enter` 以外を選ぶと Enter は改行になり、keybindings.json に書く。
 * `alt+enter` は Option+Enter、`cmd+enter` は Command+Enter。
 */
export type SubmitKey = "enter" | "shift+enter" | "ctrl+enter" | "alt+enter" | "cmd+enter";

export const SUBMIT_KEYS: readonly SubmitKey[] = ["enter", "shift+enter", "ctrl+enter", "alt+enter", "cmd+enter"];

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
	/** 送信キー（既定 enter）。起動時に keybindings.json から導き直す。 */
	submitKey: SubmitKey;
	/** サイドパネルの詳細領域の高さ（px、§6.9・D-43）。 */
	sideDetailHeight: number;
	/** 表示言語（§6.9・D-56）。既定は自動（Obsidian の言語に合わせる）。 */
	language: LanguageSetting;
	/** マネージャー下部・解析領域（統計の帯＋カテゴリ別バー）の高さ（px。T-70 追補）。 */
	managerAnalysisHeight: number;
	/** マネージャーの解析領域を畳んであるか（T-70 追補）。 */
	managerAnalysisCollapsed: boolean;
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
	submitKey: "enter",
	sideDetailHeight: 220,
	language: "auto",
	managerAnalysisHeight: 240,
	managerAnalysisCollapsed: false,
};

/**
 * 保存データを既定値に重ねる。廃止した `newlineKey` と、今の `SubmitKey` に無い旧 `submitKey`
 * （`super+enter`・`meta+enter` など）は捨てる（起動時に keybindings.json から導き直す。D-50）。
 */
export function mergeSettings(data: unknown): AgentSessionsSettings {
	const saved = (typeof data === "object" && data !== null ? { ...(data as Record<string, unknown>) } : {}) as Record<
		string,
		unknown
	>;
	delete saved.newlineKey;
	if (saved.language !== "auto" && saved.language !== "ja" && saved.language !== "en") {
		delete saved.language;
	}
	if (!SUBMIT_KEYS.includes(saved.submitKey as SubmitKey)) {
		delete saved.submitKey;
	}
	return Object.assign({}, DEFAULT_SETTINGS, saved) as AgentSessionsSettings;
}
