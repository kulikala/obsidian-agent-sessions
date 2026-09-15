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
| サイドパネル（右） | 新規セッション／セッションマネージャー／⋯（設定・再走査・アーカイブ）。一覧は「開いているタブ → 起動中 → 最近」。行の `⋯`・右クリックで 名前を変更（`/rename`）・圧縮（`/compact`）・アーカイブ・セッションを終了・フォルダを開く・ID をコピー。最下段に前面のセッションの モデル・エフォート・コンテキスト・rc・5h/7d |
| セッションマネージャー | グループ → 単独 → その他 → アーカイブ の木。折畳・絞込・詳細欄。開いても claude は起動しない |
| ターミナル | 1 セッション＝1 タブ。ヘッダに `@`（現在のノートを挿入）・前の指示・次の指示・最後の応答。Shift／Option／Cmd+Enter で改行。Cmd +/−/0 でフォントサイズ。出力中の vault 内パスはクリックで開く |
| 設定 | フォント・サイズ・余白（ゆったり／小さめ／なし）・Enter の役割（送信／改行。実体は `~/.claude/keybindings.json` の `Chat`）・最近の件数・指示待ちの通知・パス |

```sh
agent-sessions                 # TUI。⏎ で起動中なら attach、そうでなければ claude --resume
agent-sessions attach ID       # 端末から attach（Ctrl+\ で detach）
agent-sessions json scan|live|detail ID
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
