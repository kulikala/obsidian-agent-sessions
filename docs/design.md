# Agent Sessions 設計（段 1）

要件は `requirements.md`。本書は段 1 の作り。

## 1. 構成

```
agent-sessions/
├── plugin/                    Obsidian プラグイン（TypeScript, esbuild, vitest）
│   ├── src/
│   │   ├── main.ts            Plugin 本体：ビュー登録・コマンド・設定・openSession
│   │   ├── settings.ts        設定の型・既定値・設定タブ
│   │   ├── store.ts           <vault>/.agents/sessions/sessions.json の読み書き
│   │   ├── backend.ts         `agent-sessions json …` の呼び出しと結果の型
│   │   ├── daemon-client.ts   Unix ソケットのクライアント（フレーム・attach・resize）
│   │   ├── registry.ts        ~/.claude/sessions/*.json の監視（状態・pid・rc）
│   │   ├── statusline.ts      ~/.agents/sessions/status/<id>.json の監視
│   │   ├── tree.ts            JSON → グループ木（純関数）
│   │   ├── links.ts           出力中のパス検出と vault 内解決（純関数）
│   │   ├── marks.ts           指示／応答のマーカー管理（純関数＋xterm 依存の薄い層）
│   │   ├── views/list.ts      一覧ビュー
│   │   ├── views/terminal.ts  ターミナルビュー
│   │   ├── modals.ts          新規セッション・名前変更のダイアログ
│   │   └── theme.ts           Obsidian の CSS 変数 → xterm テーマ
│   ├── test/                  vitest（純関数と daemon-client のフレーム）
│   ├── manifest.json          id: agent-sessions / name: Agent Sessions / isDesktopOnly: true
│   ├── styles.css
│   ├── esbuild.config.mjs     → plugin/main.js
│   └── package.json
├── bin/agent-sessions         #!/usr/bin/python3。agentsessions.cli.main を呼ぶ
├── agentsessions/             Python パッケージ（標準ライブラリのみ）
│   ├── config.py              パス定数（VAULT, STORE_PATH, RUNTIME_DIR, SOCK_PATH, …）
│   ├── model.py scan.py detail.py live.py items.py   走査・抽出（現 cslib から移設）
│   ├── store.py               sessions.json（折畳・非表示・未適用の名前変更）
│   ├── cache.py               走査キャッシュ（path → mtime,size,結果）
│   ├── jsonout.py             `json` サブコマンドの出力
│   ├── protocol.py            ソケットのフレーム（デーモンとクライアント共通）
│   ├── daemon.py              PTY デーモン
│   ├── attach.py              端末からの attach クライアント（raw mode）
│   ├── hooks.py               `hook`・`status` の受け口
│   ├── cli.py                 サブコマンドの振り分け
│   └── tui.py                 TUI（選んで起動するだけ）
├── tests/                     Python unittest
├── docs/
└── install.sh                 symlink と settings.json の案内
```

`~/.config/dotfiles` は `bin/cs`・`cslib/`・`tests/`・`docs/2026-09-11-claude-sessions-design.md` を削除し、`bin/agent-sessions` → `~/work/agent-sessions/bin/agent-sessions` の symlink を置く。

## 2. プロセスと責務

| プロセス | 起動 | 責務 |
|---|---|---|
| プラグイン | Obsidian | 一覧・ターミナル描画・タブ管理・復元・通知・`sessions.json` の書込 |
| `agent-sessions daemon` | プラグイン（ソケット不応答時に `--detach` で起動）／手動 | PTY の保持、出力バッファ、attach/detach、claude の起動と終了検知 |
| `agent-sessions json …` | プラグインが必要時に spawn | 走査・最終更新・子判定・起動中・直近の指示／応答 |
| `agent-sessions`（TUI）| ユーザー | 選んで attach／起動 |
| `agent-sessions hook` / `status` | Claude Code（settings.json） | フック・statusLine の受け口 |

走査と判定のロジックは Python 側にだけ置く。プラグインは JSON を表示し、`sessions.json` を書き、PTY を描く。

## 3. ファイルと台帳

| 場所 | 内容 | 書く者 |
|---|---|---|
| `<vault>/.agents/sessions/sessions.json` | 折畳・非表示・未適用の名前変更（下記） | プラグイン、`agent-sessions`（原子的に tmp→rename） |
| `~/.agents/sessions/daemon.sock` | デーモンのソケット（vault 配下は macOS のパス長制限 104 バイトに掛かる） | デーモン |
| `~/.agents/sessions/daemon.pid` / `daemon.log` | デーモンの pid とログ | デーモン |
| `~/.agents/sessions/status/<session_id>.json` | `statusLine` が渡す JSON をそのまま | `agent-sessions status` |
| `~/.agents/sessions/events.log` | フック 1 件 1 行 `{"event","session_id","transcript_path","ts"}` | `agent-sessions hook` |
| `~/.agents/sessions/scan-cache.json` | 走査キャッシュ | `agent-sessions json` |
| `~/.claude/projects/<p>/<id>.jsonl` | transcript（真実源） | Claude Code（読むだけ） |
| `~/.claude/sessions/<pid>.json` | 起動中の台帳と状態 | Claude Code（読むだけ） |

`sessions.json`：

```json
{
  "version": 1,
  "folded": ["RIM", "その他のセッション"],
  "hidden": [{"id": "5778f81f-…", "name": "酔い酒鮨庵", "agent": "claude"}],
  "pendingRenames": {"68d25490-…": "スキル開発: セッション管理 v2"},
  "sessions": {"68d25490-…": {"agent": "claude", "cwd": "/Users/…/obsidian-projects"}}
}
```

- `sessions` はプラグインが起動したセッションの `agent` と `cwd`。走査で transcript が見つかれば transcript が優先。新規直後（transcript 未生成）の行を一覧に出すために持つ。
- `hidden` の `name` は一覧に「非表示」区分で出すための控え。真実は transcript。
- 旧 `claude-sessions.md` の frontmatter（`folded`・`hidden`）は初回起動時に取り込み、ファイルは残す（削除はユーザーが行う）。`~/.claude/cs/` は使わない。

## 4. デーモン

### 4.1 ソケットとフレーム

Unix ドメインソケット `~/.agents/sessions/daemon.sock`。両方向とも同じフレーム：

```
+------+----------------+---------+
| type | length (u32 BE)| payload |
| 1 B  | 4 B            | n B     |
+------+----------------+---------+
```

| type | 向き | payload |
|---|---|---|
| `J` | 双方向 | JSON（UTF-8）。要求と応答・イベント |
| `D` | 双方向 | 生バイト。クライアント→デーモンは PTY への入力、デーモン→クライアントは PTY の出力 |
| `R` | デーモン→ | attach 直後に再生するバッファ（複数フレーム可）。再生の終わりは `{"ev":"replayed"}` |

要求（`J`、`"op"` で区別）と応答（同じ `"seq"` を返す）：

| op | 引数 | 応答 |
|---|---|---|
| `hello` | `client`（`plugin`／`tui`） | `{"ok":true,"version":1,"pid":…}` |
| `list` | — | `{"ok":true,"sessions":[{"id","agent","cwd","pid","startedAt","clients","exited":null or code}]}` |
| `start` | `id`,`agent`,`cwd`,`argv`,`env`,`cols`,`rows` | `{"ok":true}`。既に同じ `id` があれば `{"ok":false,"error":"exists"}` |
| `attach` | `id`,`cols`,`rows` | `{"ok":true}` → `R`… → `{"ev":"replayed"}` → 以後 `D`。無ければ `{"ok":false,"error":"no-session"}` |
| `detach` | — | `{"ok":true}` |
| `resize` | `cols`,`rows` | `{"ok":true}` |
| `kill` | `id`,`signal`（既定 `TERM`） | `{"ok":true}` |
| `shutdown` | — | `{"ok":true}` 後にデーモン終了 |

イベント（デーモン→、`"ev"`）：`exit`（`id`,`code`）・`replayed`。1 接続は同時に 1 セッションにしか attach しない。同じセッションに複数の接続が attach してよい（プラグインと TUI）。出力は全接続へ、入力はどこからでも、サイズは最後の `resize` が勝つ。

### 4.2 セッションの保持

- `start`：`pty.fork()` → 子で `os.chdir(cwd)`、`os.execvpe(argv[0], argv, env)`。親は `TIOCSWINSZ` でサイズを設定。
- 環境は要求の `env` に `TERM=xterm-256color`・`COLORTERM=truecolor`・`AGENT_SESSIONS_ID=<id>` を足す。プラグインはログインシェル（`$SHELL -l -c 'env'`）から取った `PATH`・`LANG`・`HOME` などを `env` に渡す（Dock から起動した Obsidian の環境は貧弱なため）。
- 出力バッファ：セッション毎に `deque` のチャンク列、合計 1 MiB を上限に古いものから捨てる。再生はチャンク境界から。
- attach 時：`resize` を適用してから `R` で再生、`replayed` の後に **行数を 1 減らして戻す**（Claude Code が SIGWINCH で画面下部を描き直す）。
- 終了：`waitpid` で検知 → 全接続に `exit` → セッションは `exited` 付きで 60 秒残し、その後破棄。
- `kill`：プロセスグループへ `SIGTERM`、10 秒で `SIGKILL`。
- デーモン自身：セッション 0 かつ接続 0 の状態が 10 分続いたら終了。`SIGTERM` で全セッションを `kill` して終了。単一実体は `daemon.pid` と `flock` で保証。
- 1 スレッド `select` ループ。ブロッキング I/O なし。

## 5. `agent-sessions` CLI

| コマンド | 内容 |
|---|---|
| `agent-sessions` | TUI |
| `agent-sessions daemon [--detach]` | デーモン。`--detach` は `setsid` して pid を出力し戻る |
| `agent-sessions json scan [--only ID …]` | 走査結果 `{"sessions":[…],"groups":…}`（§6）。`--only` は指定 transcript だけ再走査してキャッシュを更新 |
| `agent-sessions json live` | 起動中の台帳（`~/.claude/sessions`）と デーモンの `list` を併せて `{"live":{id:{status,pid,rc,daemon:bool}}}` |
| `agent-sessions json detail ID` | `{"last_user","last_assistant","tools"}` |
| `agent-sessions attach ID` | 端末を raw mode にしてデーモンの PTY へ接続。`Ctrl+\` で detach |
| `agent-sessions hook` | stdin の JSON を `events.log` に 1 行追記 |
| `agent-sessions status` | stdin の JSON を `status/<session_id>.json` に書き、`モデル · ctx NN%` を 1 行出力（Claude Code のステータス行になる） |

TUI：一覧（グループ→単独→その他、折畳、`/` 絞込、`h` で非表示を見せる）と ⏎。⏎ はデーモンに `id` があれば `attach`、無ければ `claude --resume ID` を `execvp`。管理操作は持たない。サイドパネル：`cols >= 60` なら幅 `clamp(cols×0.4, 30, 60)` で常に出す。`cols < 60` では `p` で「一覧」と「パネルのみ」を切り替える。

`json scan` の出力（1 セッション）：

```json
{"id":"…","agent":"claude","name":"RIM: 議事メモ作成","group":"RIM","label":"議事メモ作成",
 "cwd":"/Users/…","folder":"obsidian-projects","last_activity":1789400538.7,"child":false,
 "transcript":"/Users/…/68d25490-….jsonl"}
```

キャッシュ：`scan-cache.json` に `path → {mtime,size,head,last_activity}`。`mtime`・`size` が一致すれば再読しない。全走査の 2 回目以降は 0.1 秒以下。

`install.sh`：`~/bin/agent-sessions` の symlink、`<vault>/.obsidian/plugins/agent-sessions` → `plugin/` の symlink、`~/.claude/settings.json` に入れる `hooks`（Stop・SessionEnd → `agent-sessions hook`）と `statusLine`（`agent-sessions status`）の JSON を表示する（書き換えはしない）。

## 6. プラグイン

### 6.1 一覧ビュー（`agent-sessions-list`）

- 既定は右サイドバー。リボンアイコンとコマンド「Agent Sessions: 一覧を開く」で表示。
- ツールバー：**新規セッション**・**再走査**・⋯（非表示を表示／設定）。
- 木：グループ（見出し、折畳）→ 単独 → その他のセッション（既定で折畳）→ 非表示（既定で折畳、表示切替時のみ）。行は `● 名前  MM-DD HH:MM`（`●` 動作中＝アクセント色、`○` 待機中、無印＝停止中、`(未適用)` 名前変更待ち）。
- 行クリック → `openSession(id)`。右クリック／⋯ → 名前を変更・圧縮・非表示⇄戻す・セッションを終了（起動中のみ）・フォルダを開く・ID をコピー。
- 詳細欄：一覧の下に折り畳める領域。行にポインタが乗って 300 ms 経ったら `json detail` を呼び（キャッシュ）、直近の指示・直近のツール・直近の応答・フォルダ・ID を出す。
- 再走査のタイミング：ビューを開いたとき、再走査ボタン、`events.log` の追記（該当 ID だけ `--only`）、`~/.claude/sessions/` の変化（状態の更新のみ、走査はしない）、ビューが見えている間 60 秒毎。

### 6.2 ターミナルビュー（`agent-sessions-terminal`）

状態（`getState`）：`{id, agent, cwd, fontSize?}`。Obsidian の workspace に保存され、再起動で戻る。

- xterm 5.x：`fontFamily`・`fontSize` は設定（タブ毎の `fontSize` があれば優先）、`lineHeight: 1.0`、`letterSpacing: 0`、`scrollback: 5000`、`allowProposedApi: true`、`macOptionIsMeta: true`、`cursorBlink: true`。アドオン：fit・webgl（失敗時は既定の canvas）・unicode11。
- 余白：設定 `padding`（`comfortable`＝12px／`compact`＝4px／`none`＝0）をコンテナの CSS 変数に流し、`fit()` は余白を除いた領域で計る。
- 接続：初回に ResizeObserver が 0 でない大きさを報告したとき `ensureAttached()`。デーモンに `id` があれば `attach`、無ければ `start`（`argv = [claudePath, '--resume', id]`、新規は `['--session-id', id]`）。デーモンに繋がらなければ起動を試み、1 秒待って再接続、3 回失敗で終了画面にエラー。
- 出力：`D` フレームを `terminal.write(Uint8Array)`。再生（`R`）中は `write` をまとめ、`replayed` で `scrollToBottom()`。
- 入力：`onData` の文字列を UTF-8 で `D`。`onBinary` も同様。
- サイズ：ResizeObserver → 50 ms デバウンス → `fit()` → `onResize` → `resize`。
- キー：`attachCustomKeyEventHandler` で Esc の `keyup` の伝播を止める（Obsidian がフォーカスを奪うため）。`Cmd + / − / 0` はフォントサイズに使い、他はすべて xterm へ。
- 終了（`exit` イベント）：出力の上に「セッションは終了しました（code）」と **再開**・**閉じる**。再開は `--resume` で `start` し直す。
- タブを閉じる（`onClose`）：`detach` して接続を閉じ、xterm を `dispose`。セッションは残る。
- ヘッダの操作（`addAction`）：`@`（現在のノートを挿入）・前の指示・次の指示・最後の応答・⋯（名前を変更／圧縮／セッションを終了／フォント 大・小・リセット／設定）。
- ステータスバー（ビュー下部 1 行）：`Opus 5 · high · ctx 42% · rc ● · 5h 37% · 7d 12%`。元は `status/<id>.json`（`model.display_name`・`context_window.used_percentage`・`rate_limits.five_hour/seven_day.used_percentage`・`effort` があれば）と `~/.claude/sessions/<pid>.json`（`bridgeSessionId` の有無 → rc）。`effort` が JSON に無ければ `~/.claude/settings.json` の `effortLevel`。取れない項目は `—`。
- タブのアイコンと題名：題名はセッション名（無ければ `無題 ` + ID 先頭 8 桁）。アイコンは `bot`。状態 `busy`／`shell` の間は CSS でアニメーション（`.agent-sessions-busy` を `leaf.tabHeaderInnerIconEl` に付ける）。`busy → idle` に落ちたときにそのタブが前面でなければ `.agent-sessions-waiting`（アイコン `message-circle`）にし、前面になったら戻す。

### 6.3 1 セッション＝1 タブ

`openSession(id)`：`workspace.getLeavesOfType('agent-sessions-terminal')` から `view.state.id === id` の leaf を探し、あれば `revealLeaf` して終わり。無ければ設定の場所（右サイドバー／メイン領域）に leaf を作り `setViewState`。新規セッションも同じ経路（先に `sessions.json` の `sessions[id]` を書く）。

### 6.4 状態と通知

- `registry.ts`：`fs.watch(~/.claude/sessions)` を 200 ms でまとめ、全 `*.json` を読み `sessionId → {status, pid, bridgeSessionId, updatedAt}`。pid が生きているか `process.kill(pid, 0)` で確かめ、死んでいる台帳は無視。
- 状態の遷移 `busy|shell → idle` で、そのセッションのタブが前面でない（または Obsidian が非アクティブ）なら `Notice`（クリックで `openSession`）。設定で切れる。
- 一覧ビューとターミナルビューは `registry` の変化イベントを購読して印を更新する。

### 6.5 名前変更・圧縮・終了

- `/rename NAME`・`/compact` は PTY へ `文字列 + "\r"` を書く。送る条件：デーモンにセッションがあり、状態が `idle`。満たさなければ名前変更は `pendingRenames` に入れ、次に attach して状態が `idle` になった 1 秒後に送る。圧縮は「待機中でないと送れない」と `Notice`。
- 送った後 `events.log` の次の追記で `--only` 再走査し、名前が transcript に現れたら `pendingRenames` から消す。
- 新規セッション：ダイアログ（名前・開始ボタン）。`id = crypto.randomUUID()`、`sessions[id] = {agent:'claude', cwd: vault}` を書き、名前があれば `pendingRenames[id]` に入れ、`openSession(id)`。タブが `start` し、最初の `idle` で `/rename` が送られる。
- セッションを終了：確認 → `kill` → `exit` イベント → 終了画面。

### 6.6 リンクと `@` とジャンプ

- リンク（`links.ts`）：`registerLinkProvider`。行から `[\w./~\-]+(?:\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?` を候補にし、絶対パスは vault 配下なら相対に、相対はセッションの `cwd` から vault 相対に直し、`vault.getAbstractFileByPath` で実在するものだけリンクにする。クリックで `openLinkText`（メイン領域）、行番号があれば `editor.setCursor`。
- `@` 挿入：コマンド「Agent Sessions: 現在のノートを @ で挿入」とヘッダの `@`。対象はアクティブな Markdown ビューのファイル。パスはセッションの `cwd` からの相対（`cwd` の外なら絶対）。エディタの選択が複数行なら `#L{from}-{to}`。空白を含むパスは引用符で囲む。PTY へ `@path ` を書き、ターミナルにフォーカスを移す。
- ジャンプ（`marks.ts`）：`onData` に `\r` が含まれ、かつ括弧付きペースト中でないとき `registerMarker(0)` を「指示」として記録。`registry` の `idle → busy` で `registerMarker(0)` を「応答の先頭」として記録（最後の 1 つを保持）。前の指示＝現在の表示先頭より上で最も近いマーカー、次の指示＝表示先頭より下で最も近いマーカー、最後の応答＝応答マーカー。`scrollToLine(marker.line)`。破棄済みマーカーは捨てる。

### 6.7 設定

| 項目 | 既定 |
|---|---|
| フォント | `Menlo, "Hiragino Sans", monospace` |
| フォントサイズ | 13 |
| 余白 | ゆったり |
| ターミナルを開く場所 | 右サイドバー |
| 指示待ちの通知 | オン |
| `claude` のパス | 空＝ログインシェルで `command -v claude` |
| `agent-sessions` のパス | 空＝`~/bin/agent-sessions` |
| Python のパス | `/usr/bin/python3` |
| スクロールバック行数 | 5000 |

### 6.8 テーマ

`theme.ts` が Obsidian の CSS 変数（`--background-primary`・`--text-normal`・`--text-accent`・`--text-selection`）から `background`・`foreground`・`cursor`・`selectionBackground` を作る。ANSI 16 色は明暗それぞれの固定表。`css-change` で再適用。

## 7. エラー処理

| 事象 | 振る舞い |
|---|---|
| デーモンに繋がらない | 起動を試みる。3 回失敗で終了画面に理由（Python が無い・ソケットが作れない） |
| `claude` が見つからない | 終了画面に「claude が見つからない」と設定へのリンク |
| `--resume` が失敗（transcript 消失） | claude の出力をそのまま見せ、終了画面に「新規として開始」を足す |
| `json scan` が失敗 | 一覧に前回の結果を残し、`Notice` に stderr の先頭行 |
| `sessions.json` が壊れている | `.broken-<時刻>` に退避して初期化 |
| WebGL が使えない | canvas に落ちる（ログのみ） |

## 8. テスト

- Python（unittest、`-W error`）：既存 90 件を移設。追加：`protocol`（フレームの分割・結合）、`daemon`（`cat` を子にした start/attach/replay/resize/kill、バッファ上限、複数接続）、`store`（sessions.json、旧 md の取り込み）、`cache`、`jsonout`、`tui` のパネル幅。
- TypeScript（vitest）：`tree`、`links`、`marks`、`daemon-client` のフレーム、`statusline` の整形、`store` の読み書き（tmp dir）。
- 手動：`requirements.md` の「受け入れの確認」。

## 9. 段 2 以降への接続

- 外部エディタ：デーモンが `env` に `VISUAL=agent-sessions edit` を足せるよう `start` の `env` はプラグインが組む。`agent-sessions edit` はソケット（デーモンとは別、`~/.agents/sessions/plugin.sock`、プラグインが待ち受け）へ依頼し、プラグインはターミナルビューの中に編集領域を割って開く（ターミナルは残る）。
- Codex：`agent` フィールド、`argv` の組み立て、走査元（`~/.codex/sessions`）を `agentsessions/agents/<name>.py` に分ける。段 1 では `claude.py` のみ。
- トークン集計：transcript の `usage` を区間で集計する `json usage ID [--from TS --to TS]` を足す。
