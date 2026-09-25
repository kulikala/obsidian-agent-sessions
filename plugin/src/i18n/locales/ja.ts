import type { MessageKey } from "./en";

// Japanese strings. A key missing here falls back to `en` (`../index.ts`'s `t()`) — every key
// here happens to be filled in today, but a partial locale (e.g. one contributed for a single
// area of the UI) works the same way, key by key.
export const ja: Partial<Record<MessageKey, string>> = {
	// ---- Commands and actions (shared strings used by main.ts's command names, actions, tooltips) ----
	"action.openSidePanel": "一覧を開く",
	"action.newSession": "新規セッション",
	"action.sessionManager": "セッションマネージャー",
	"action.insertNoteAt": "現在のノートを @ で挿入",
	"action.more": "その他",
	"action.rescan": "再走査",
	"action.openSettings": "設定を開く",
	"action.rename": "名前を変更",
	"action.moveToCategory": "カテゴリに移動…",
	"action.move": "移動",
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
	"action.clickToRefresh": "クリックで最新に更新",

	// ---- Generic ----
	"common.default": "デフォルト",
	"common.none": "（無し）",
	"common.unknown": "不明",
	"common.listSep": "、",
	"common.untitled": "無題 {id}",

	// ---- Notices and errors (main.ts, terminal.ts) ----
	"notice.noActiveNote": "開いているノートがありません",
	"notice.noActiveTerminal": "開いているターミナルがありません",
	"notice.renameWaitFailed": "セッションの起動を待てなかったため、名前を付けられませんでした",
	"notice.renameAtCreateUnsupported": "このエージェントでは、作成時に名前を付けることはまだできません——起動してから名前を変更してください",
	"notice.needsOneAgentEnabled": "少なくとも1つのエージェントは有効にしてください",
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
	"notice.keybindingsWritten": "keybindings.json を書き換えました",
	"notice.keybindingsUnchanged": "keybindings.json は既にこの内容でした（書き換えなし）",
	"notice.markdownCopied": "Markdown をコピーしました",
	"error.agentMissing": "{name} が見つからない",

	// ---- Settings tab (main.ts) ----
	"settings.font.name": "フォント",
	"settings.fontSize.name": "フォントサイズ",
	"settings.padding.name": "余白",
	"settings.padding.comfortable": "ゆったり",
	"settings.padding.compact": "コンパクト",
	"settings.padding.none": "なし",
	"settings.recentCount.name": "最近の件数（サイドパネル）",
	"settings.notifyOnIdle.name": "指示待ちの通知",
	"settings.agents.heading": "エージェント",
	"settings.agents.desc": "起動できる CLI エージェントと、それぞれの見つけ方。",
	"settings.agents.claude.name": "Claude Code",
	"settings.agents.codex.name": "Codex",
	"settings.agents.path.name": "パス",
	"settings.agents.path.desc": "空欄 = 自動検出。",
	"settings.agents.env.name": "環境変数",
	"settings.agents.env.desc": "KEY=VALUE を1行ずつ。",
	"settings.agents.detect.name": "再検出",
	"settings.agents.detected.found": "検出: {path}",
	"settings.agents.detected.foundWithVersion": "検出: {path}（{version}）",
	"settings.agents.detected.notFound": "未検出。",
	"settings.agents.detected.enable": "有効にする",
	"settings.agentSessionsPath.name": "agent-sessions のパス",
	"settings.agentSessionsPath.desc": "空欄時のデフォルト: ~/bin/agent-sessions",
	"settings.editorHeight.name": "編集領域の高さ（%）",
	"settings.editorHeight.desc": "Ctrl+G で開く内蔵エディタの高さ",
	"settings.scrollback.name": "スクロールバック行数",
	"settings.language.name": "言語",
	"settings.language.optionAuto": "自動",
	"settings.submitKey.name": "送信キー",
	"settings.submitKey.desc":
		"Enter 以外を選ぶと、Enter は改行になります。そのため ~/.claude/keybindings.json に書き込みます（他のターミナルアプリで起動した claude にも効きます）。ただし、選んだキーが確実に働くのはこのプラグイン自身のターミナルタブだけです——Enter の全組み合わせを自前で横取りし、どの修飾キーでも「送信」には同じバイト列を送るためです。Obsidian の外のターミナルアプリでは、Ctrl+Enter や Cmd+Enter がそもそも素の Enter と区別できるかはターミナル次第で、多くは区別できず素の Enter として届きます。",
	"settings.submitKey.currentUnreadable": "現在の keybindings.json：{path} が読めません",
	"settings.submitKey.currentCustom": "現在の keybindings.json の Chat の enter：{raw}",
	"settings.submitKey.currentNewline": "現在の keybindings.json の Chat の enter：chat:newline",
	"settings.submitKey.currentSubmit": "現在の keybindings.json の Chat の enter：既定（未設定、または chat:submit）",
	"confirm.writeKeybindings.message":
		"Enter を改行にするため、Claude Code の keybindings.json に書きます。他のターミナルアプリで起動した claude にも効きます",
	"settings.submitKeyMismatch.name": "keybindings.json と食い違っています",
	"settings.submitKeyMismatch.desc": "Claude Code の keybindings.json と一致していません",

	// ---- Modals (ui/modals.ts) ----
	"modal.newSession.title": "新規セッション",
	"modal.newSession.nameField": "名前",
	"modal.newSession.agentField": "エージェント",
	"modal.renameSession.title": "名前を変更",
	"modal.moveToCategory.title": "カテゴリに移動",
	"modal.moveToCategory.categoryField": "カテゴリ",

	// ---- Side panel (views/side.ts) ----
	"section.openTabs": "開いているタブ",
	"section.running": "起動中",
	"section.recent": "最近",
	"empty.desc": "Claude Code と Codex のセッションを、Obsidian の中からそのまま開いて管理する。",
	"empty.noAgentEnabled": "有効なエージェントがありません——まず設定で1つ有効にしてください",
	"empty.noAgentFound": "有効なエージェントの実行ファイルが見つかりません——設定でパスを確認してください",

	// ---- Row relative time (views/rows.ts's formatRelativeTime, side panel only) ----
	"time.justNow": "たった今",
	"time.minutesAgo": "{n} 分前",
	"time.hoursAgo": "{n} 時間前",
	"time.yesterday": "昨日",
	"time.daysAgo": "{n} 日前",

	// ---- Attention markers (side panel badges, manager section headings) ----
	"attention.asking": "入力待ち {count}",
	// waiting（応答が出てまだ見ていない）と compacted（compact 直後でまだ次の指示が
	// 無い）の両方を数える——どちらも「レビュー待ち」（statusGroup）。
	"attention.waiting": "レビュー待ち {count}",
	"attention.askingInGroup": "入力待ちのセッションがあります",
	"attention.waitingInGroup": "レビュー待ちのセッションがあります",

	// ---- Manager (views/manager.ts, views/manager-model.ts) ----
	"table.name": "名前",
	"table.updated": "最終更新",
	"table.model": "モデル",
	"table.effort": "エフォート",
	"table.folder": "フォルダ",
	"stats.fiveHour": "5 時間枠",
	"stats.sevenDay": "7 日枠",
	"stats.window.nDay": "{n} 日枠",
	"stats.window.nHour": "{n} 時間枠",
	"stats.window.nMinute": "{n} 分枠",
	"stats.resetsIn": "リセットまで {countdown}",
	"stats.metric.cost": "コスト",
	"stats.metric.costTip": "この枠内の合計コスト",
	"stats.metric.tokens": "トークン",
	"stats.metric.tokensTip": "入力＋出力＋cache 読出＋cache 作成（この枠内）",
	"stats.metric.calls": "呼出",
	"stats.metric.callsTip": "この枠内の呼出回数",
	"stats.metric.sessions": "セッション",
	"stats.metric.sessionsTip": "この枠内で動いたセッション数",
	"stats.categoryBar.title": "カテゴリ別（{window}）",
	"stats.categoryBar.empty": "この枠の使用はありません",
	"stats.categoryBar.itemCost": "{cost}（{share}%）",
	"stats.pace.unknown": "使用率が分かりません",
	"stats.pace.tooEarly": "判定には経過が足りません",
	"stats.pace.onTrack": "順調 — このペースで枠の終わりに約 {pct}",
	"stats.pace.overPace": "このペースでは {when} に使い切ります（リセットの {days} 日 {hours} 時間前）",
	"stats.pace.overPaceGuide": "残り 1 日あたり {pct} 以下（約 {cost}／日）",
	"stats.pace.overPaceGuideNoCost": "残り 1 日あたり {pct} 以下",
	"stats.pace.tooltip": "経過 {elapsedPct}%・使用 {usedPct}%",
	"category.other": "その他",
	"toolbar.filterPlaceholder": "絞込",
	"toolbar.filterByStatus": "状態で絞り込む",
	"group.archived": "アーカイブ（{count}）",
	"group.other": "その他",
	"manager.analysis.title": "解析",

	// ---- Detail view (views/detail.ts) ----
	"detail.compacted": "compact 済み",
	"detail.totalTokens": "総トークン",
	"detail.totalCost": "総コスト",
	"detail.lastUser": "直近の指示",
	"detail.lastAssistant": "直近の応答",
	"detail.tools": "ツール",
	"detail.folder": "フォルダ",

	// ---- Rate-limit view (views/limits.ts) ----
	"limits.countdownDays": "{days} 日 {h}:{mm}",

	// ---- Editor pane (views/editor-pane.ts) ----
	// Uses action.send and action.backToInput.

	// ---- Terminal exit screen (views/terminal.ts) ----
	"exit.exited": "セッションは終了しました（{code}）",
	"exit.disconnected": "デーモンとの接続が切れました",

	// ---- Tab/row state (views/terminal.ts's `terminalStatus`) ----
	"status.connecting": "接続中",
	"status.working": "処理中",
	"status.runningShell": "コマンド実行中",
	// claude itself is waiting on a question, a permission prompt, or elicitation. Ranks above "waiting for input".
	"status.asking": "回答待ち",
	"status.waiting": "指示待ち",
	// Right after a /compact, before the next instruction has been sent. Ranks below "waiting
	// for input" — kept as a distinct state so it's clear the context was just reset.
	"status.compacted": "compact 済み（文脈がリセットされています）",
	"status.editing": "編集中",
	"status.idle": "待機",
	"status.detached": "未接続",
	"status.exited": "終了",
	"status.error": "エラー",

	// ---- Status groups (sessions/terminal-status.ts の statusGroup。サイドのバッジと
	// マネージャーの状態フィルターのメニュー。Claude 本体のアプリの状態区分に合わせた) ----
	"status.group.all": "すべて",
	"status.group.needsInput": "入力待ち",
	"status.group.needsReview": "レビュー待ち",
	"status.group.running": "実行中",
	"status.group.done": "完了",
	"status.group.archived": "アーカイブ済み",

	// ---- Session analytics modal (usage/usage-modal.ts) ----
	"usage.title": "セッション解析結果：{name}",
	"usage.loading": "読み込み中…",
	"usage.loadFailed": "集計に失敗しました: {error}",
	"usage.col.time": "時刻",
	"usage.col.prompt": "指示",
	"usage.col.input": "入力",
	"usage.col.output": "出力",
	"usage.col.cost": "コスト",
	"usage.emptyPrompt": "（空）",
	"usage.beforeFirstPrompt": "（開始前）",
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

	// ---- Markdown copy (usage/usage.ts's toMarkdown) ----
	"usage.md.title": "# セッション解析結果（#{lo}〜#{hi}）",
	"usage.md.cost": "- コスト: {cost}{estimated}",
	"usage.md.estimatedSuffix": "（概算）",
	"usage.md.tokens": "- トークン: 入力 {input}・出力 {output}",
	"usage.md.turns": "- ターン数: {count}",
	"usage.md.duration": "- 期間: {duration}",
	"usage.md.tableHeader": "| # | 時刻 | 指示 | 入力 | 出力 | コスト |",

	// ---- terminal/keybindings.ts ----
	"error.keybindingsUnreadable": "{path} が読めません。手で直す必要があります",
	"warning.manualFix": "手で直す必要があります（{keys} が想定と違う値のまま残っています）",

	// ---- sessions/store.ts ----
	"error.lockFailed": "ロックが取れない: {path}",

	// ---- backend/daemon-client.ts ----
	"error.unknownFrameKind": "不明なフレーム種別: 0x{hex}",
	"error.socketClosed": "ソケットが閉じた",
	"error.notConnected": "デーモンに未接続",
	"error.agentSessionsNotFound": "agent-sessions が見つからない: {path}",
	"error.daemonUnavailable": "デーモンに接続できない。Python が無いか、ソケットが作れない可能性がある。",
};

/** Japanese's own name for itself, shown in the language-setting dropdown regardless of the
 * current display language (an autonym, not translated). */
export const JA_SELF_NAME = "日本語";
