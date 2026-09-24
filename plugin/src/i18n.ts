// 表示言語（D-56・§6.9）。`obsidian` には依存しない（`settings.ts` と同じ理由：純粋なデータ・
// 関数だけを import するテストでも解決に失敗しない）。既定は自動——設定の `language` が
// `auto` なら Obsidian の言語（`window.localStorage.getItem("language")`）に合わせ、`ja` 以外は
// 英語にする。`t()` はモジュール内に持つ現在値を読むだけの純関数。

export type Lang = "ja" | "en";
export type LanguageSetting = "auto" | Lang;

let currentLang: Lang = "en";

/** 表示言語を切り替える。`main.ts` の `onload`（最初）と、設定の言語を変えたときに呼ぶ。 */
export function setLang(lang: Lang): void {
	currentLang = lang;
}

/** 今の表示言語（テスト・`limits.ts` の純関数などから参照する）。 */
export function getLang(): Lang {
	return currentLang;
}

/**
 * 設定の `language` と Obsidian の言語から、実際の表示言語を決める。
 * `auto` は `obsidianLang === 'ja'` なら日本語、それ以外（`null` を含む）は英語。
 */
export function resolveLang(setting: LanguageSetting, obsidianLang: string | null): Lang {
	if (setting === "ja" || setting === "en") {
		return setting;
	}
	return obsidianLang === "ja" ? "ja" : "en";
}

/**
 * Obsidian の言語設定。`window.localStorage` が無い・読めない環境（テストなど）では `null`。
 * `resolveLang` へ渡す値はここから取る（`resolveLang` 自体は注入された値だけを見る純関数）。
 */
export function readObsidianLang(): string | null {
	try {
		return window.localStorage.getItem("language");
	} catch {
		return null;
	}
}

// ---- 辞書 ---------------------------------------------------------------------
//
// `en` は `Record<MessageKey, string>` で宣言する（オブジェクトリテラルの過不足プロパティ
// 検査により、`ja` と同じキー集合を型で強制する）。

const ja = {
	// ---- コマンド・アクション（共通の文言。main.ts のコマンド名・action・ツールチップから使う） ----
	"action.openSidePanel": "一覧を開く",
	"action.newSession": "新規セッション",
	"action.sessionManager": "セッションマネージャー",
	"action.insertNoteAt": "現在のノートを @ で挿入",
	"action.more": "その他",
	"action.rescan": "再走査",
	"action.openSettings": "設定を開く",
	"action.rename": "名前を変更",
	"action.compact": "セッションを圧縮",
	"action.archive": "アーカイブ",
	"action.unarchive": "アーカイブ解除",
	"action.endSession": "セッションを終了",
	"action.usage": "セッション解析結果",
	"action.showUsage": "セッション解析結果を表示",
	"action.copyId": "ID をコピー",
	"action.prevInstruction": "前の指示",
	"action.nextInstruction": "次の指示",
	"action.lastResponse": "最後の応答",
	"action.scrollUp": "1 画面上へ",
	"action.scrollDown": "1 画面下へ",
	"action.scrollBottom": "最下部へ",
	"action.resume": "再開",
	"action.startFresh": "新規として開始",
	"action.close": "閉じる",
	"action.retry": "再試行",
	"action.reconnect": "再接続",
	"action.showArchived": "アーカイブを表示",
	"action.cancel": "キャンセル",
	"action.start": "開始",
	"action.change": "変更",
	"action.send": "送る（{key}）",
	"action.backToInput": "入力欄に戻る（Esc）",
	"action.matchFile": "ファイルに合わせる",
	"action.write": "書き込む",
	"action.copy": "コピー",

	// ---- 汎用 ----
	"common.default": "デフォルト",
	"common.none": "（無し）",
	"common.unknown": "不明",
	"common.listSep": "、",
	"common.untitled": "無題 {id}",

	// ---- Notice・エラー（main.ts・terminal.ts） ----
	"notice.noActiveNote": "開いているノートがありません",
	"notice.noActiveTerminal": "開いているターミナルがありません",
	"notice.renameWaitFailed": "セッションの起動を待てなかったため、名前を付けられませんでした",
	"notice.renameFailed": "名前の変更に失敗しました: {error}",
	"progress.renaming": "名前を変更しています…",
	"notice.compactAlready": "直近の指示が /compact のため、圧縮は送りません",
	"progress.compacting": "セッションを圧縮しています…",
	"notice.compactFailed": "圧縮に失敗しました: {error}",
	"progress.sending": "送信しています…",
	"error.attachFailed": "attach に失敗: {error}",
	"error.sessionNotFound": "セッションが見つかりません",
	"error.startFailed": "start に失敗: {error}",
	"error.claudeStartWaitFailed": "claude の起動を待てませんでした",
	"error.replyWaitFailed": "応答を待てませんでした",
	"confirm.endSession.message": "このセッションを終了しますか？",
	"notice.endFailed": "終了に失敗しました: {error}",
	"notice.waitingForInput": "{name}：指示待ち",
	"notice.storeLocked": "sessions.json のロックが取れません。少し待って再試行してください",
	"notice.storeUpdateFailed": "sessions.json の更新に失敗しました: {error}",
	"notice.scanFailed": "一覧の走査に失敗しました: {message}",
	"notice.idCopied": "ID をコピーしました",
	"notice.matchedKeybindings": "keybindings.json に合わせました",
	"notice.markdownCopied": "Markdown をコピーしました",
	"error.claudeMissing": "claude が見つからない",

	// ---- 設定タブ（main.ts） ----
	"settings.font.name": "フォント",
	"settings.fontSize.name": "フォントサイズ",
	"settings.padding.name": "余白",
	"settings.padding.comfortable": "ゆったり",
	"settings.padding.compact": "コンパクト",
	"settings.padding.none": "なし",
	"settings.recentCount.name": "最近の件数（サイドパネル）",
	"settings.notifyOnIdle.name": "指示待ちの通知",
	"settings.claudePath.name": "claude のパス",
	"settings.claudePath.desc": "空欄時のデフォルト: $(which claude)",
	"settings.agentSessionsPath.name": "agent-sessions のパス",
	"settings.agentSessionsPath.desc": "空欄時のデフォルト: ~/bin/agent-sessions",
	"settings.pythonPath.name": "Python のパス",
	"settings.pythonPath.desc": "空欄時のデフォルト: $(which python3)",
	"settings.editorHeight.name": "編集領域の高さ（%）",
	"settings.editorHeight.desc": "Ctrl+G で開く内蔵エディタの高さ",
	"settings.scrollback.name": "スクロールバック行数",
	"settings.language.name": "言語",
	"settings.language.optionAuto": "自動",
	"settings.language.optionJa": "日本語",
	"settings.language.optionEn": "English",
	"settings.submitKey.name": "送信キー",
	"settings.submitKey.desc":
		"Enter 以外を選ぶと、Enter は改行になります。そのため ~/.claude/keybindings.json に書き込みます（他のターミナルアプリで起動した claude にも効きます）",
	"settings.submitKey.currentUnreadable": "現在の keybindings.json：{path} が読めません",
	"settings.submitKey.currentCustom": "現在の keybindings.json の Chat の enter：{raw}",
	"settings.submitKey.currentNewline": "現在の keybindings.json の Chat の enter：chat:newline",
	"settings.submitKey.currentSubmit": "現在の keybindings.json の Chat の enter：既定（未設定、または chat:submit）",
	"confirm.writeKeybindings.message":
		"Enter を改行にするため、Claude Code の keybindings.json に書きます。他のターミナルアプリで起動した claude にも効きます",
	"settings.submitKeyMismatch.name": "keybindings.json と食い違っています",
	"settings.submitKeyMismatch.desc": "Claude Code の keybindings.json と一致していません",

	// ---- モーダル（modals.ts） ----
	"modal.newSession.title": "新規セッション",
	"modal.newSession.nameField": "名前",
	"modal.renameSession.title": "名前を変更",

	// ---- サイドパネル（views/side.ts） ----
	"section.openTabs": "開いているタブ",
	"section.running": "起動中",
	"section.recent": "最近",

	// ---- アテンションの印（サイドのバッジ・マネージャーの見出し。T-78） ----
	"attention.asking": "入力待ち {count}",
	"attention.waiting": "未読 {count}",
	"attention.askingInGroup": "入力待ちのセッションがあります",
	"attention.waitingInGroup": "未読のセッションがあります",

	// ---- マネージャー（views/manager.ts・manager-model.ts） ----
	"table.name": "名前",
	"table.updated": "最終更新",
	"table.model": "モデル",
	"table.effort": "エフォート",
	"table.folder": "フォルダ",
	"stats.fiveHour": "5 時間枠",
	"stats.sevenDay": "7 日枠",
	"stats.resetsIn": "リセットまで {countdown}",
	"stats.metric.cost": "コスト",
	"stats.metric.costTip": "この枠内の合計コスト",
	"stats.metric.tokens": "トークン",
	"stats.metric.tokensTip": "入力＋出力＋cache 読出＋cache 作成（この枠内）",
	"stats.metric.calls": "呼出",
	"stats.metric.callsTip": "この枠内の呼出回数",
	"stats.metric.sessions": "セッション",
	"stats.metric.sessionsTip": "この枠内で動いたセッション数",
	"stats.categoryBar.title": "カテゴリ別（7 日枠）",
	"stats.categoryBar.empty": "この枠の使用はありません",
	"stats.pace.unknown": "使用率が分かりません",
	"stats.pace.tooEarly": "判定には経過が足りません",
	"stats.pace.onTrack": "順調 — このペースで枠の終わりに約 {pct}",
	"stats.pace.overPace": "このペースでは {when} に使い切ります（リセットの {days} 日 {hours} 時間前）",
	"stats.pace.overPaceGuide": "残り 1 日あたり {pct} 以下（約 {cost}／日）",
	"stats.pace.overPaceGuideNoCost": "残り 1 日あたり {pct} 以下",
	"stats.pace.tooltip": "経過 {elapsedPct}%・使用 {usedPct}%",
	"category.other": "その他",
	"toolbar.filterPlaceholder": "絞込",
	"group.archived": "アーカイブ（{count}）",
	"group.other": "その他",
	"manager.analysis.title": "解析",

	// ---- 詳細ビュー（views/detail.ts） ----
	"detail.compacted": "compact 済み",
	"detail.totalTokens": "総トークン",
	"detail.totalCost": "総コスト",
	"detail.lastUser": "直近の指示",
	"detail.lastAssistant": "直近の応答",
	"detail.tools": "ツール",
	"detail.folder": "フォルダ",

	// ---- 制限ビュー（views/limits.ts） ----
	"limits.countdownDays": "{days} 日 {h}:{mm}",

	// ---- 編集領域（views/editor-pane.ts） ----
	// action.send・action.backToInput を使う。

	// ---- ターミナル終了画面（views/terminal.ts） ----
	"exit.exited": "セッションは終了しました（{code}）",
	"exit.disconnected": "デーモンとの接続が切れました",

	// ---- タブ・行の状態（views/terminal.ts の `terminalStatus`。D-66） ----
	"status.connecting": "接続中",
	"status.working": "処理中",
	"status.runningShell": "コマンド実行中",
	// claude 自身の質問・許可プロンプト・elicitation 待ち（T-77）。「指示待ち」（waiting）より上。
	"status.asking": "回答待ち",
	"status.waiting": "指示待ち",
	// compact 直後・まだ次の指示を送っていない（T-77 追補）。「指示待ち」より下——文脈が
	// リセットされていることが分かるように別の状態にする。
	"status.compacted": "compact 済み（文脈がリセットされています）",
	"status.editing": "編集中",
	"status.idle": "待機",
	"status.detached": "未接続",
	"status.exited": "終了",
	"status.error": "エラー",

	// ---- セッション解析結果モーダル（usage-modal.ts） ----
	"usage.title": "セッション解析結果：{name}",
	"usage.loading": "読み込み中…",
	"usage.loadFailed": "集計に失敗しました: {error}",
	"usage.col.time": "時刻",
	"usage.col.prompt": "指示",
	"usage.col.input": "入力",
	"usage.col.output": "出力",
	"usage.col.cost": "コスト",
	"usage.emptyPrompt": "（空）",
	"usage.whole": "全体",
	"usage.rangePending": "#{from}〜（終了行をクリック）",
	"usage.range": "#{from}〜#{to}",
	"usage.card.estimated": "概算",
	"usage.card.tokens": "トークン",
	"usage.card.outputSub": "出力 {output}",
	"usage.card.turns": "ターン数",
	"usage.card.duration": "期間",
	"usage.chart.input": "入力",
	"usage.chart.uncached": "非キャッシュ",
	"usage.chart.cacheRead": "cache 読出",
	"usage.chart.cacheCreate": "cache 作成",
	"usage.chart.output": "出力",
	"usage.chart.toolsTitle": "ツール使用",
	"usage.chart.toolsEmpty": "ツール使用なし",

	// ---- Markdown コピー（usage.ts の toMarkdown） ----
	"usage.md.title": "# セッション解析結果（#{lo}〜#{hi}）",
	"usage.md.cost": "- コスト: {cost}{estimated}",
	"usage.md.estimatedSuffix": "（概算）",
	"usage.md.tokens": "- トークン: 入力 {input}・出力 {output}",
	"usage.md.turns": "- ターン数: {count}",
	"usage.md.duration": "- 期間: {duration}",
	"usage.md.tableHeader": "| # | 時刻 | 指示 | 入力 | 出力 | コスト |",

	// ---- keybindings.ts ----
	"error.keybindingsUnreadable": "{path} が読めません。手で直す必要があります",
	"warning.manualFix": "手で直す必要があります（{keys} が想定と違う値のまま残っています）",

	// ---- store.ts ----
	"error.lockFailed": "ロックが取れない: {path}",

	// ---- daemon-client.ts ----
	"error.unknownFrameKind": "不明なフレーム種別: 0x{hex}",
	"error.socketClosed": "ソケットが閉じた",
	"error.notConnected": "デーモンに未接続",
	"error.agentSessionsNotFound": "agent-sessions が見つからない: {path}",
	"error.daemonUnavailable": "デーモンに接続できない。Python が無いか、ソケットが作れない可能性がある。",
} as const;

export type MessageKey = keyof typeof ja;

const en: Record<MessageKey, string> = {
	"action.openSidePanel": "Open session list",
	"action.newSession": "New session",
	"action.sessionManager": "Session manager",
	"action.insertNoteAt": "Insert current note with @",
	"action.more": "More",
	"action.rescan": "Rescan",
	"action.openSettings": "Open settings",
	"action.rename": "Rename",
	"action.compact": "Compact session",
	"action.archive": "Archive",
	"action.unarchive": "Remove from archive",
	"action.endSession": "End session",
	"action.usage": "Session analytics",
	"action.showUsage": "Show session analytics",
	"action.copyId": "Copy ID",
	"action.prevInstruction": "Previous instruction",
	"action.nextInstruction": "Next instruction",
	"action.lastResponse": "Last response",
	"action.scrollUp": "Scroll up one screen",
	"action.scrollDown": "Scroll down one screen",
	"action.scrollBottom": "Scroll to bottom",
	"action.resume": "Resume",
	"action.startFresh": "Start as new",
	"action.close": "Close",
	"action.retry": "Retry",
	"action.reconnect": "Reconnect",
	"action.showArchived": "Show archive",
	"action.cancel": "Cancel",
	"action.start": "Start",
	"action.change": "Rename",
	"action.send": "Send ({key})",
	"action.backToInput": "Back to prompt (Esc)",
	"action.matchFile": "Match the file",
	"action.write": "Write",
	"action.copy": "Copy",

	"common.default": "Default",
	"common.none": "(none)",
	"common.unknown": "Unknown",
	"common.listSep": ", ",
	"common.untitled": "Untitled {id}",

	"notice.noActiveNote": "No note is open",
	"notice.noActiveTerminal": "No terminal tab is open",
	"notice.renameWaitFailed": "Couldn't wait for the session to start, so it wasn't named",
	"notice.renameFailed": "Failed to rename: {error}",
	"progress.renaming": "Renaming…",
	"notice.compactAlready": "The last instruction was /compact, so nothing was sent",
	"progress.compacting": "Compacting session…",
	"notice.compactFailed": "Failed to compact: {error}",
	"progress.sending": "Sending…",
	"error.attachFailed": "attach failed: {error}",
	"error.sessionNotFound": "Session not found",
	"error.startFailed": "start failed: {error}",
	"error.claudeStartWaitFailed": "Timed out waiting for claude to start",
	"error.replyWaitFailed": "Timed out waiting for a reply",
	"confirm.endSession.message": "End this session?",
	"notice.endFailed": "Failed to end: {error}",
	"notice.waitingForInput": "{name}: waiting for input",
	"notice.storeLocked": "Couldn't lock sessions.json. Wait a moment and try again",
	"notice.storeUpdateFailed": "Failed to update sessions.json: {error}",
	"notice.scanFailed": "Failed to scan sessions: {message}",
	"notice.idCopied": "Copied the ID",
	"notice.matchedKeybindings": "Matched keybindings.json",
	"notice.markdownCopied": "Copied the Markdown",
	"error.claudeMissing": "claude was not found",

	"settings.font.name": "Font",
	"settings.fontSize.name": "Font size",
	"settings.padding.name": "Padding",
	"settings.padding.comfortable": "Comfortable",
	"settings.padding.compact": "Compact",
	"settings.padding.none": "None",
	"settings.recentCount.name": "Recent count (side panel)",
	"settings.notifyOnIdle.name": "Notify when waiting for input",
	"settings.claudePath.name": "Path to claude",
	"settings.claudePath.desc": "Default when empty: $(which claude)",
	"settings.agentSessionsPath.name": "Path to agent-sessions",
	"settings.agentSessionsPath.desc": "Default when empty: ~/bin/agent-sessions",
	"settings.pythonPath.name": "Path to Python",
	"settings.pythonPath.desc": "Default when empty: $(which python3)",
	"settings.editorHeight.name": "Editor pane height (%)",
	"settings.editorHeight.desc": "Height of the built-in editor opened with Ctrl+G",
	"settings.scrollback.name": "Scrollback lines",
	"settings.language.name": "Language",
	"settings.language.optionAuto": "Auto",
	"settings.language.optionJa": "Japanese",
	"settings.language.optionEn": "English",
	"settings.submitKey.name": "Submit key",
	"settings.submitKey.desc":
		"Choosing anything other than Enter makes Enter insert a newline instead. This writes to ~/.claude/keybindings.json (it also affects claude started from other terminal apps).",
	"settings.submitKey.currentUnreadable": "Current keybindings.json: can't read {path}",
	"settings.submitKey.currentCustom": "Current keybindings.json Chat enter: {raw}",
	"settings.submitKey.currentNewline": "Current keybindings.json Chat enter: chat:newline",
	"settings.submitKey.currentSubmit": "Current keybindings.json Chat enter: default (unset, or chat:submit)",
	"confirm.writeKeybindings.message":
		"This writes to Claude Code's keybindings.json to make Enter insert a newline. It also affects claude started from other terminal apps.",
	"settings.submitKeyMismatch.name": "Doesn't match keybindings.json",
	"settings.submitKeyMismatch.desc": "Doesn't match Claude Code's keybindings.json",

	"modal.newSession.title": "New session",
	"modal.newSession.nameField": "Name",
	"modal.renameSession.title": "Rename",

	"section.openTabs": "Open tabs",
	"section.running": "Running",
	"section.recent": "Recent",

	"attention.asking": "Needs input {count}",
	"attention.waiting": "Unread {count}",
	"attention.askingInGroup": "Has a session waiting for input",
	"attention.waitingInGroup": "Has an unread session",

	"table.name": "Name",
	"table.updated": "Last updated",
	"table.model": "Model",
	"table.effort": "Effort",
	"table.folder": "Folder",
	"stats.fiveHour": "5-hour window",
	"stats.sevenDay": "7-day window",
	"stats.resetsIn": "resets in {countdown}",
	"stats.metric.cost": "Cost",
	"stats.metric.costTip": "Total cost within this window",
	"stats.metric.tokens": "Tokens",
	"stats.metric.tokensTip": "Input + output + cache read + cache create (within this window)",
	"stats.metric.calls": "Calls",
	"stats.metric.callsTip": "Number of calls within this window",
	"stats.metric.sessions": "Sessions",
	"stats.metric.sessionsTip": "Number of sessions active within this window",
	"stats.categoryBar.title": "By category (7-day window)",
	"stats.categoryBar.empty": "No usage in this window",
	"stats.pace.unknown": "Usage percentage unavailable",
	"stats.pace.tooEarly": "Not enough elapsed time to judge yet",
	"stats.pace.onTrack": "On track — about {pct} by the end of the window at this pace",
	"stats.pace.overPace": "At this pace you'll run out {when} ({days}d {hours}h before reset)",
	"stats.pace.overPaceGuide": "Stay under {pct} per remaining day (about {cost}/day)",
	"stats.pace.overPaceGuideNoCost": "Stay under {pct} per remaining day",
	"stats.pace.tooltip": "{elapsedPct}% elapsed · {usedPct}% used",
	"category.other": "Other",
	"toolbar.filterPlaceholder": "Filter",
	"group.archived": "Archive ({count})",
	"group.other": "Other",
	"manager.analysis.title": "Analysis",

	"detail.compacted": "Compacted",
	"detail.totalTokens": "Total tokens",
	"detail.totalCost": "Total cost",
	"detail.lastUser": "Last instruction",
	"detail.lastAssistant": "Last reply",
	"detail.tools": "Tools",
	"detail.folder": "Folder",

	"limits.countdownDays": "{days}d {h}:{mm}",

	"exit.exited": "The session has ended ({code})",
	"exit.disconnected": "Disconnected from the daemon",

	"status.connecting": "Connecting",
	"status.working": "Working",
	"status.runningShell": "Running a command",
	"status.asking": "Waiting for your answer",
	"status.waiting": "Waiting for input",
	"status.compacted": "Compacted (context was reset)",
	"status.editing": "Editing",
	"status.idle": "Idle",
	"status.detached": "Not connected",
	"status.exited": "Exited",
	"status.error": "Error",

	"usage.title": "Session analytics: {name}",
	"usage.loading": "Loading…",
	"usage.loadFailed": "Failed to load: {error}",
	"usage.col.time": "Time",
	"usage.col.prompt": "Prompt",
	"usage.col.input": "Input",
	"usage.col.output": "Output",
	"usage.col.cost": "Cost",
	"usage.emptyPrompt": "(empty)",
	"usage.whole": "Whole",
	"usage.rangePending": "#{from}– (click the end row)",
	"usage.range": "#{from}–#{to}",
	"usage.card.estimated": "estimated",
	"usage.card.tokens": "Tokens",
	"usage.card.outputSub": "output {output}",
	"usage.card.turns": "Turns",
	"usage.card.duration": "Duration",
	"usage.chart.input": "Input",
	"usage.chart.uncached": "uncached",
	"usage.chart.cacheRead": "cache read",
	"usage.chart.cacheCreate": "cache create",
	"usage.chart.output": "Output",
	"usage.chart.toolsTitle": "Tool use",
	"usage.chart.toolsEmpty": "No tool use",

	"usage.md.title": "# Session analytics (#{lo}–#{hi})",
	"usage.md.cost": "- Cost: {cost}{estimated}",
	"usage.md.estimatedSuffix": " (estimated)",
	"usage.md.tokens": "- Tokens: input {input}, output {output}",
	"usage.md.turns": "- Turns: {count}",
	"usage.md.duration": "- Duration: {duration}",
	"usage.md.tableHeader": "| # | Time | Prompt | Input | Output | Cost |",

	"error.keybindingsUnreadable": "Can't read {path}. You'll need to fix it by hand",
	"warning.manualFix": "You'll need to fix it by hand ({keys} still has an unexpected value)",

	"error.lockFailed": "Couldn't get the lock: {path}",

	"error.unknownFrameKind": "Unknown frame kind: 0x{hex}",
	"error.socketClosed": "The socket closed",
	"error.notConnected": "Not connected to the daemon",
	"error.agentSessionsNotFound": "agent-sessions was not found: {path}",
	"error.daemonUnavailable": "Can't connect to the daemon. Python may be missing, or the socket couldn't be created.",
};

const dict: Record<Lang, Record<MessageKey, string>> = { ja, en };

/** `key` の文字列。`vars` があれば `{name}` を置換する（無い名前はそのまま残す）。 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	const template = dict[currentLang][key];
	if (!vars) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
