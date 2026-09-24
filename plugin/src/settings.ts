// 設定の型と既定値（§6.9）。obsidian には依存しない（純粋なデータ定義）。

import type { LanguageSetting } from "./i18n";

export type Padding = "comfortable" | "compact" | "none";

/**
 * 送信キー（§6.8・D-50）。`enter` 以外を選ぶと Enter は改行になり、keybindings.json に書く。
 * `alt+enter` は Option+Enter、`cmd+enter` は Command+Enter。
 */
export type SubmitKey = "enter" | "shift+enter" | "ctrl+enter" | "alt+enter" | "cmd+enter";

export const SUBMIT_KEYS: readonly SubmitKey[] = ["enter", "shift+enter", "ctrl+enter", "alt+enter", "cmd+enter"];

/**
 * 非 macOS の送信キーの選択肢（§6.9 非macOS対応）。`cmd+enter`（Command＝非 macOS では Super）は
 * ブラウザに安定して届かない（ウィンドウマネージャに奪われうる）ので出さない。
 */
export const SUBMIT_KEYS_NON_MAC: readonly SubmitKey[] = ["enter", "shift+enter", "ctrl+enter", "alt+enter"];

const FONT_FAMILY_MAC = 'Menlo, "Hiragino Sans", monospace';
/** Menlo は Linux に無いので、非 macOS は幅の揃う等幅フォント＋CJK フォールバックにする。 */
const FONT_FAMILY_NON_MAC = '"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace';

/** 既定のフォント（§6.9 非macOS対応。§15）。 */
export function defaultFontFamily(isMac: boolean): string {
	return isMac ? FONT_FAMILY_MAC : FONT_FAMILY_NON_MAC;
}

export interface AgentSessionsSettings {
	fontFamily: string;
	fontSize: number;
	padding: Padding;
	recentCount: number;
	notifyOnIdle: boolean;
	claudePath: string;
	agentSessionsPath: string;
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
	fontFamily: FONT_FAMILY_MAC,
	fontSize: 13,
	padding: "comfortable",
	recentCount: 10,
	notifyOnIdle: true,
	claudePath: "",
	agentSessionsPath: "",
	scrollback: 5000,
	editorHeight: 40,
	submitKey: "enter",
	sideDetailHeight: 220,
	language: "auto",
	managerAnalysisHeight: 240,
	managerAnalysisCollapsed: false,
};

/**
 * 保存データを既定値に重ねる。今の型に無いキー（`newlineKey`）や、今の `SubmitKey` に
 * 無い値（`super+enter`・`meta+enter` など）が保存データに残っていても捨てる
 * （起動時に keybindings.json から導き直す。D-50）。
 *
 * `isMac`（既定 `true`）は非 macOS 対応（§6.9・§15）：非 macOS では選択肢に無い
 * `cmd+enter` が保存データに残っていても捨て（既定 `enter` に戻る）、`fontFamily` が
 * 保存データに無いとき（新規インストール）だけ非 macOS 向けの既定フォントを使う——
 * 一度でも保存された `fontFamily` はプラットフォームが変わっても書き換えない。
 */
export function mergeSettings(data: unknown, isMac = true): AgentSessionsSettings {
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
	if (!isMac && saved.submitKey === "cmd+enter") {
		delete saved.submitKey;
	}
	const defaults = isMac ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, fontFamily: defaultFontFamily(false) };
	return Object.assign({}, defaults, saved) as AgentSessionsSettings;
}
