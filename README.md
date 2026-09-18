# Agent Sessions

Obsidian の中で Claude Code のセッションを開き、管理する。3 つで 1 つの道具：

- **Obsidian プラグイン `agent-sessions`**（`plugin/`）— 右サイドバーの一覧・メニュー・ステータスバー、メインエリアのセッションマネージャーとターミナル（xterm）。
- **デーモン**（`agent-sessions daemon`）— claude の PTY を持つ。タブを閉じても Obsidian を閉じてもセッションは動き続け、開き直すと直前の画面が再生される。
- **CLI／TUI**（`agent-sessions`）— ターミナルから選んで attach／再開。走査・最終更新・子判定は Python 側にだけある。

要件は `docs/requirements.md`、設計は `docs/design.md`。

## 入れる

```sh
cd ~/work/agent-sessions
(cd plugin && npm install && npm run build)
./install.sh          # ~/bin/agent-sessions、vault の plugins への symlink、~/.claude/settings.json のフックと statusLine
```

Obsidian の「コミュニティプラグイン」で Agent Sessions を有効にする。

前提：macOS、`/usr/bin/python3`（3.9、標準ライブラリのみ）、`claude`、Obsidian desktop。

## 使う

| 場所 | できること |
|---|---|
| サイドパネル（右） | ナビ（＋＝新規セッション、マネージャー、⋯＝設定・再走査）／一覧「開いているタブ → 起動中 → 最近」（行の `⋯`・右クリック：名前を変更・セッションを圧縮・セッション解析結果・アーカイブ・セッションを終了・ID をコピー）／詳細（モデル・エフォート・rc、コンテキストの円グラフ、総トークン・総コスト、直近の指示・応答）／セッション制限（5h・7d とリセットまでの時間）。一覧と詳細の境はドラッグで動く |
| セッションマネージャー | 表（印・名前・最終更新・フォルダ）＋右の詳細。↑↓／Enter／`/`。⋯ に「アーカイブを表示」。開いても claude は起動しない |
| ターミナル | 1 セッション＝1 タブ。ヘッダに `@`（現在のノートを挿入）・前の指示・次の指示・最後の応答。改行キーは設定（既定 Shift+Enter。Enter を改行にするときは送信キーも選ぶ）。Cmd +/−/0 でフォントサイズ。出力中の vault 内パスはクリックで開く |
| Ctrl+G | プロンプト入力中に Ctrl+G で、同じタブの下に編集領域が開く（`$VISUAL` は `~/bin/agent-sessions-code`）。ペースト・IME・Undo はそのまま、`@` でファイル補完、Cmd+Enter で送る、Esc で取消。ターミナルは上に見えたまま。タブが無いときは `vi`（`AGENT_SESSIONS_FALLBACK_EDITOR`）に倒れる |
| セッション解析結果 | 行メニューから。コスト・トークン・ターン数・期間のカード、入力／出力／ツールのバー、ターン表（コスト付き）。行をクリックして区間を選び、Markdown でコピー |
| 設定 | フォント・サイズ・余白（ゆったり／小さめ／なし）・改行キー・送信キー（Enter を改行にするときだけ `~/.claude/keybindings.json` の `Chat` に書く）・最近の件数・指示待ちの通知・パス |

```sh
agent-sessions                 # TUI。⏎ で起動中なら attach、そうでなければ claude --resume
agent-sessions attach ID       # 端末から attach（Ctrl+\ で detach）
agent-sessions json scan|live|detail ID|usage ID [--from ISO --to ISO]
agent-sessions daemon --detach
agent-sessions setup --dry-run # settings.json に入れる変更を見る
```

## 置き場

| 場所 | 内容 |
|---|---|
| `<vault>/.agents/sessions/sessions.json` | 折畳・アーカイブ・未適用の名前変更（プラグインと TUI が mkdir ロックで共有） |
| `~/.agents/sessions/` | デーモンのソケット・pid・ログ、`exited.json`、`status/<id>.json`、`events.log`、走査キャッシュ |
| `~/.claude/projects/*/<id>.jsonl` | transcript（真実源。読むだけ） |
| `~/.claude/sessions/<pid>.json` | 起動中の台帳と状態（読むだけ） |

## 開発

```sh
/usr/bin/python3 -W error -m unittest discover -s tests -t .   # Python
cd plugin && npm test && npm run typecheck && npm run build      # TypeScript
AGENT_SESSIONS_BIN=$PWD/bin/agent-sessions npm test              # 実デーモンとの統合テストも走らせる
```
