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
│   │   ├── index.ts           SessionIndex：走査結果＋起動中＋タブの合成、購読
│   │   ├── keybindings.ts     ~/.claude/keybindings.json の読解と書換（Enter の役割）
│   │   ├── views/side.ts      サイドパネル
│   │   ├── views/manager.ts   セッションマネージャー
│   │   ├── views/terminal.ts  ターミナルビュー
│   │   ├── views/rows.ts      行・行メニュー・詳細欄（共通部品）
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
│   ├── store.py               sessions.json（折畳・アーカイブ・未適用の名前変更）。mkdir ロック付き
│   ├── cache.py               走査キャッシュ（path → mtime,size,結果）
│   ├── jsonout.py             `json` サブコマンドの出力
│   ├── protocol.py            ソケットのフレーム（デーモンとクライアント共通）
│   ├── daemon.py              PTY デーモン
│   ├── attach.py              端末からの attach クライアント（raw mode）
│   ├── hooks.py               `hook`・`status` の受け口
│   ├── setup.py               `setup`（settings.json のフックと statusLine を整える）
│   ├── cli.py                 サブコマンドの振り分け
│   └── tui.py                 TUI（選んで起動するだけ）
├── tests/                     Python unittest
├── docs/
└── install.sh                 symlink を張り、`agent-sessions setup` を呼ぶ
```

`~/.config/dotfiles` は `bin/cs`・`cslib/`・`tests/`・`docs/2026-09-11-claude-sessions-design.md` を削除し、`bin/agent-sessions` → `~/work/agent-sessions/bin/agent-sessions` の symlink を置く。この削除は実行計画の 1 タスク（dotfiles で 1 コミット）として行う。

## 2. プロセスと責務

| プロセス | 起動 | 責務 |
|---|---|---|
| プラグイン | Obsidian | 一覧・ターミナル描画・タブ管理・復元・通知・`sessions.json` の書込 |
| `agent-sessions daemon` | プラグインだけが起動する（ソケット不応答時に `--detach`）。CLI・TUI は起動しない | PTY の保持、出力バッファ、attach/detach、claude の起動と終了検知 |
| `agent-sessions json …` | プラグインが必要時に spawn | 走査・最終更新・子判定・起動中・直近の指示／応答 |
| `agent-sessions`（TUI）| ユーザー | 選んで attach／起動 |
| `agent-sessions hook` / `status` | Claude Code（settings.json） | フック・statusLine の受け口 |
| `agent-sessions setup` | `install.sh`／手動 | `~/.claude/settings.json` のフックと `statusLine` を整える |

走査と判定のロジックは Python 側にだけ置く。プラグインは JSON を表示し、`sessions.json` を書き、PTY を描く。

## 3. ファイルと台帳

| 場所 | 内容 | 書く者 |
|---|---|---|
| `<vault>/.agents/sessions/sessions.json` | 折畳・アーカイブ・未適用の名前変更（下記） | プラグイン、`agent-sessions`（TUI の折畳）。§3.1 のロックの中で読み→更新→tmp→rename |
| `<vault>/.agents/sessions/sessions.json.lock/` | 書込みの排他（§3.1） | 書く者 |
| `~/.agents/sessions/daemon.sock` | デーモンのソケット（vault 配下は macOS のパス長制限 104 バイトに掛かる）。ディレクトリ 0700・ソケット 0600 | デーモン |
| `~/.agents/sessions/daemon.pid` / `daemon.log` | デーモンの pid とログ | デーモン |
| `~/.agents/sessions/exited.json` | 終了済みで未 `forget` のセッション（`id → {code, exitedAt}`）。デーモンが終了時に書き、起動時に読む | デーモン |
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
  "archived": [{"id": "5778f81f-…", "name": "酔い酒鮨庵", "agent": "claude"}],
  "pendingRenames": {"68d25490-…": "スキル開発: セッション管理 v2"},
  "sessions": {"68d25490-…": {"agent": "claude", "cwd": "/Users/…/obsidian-projects"}}
}
```

- `sessions` はプラグインが起動したセッションの `agent` と `cwd`。走査で transcript が見つかれば transcript が優先。新規直後（transcript 未生成）の行を一覧に出すために持つ。
- `archived` の `name` はマネージャーの「アーカイブ」区分に出すための控え。真実は transcript。
- 旧 `claude-sessions.md` の取り込みはプラグインの `onload` が行う：`sessions.json` が無く `<vault>/claude-sessions.md` があれば、frontmatter の `folded` → `folded`、`hidden` → `archived` に写し、`migratedFrom: {path, at}` を書く。`sessions.json` が既にあれば何もしない。md は完走判定の後に削除する（T-19）。`~/.claude/cs/` は使わない。

### 3.1 `sessions.json` の排他

書く者はプラグイン（名前変更・アーカイブ・折畳・新規）と `agent-sessions` TUI（折畳）で、同時に動きうる。書込みは `sessions.json.lock/` ディレクトリを `mkdir` で取ってから行う（Python `os.mkdir`、Node `fs.mkdirSync`。作れた者がロックを持つ）。`EEXIST` なら 50 ms 待って再試行、2 秒で諦めてエラー（プラグインは `Notice`）。ロックの mtime が 10 秒より古ければ壊れたものとして `rmdir` して取り直す。ロックの中で読み→更新→tmp に書き→rename→`rmdir`。読むだけの者はロックを取らない。

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
| `list` | — | `{"ok":true,"sessions":[{"id","agent","cwd","pid","startedAt","clients","exited":null or code,"exitedAt"}]}`。終了済みも `forget` されるまで載る |
| `start` | `id`,`agent`,`cwd`,`argv`,`env`,`cols`,`rows` | `{"ok":true}`。既に同じ `id` があれば `{"ok":false,"error":"exists"}` |
| `attach` | `id`,`cols`,`rows` | `{"ok":true,"exited":null or code}` → `R`… → `{"ev":"replayed"}` → 以後 `D`。終了済みなら `replayed` の直後に `{"ev":"exit",…}` を送る。無ければ `{"ok":false,"error":"no-session"}` |
| `detach` | — | `{"ok":true}` |
| `resize` | `cols`,`rows` | `{"ok":true}` |
| `kill` | `id`,`signal`（既定 `TERM`） | `{"ok":true}` |
| `forget` | `id` | 終了済みセッションの記録とバッファを捨てる `{"ok":true}`。動作中なら `{"ok":false,"error":"running"}` |
| `shutdown` | — | `{"ok":true}` 後にデーモン終了 |

イベント（デーモン→、`"ev"`）：`exit`（`id`,`code`）・`replayed`。1 接続は同時に 1 セッションにしか attach しない。同じセッションに複数の接続が attach してよい（プラグインと TUI）。出力は全接続へ、入力はどこからでも。**PTY のサイズは attach 中の全接続の最小 cols・最小 rows**（tmux と同じ）で、`resize`・`detach`・切断のたびに再計算する。

接続の切断：`select` で読めるのに `recv` が空、または `ECONNRESET`／`EPIPE` なら切断とみなし、その接続を attach から外して `clients` を減らし、サイズを再計算する。明示の `detach` と同じ後始末を通る。

### 4.2 セッションの保持

- `start`：`pty.fork()` → 子で `os.chdir(cwd)`、`os.execvpe(argv[0], argv, env)`。親は `TIOCSWINSZ` でサイズを設定。
- 環境は要求の `env` に `TERM=xterm-256color`・`COLORTERM=truecolor`・`AGENT_SESSIONS_ID=<id>` を足す。プラグインはログインシェル（`$SHELL -l -c 'env'`）から取った `PATH`・`LANG`・`HOME` などを `env` に渡す（Dock から起動した Obsidian の環境は貧弱なため）。
- 出力バッファ：セッション毎に `deque` のチャンク列、合計 1 MiB を上限に古いものから捨てる。再生はチャンク境界から。
- attach 時：`resize` を適用してから `R` で再生。attach で PTY のサイズが**変わったときだけ**、`replayed` の後に行数を 1 減らして戻す（Claude Code が SIGWINCH で画面下部を描き直す。サイズが同じなら再生した画面がそのまま正しい）。
- 終了の検知：master fd の読みが EOF か `EIO` になったら `waitpid(pid, WNOHANG)`。加えて `SIGCHLD` を self-pipe で `select` に流し、孫プロセスが PTY を掴んでいて EOF が来ない場合も拾う。検知したらそのセッションに attach 中の接続に `exit` を送る。
- 終了済みセッションは **`forget` されるまで保持**する（記録とバッファ）。裏のタブが後から attach しても再生と `exit` が届き、終了画面になる。`forget` はプラグインの「再開」「閉じる」と TUI が送る。
- `kill`：プロセスグループへ `SIGTERM`、10 秒で `SIGKILL`。
- デーモン自身：動作中セッション 0 かつ接続 0 の状態が 10 分続いたら終了。終了するとき（アイドル・`shutdown`・`SIGTERM`）は、**その時点で既に終了済み**の記録（`id`・`code`・`exitedAt`）だけを `~/.agents/sessions/exited.json` に書き、次に起動したときに読み込んで `forget` されるまで保持する（バッファは持ち越さない）。デーモンの終了に伴って `kill` した動作中セッションは外からの停止なので記録しない（再起動後は `--resume` で続く）。裏タブがデーモンの再起動をまたいで attach しても `exit` が届き、終了画面になる。`exited.json` に上限は設けない。増えないのは、プラグインが `onLayoutReady` と `layout-change` のたびに、終了済みでターミナルタブの無い `id` へ `forget` を送るから（タブが残っている `id` は捨てない）。`SIGTERM` で全セッションを `kill` して終了。単一実体は `daemon.pid` と `flock` で保証。二重に起動された側は `flock` に失敗して即終了し、呼び出し側（プラグイン）は 1 秒待って再接続する。
- 起動時に `~/.agents/sessions/` を 0700 で作り、ソケットは `umask 0077` の下で bind する。
- 1 スレッド `select` ループ。ブロッキング I/O なし。

## 5. `agent-sessions` CLI

| コマンド | 内容 |
|---|---|
| `agent-sessions` | TUI |
| `agent-sessions daemon [--detach]` | デーモン。`--detach` は `setsid` して pid を出力し戻る |
| `agent-sessions json scan [--only ID …]` | 走査結果 `{"sessions":[…],"groups":…}`（§6）。`--only` は指定 transcript だけ再走査してキャッシュを更新 |
| `agent-sessions json live` | 起動中の台帳（`~/.claude/sessions`）とデーモンの `list` を併せて `{"live":{id:{status,pid,rc,updated_at}},"daemon":{"running":bool,"sessions":[list の要素]}}`。デーモンが無ければ `running:false`（起動はしない）。プラグインは `daemon.sessions` から行ごとの `daemon`／`exited` を導く |
| `agent-sessions json detail ID` | `{"last_user","last_assistant","tools"}` |
| `agent-sessions attach ID` | 端末を raw mode にしてデーモンの PTY へ接続。`Ctrl+\` で detach |
| `agent-sessions hook` | stdin の JSON を `events.log` に 1 行追記 |
| `agent-sessions status` | stdin の JSON を `status/<session_id>.json` に書き、`モデル · ctx NN%` を 1 行出力（Claude Code のステータス行になる） |
| `agent-sessions setup` | `~/.claude/settings.json` を読み、`settings.json.bak-<時刻>` を残してから、`hooks.Stop`・`hooks.SessionEnd` の `"$HOME/bin/cs" hook` を `"$HOME/bin/agent-sessions" hook` に置換（無ければ追加、他のフックは触らない）、`statusLine` が null か旧 `cs` なら `{"type":"command","command":"$HOME/bin/agent-sessions status"}` を設定。結果を表示する |

TUI：一覧（グループ→単独→その他、折畳、`/` 絞込、`h` でアーカイブを見せる）と ⏎。「その他」に載るのは名前が無く `child` でないセッションだけ（`json scan` と同じ `items.py` の判定）。⏎ はデーモンに `id` があれば `attach`（終了済みなら `forget` して `--resume`）、無ければ `claude --resume ID` を `execvp`。デーモンを起動することはない。折畳の保存は §3.1 のロックの中で書く。管理操作は持たない。サイドパネル：`cols >= 60` なら幅 `clamp(cols×0.4, 30, 60)` で常に出す。`cols < 60` では `p` で「一覧」と「パネルのみ」を切り替える。

`json scan` の出力（1 セッション）：

```json
{"id":"…","agent":"claude","name":"RIM: 議事メモ作成","group":"RIM","label":"議事メモ作成",
 "cwd":"/Users/…","folder":"obsidian-projects","last_activity":1789400538.7,"child":false,
 "transcript":"/Users/…/68d25490-….jsonl"}
```

キャッシュ：`scan-cache.json` に `path → {mtime,size,head,last_activity}`。`mtime`・`size` が一致すれば再読しない。全走査の 2 回目以降は 0.1 秒以下。

`install.sh`：`~/bin/agent-sessions` の symlink、`<vault>/.obsidian/plugins/agent-sessions` → `plugin/` の symlink を張り、`agent-sessions setup` を呼ぶ。

## 6. プラグイン

3 種のビュー。サイドパネルは右サイドバー、マネージャーとターミナルはメインエリアのタブ。位置の設定は持たない（Obsidian の標準操作で動かせる）。

| ビュー | type | 置き場 | 役割 |
|---|---|---|---|
| サイドパネル | `agent-sessions-side` | 右サイドバー | 一覧（開いているタブ・起動中・最近）・メニュー・ステータスバー |
| セッションマネージャー | `agent-sessions-manager` | メインエリア。「新しいタブ」相当の既定ビュー | 全セッションの木と管理操作。開いても claude は起動しない |
| ターミナル | `agent-sessions-terminal` | メインエリア。1 セッション＝1 タブ | claude そのもの |

用語：**アーカイブ**＝一覧から外す（`sessions.json` の `archived`）。マネージャーの「アーカイブ」区分で戻せる。

### 6.1 サイドパネル（`agent-sessions-side`）

上から順に：

1. **メニュー行**：`新規セッション`（ダイアログ）・`セッションマネージャー`（メインにマネージャーのタブを開く。あればそこへ）・`⋯`（設定を開く／再走査／アーカイブを表示）。セッションに対する操作はここに置かない。
2. **一覧**（区分は見出し付き、空の区分は出さない）
   - **開いているタブ**：ターミナルタブがあるセッション。タブの順。前面のタブの行は強調。クリックでそのタブを前面に。
   - **起動中**：デーモンが持っていてタブが無いセッション。クリックで attach したタブを開く。
   - **最近**：それ以外を最終更新順に N 件（設定、既定 10）。アーカイブ済みと名前の無い子セッションは出さない。クリックで `--resume` のタブを開く。
   - 行：`状態の印  名前`。印は動作中＝アニメーション、指示待ち＝待機の印、停止中＝無印。`(未適用)` は名前変更待ち。
   - **行を選択（クリックまたは矢印キー）するとその行に `⋯` が現れ**、`名前を変更`・`圧縮`・`アーカイブ`・（起動中なら）`セッションを終了`・`フォルダを開く`・`ID をコピー` を出す。右クリックでも同じメニュー。
3. **詳細欄**（折畳可）：行にポインタが 300 ms 乗ったら `json detail`（キャッシュ）で直近の指示・直近のツール・直近の応答・フォルダ・ID。
4. **ステータスバー**（最下段 1 行）：前面のターミナルタブのセッション（ターミナルが前面でなければ最後に前面だったもの）について `Opus 5 · high · ctx 42% · rc ● · 5h 37% · 7d 12%`。元は `status/<id>.json`（`model.display_name`・`context_window.used_percentage`・`rate_limits.five_hour/seven_day.used_percentage`・`effort` があれば）と `~/.claude/sessions/<pid>.json`（`bridgeSessionId` の有無 → rc）。モデルとエフォートは JSON に無ければ「デフォルト」と出す。コンテキスト・rc・利用率が取れなければ `—`。

サイドパネルは `workspace` の `layout-change`・`active-leaf-change` と `registry` の変化を購読して描き直す。

### 6.2 セッションマネージャー（`agent-sessions-manager`）

- 木：グループ（見出し、折畳）→ 単独 → その他のセッション（既定で折畳）→ アーカイブ（既定で折畳、ツールバーで表示切替）。各区分の中は最終更新順。「その他のセッション」に載るのは名前が無く `json scan` の `child` が偽のものだけ（無名の子セッションは出さない）。行は `状態の印  名前  MM-DD HH:MM  ▣`（`▣` はタブが開いている印）。
- ツールバー：`新規セッション`・`再走査`・`絞込`（名前の部分一致）・`アーカイブを表示`。
- 行クリック → `openSession(id)`（タブがあればジャンプ）。行を選択すると `⋯`：`名前を変更`・`圧縮`・`アーカイブ`⇄`アーカイブ解除`・（起動中なら）`セッションを終了`・`フォルダを開く`・`ID をコピー`。右クリックも同じ。
- 詳細欄：サイドパネルと同じ部品（一覧の下、折畳可）。
- 再走査のタイミング：ビューを開いたとき、再走査ボタン、`events.log` の追記（該当 ID だけ `--only`）、`~/.claude/sessions/` の変化（状態の更新のみ、走査はしない）、ビューが見えている間 60 秒毎。サイドパネルも同じ走査結果を共有する（`main.ts` が 1 つの `SessionIndex` を持ち、両ビューが購読）。

### 6.3 ターミナル（`agent-sessions-terminal`）

状態（`getState`）：`{id, agent, cwd, fontSize?, fresh?}`（`fresh` は新規で未起動のときだけ真。最初の `start` で消える）。Obsidian の workspace に保存され、再起動で戻る。

- xterm 5.x：`fontFamily`・`fontSize` は設定（タブ毎の `fontSize` があれば優先）、`lineHeight: 1.0`、`letterSpacing: 0`、`scrollback: 5000`、`allowProposedApi: true`、`macOptionIsMeta: true`、`cursorBlink: true`。アドオン：fit・webgl（失敗時は既定の canvas）・unicode11。
- 余白：設定 `padding`（`comfortable`＝12px／`compact`＝4px／`none`＝0）をコンテナの CSS 変数に流し、`fit()` は余白を除いた領域で計る。
- 接続：初回に ResizeObserver が 0 でない大きさを報告したとき `ensureAttached()`。デーモンに `id` があれば `attach`（終了済みなら再生の後に `exit` が届き終了画面になる）、無ければ `start`（`argv = [claudePath, '--resume', id]`、新規は `['--session-id', id]`）。デーモンに繋がらなければ起動を試み、1 秒待って再接続、3 回失敗で終了画面にエラー。
- 出力：`D` フレームを `terminal.write(Uint8Array)`。再生（`R`）中は `write` をまとめ、`replayed` で `scrollToBottom()`。
- 入力：`onData` の文字列を UTF-8 で `D`。`onBinary` も同様。
- サイズ：ResizeObserver → 50 ms デバウンス → `fit()` → `onResize` → `resize`。
- キー：`attachCustomKeyEventHandler` で処理する。Esc は `keyup` の伝播を止める（Obsidian がフォーカスを奪うため）。**Enter に Shift／Option／Cmd のいずれかが付いていたら ESC CR（`0x1b 0x0d`）を PTY へ書き**、既定動作と伝播を止める（Claude Code の meta+enter。`/terminal-setup` が VS Code に入れる shift+enter の送出列と同じ）。`Cmd + / − / 0` はフォントサイズ。**それ以外の Cmd 付きキーは伝播を止めず Obsidian に渡す**（xterm は Cmd の組合せに何も送らないため、止めると Cmd+W・Cmd+P が効かなくなる）。Ctrl・Option 付きと無修飾のキーは xterm に任せ、`keydown` の伝播を止めて Obsidian のホットキーに渡さない。
- 終了（`exit` イベント）：出力の上に「セッションは終了しました（code）」と **再開**・**閉じる**。再開は `forget` → `--resume` で `start`。閉じるは `forget` してタブを閉じる。
- タブを閉じる（`onClose`）：`detach` して接続を閉じ、xterm を `dispose`。セッションは残る。`SessionIndex`・`registry`・`statusline`・`settings-changed` の購読は `this.register(unsubscribe)` で登録してあり、Obsidian が `onClose` で解く。
- 設定の反映：`main.ts` が設定保存時に `settings-changed` を発火し、全ターミナルビューが `applySettings()` でフォント・サイズ（タブ毎の値があればそれ）・余白・スクロールバックを xterm に当てて `fit()` する。
- ヘッダの操作（`addAction`）：`@`（現在のノートを挿入）・前の指示・次の指示・最後の応答。セッションへの操作（名前変更・圧縮・アーカイブ・終了）はサイドパネルとマネージャーの行メニューに集約する。
- タブのアイコンと題名：題名はセッション名（無ければ `無題 ` + ID 先頭 8 桁）。アイコンは `bot`。状態 `busy`／`shell` の間は CSS でアニメーション（`.agent-sessions-busy` をタブ見出しのアイコン要素に付ける。要素は `leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-icon')` で取り、無ければクラスは付けずアイコンの差し替えだけにする）。終了済み（デーモンの `list` の `exited`）は `circle-off`。`busy → idle` に落ちたときにそのタブが前面でなければ `.agent-sessions-waiting`（アイコン `message-circle`）にし、前面になったら戻す。

### 6.4 1 セッション＝1 タブ

`openSession(id)`：`workspace.getLeavesOfType('agent-sessions-terminal')` から `view.state.id === id` の leaf を探し、あれば `revealLeaf` して終わり。無ければメインエリアに `workspace.getLeaf('tab')` で leaf を作り `setViewState`。新規セッションも同じ経路（先に `sessions.json` の `sessions[id]` を書く）。

- 多重呼出：`opening: Map<id, Promise<WorkspaceLeaf>>` を持ち、同じ `id` の呼出が進行中ならその Promise を返す。`setViewState` が終わってから Map から消す。
- `openSession` を通らない経路（タブの「右に分割」「複製」「新しいウィンドウへ」は同じ state で leaf を作る）：`TerminalView.setState` で、同じ `id` を持つ別の leaf が既にあれば、自分の leaf を `detach()` してその leaf を `revealLeaf` する。これで同じ `id` のターミナルは常に 1 つ。

### 6.5 状態と通知

- `registry.ts`：`fs.watch(~/.claude/sessions)` を 200 ms でまとめ、全 `*.json` を読み `sessionId → {status, pid, bridgeSessionId, updatedAt}`。pid が生きているか `process.kill(pid, 0)` で確かめ、死んでいる台帳は無視。
- 状態の遷移 `busy|shell → idle` で、そのセッションのタブが前面でない（または Obsidian が非アクティブ）なら `Notice`（クリックで `openSession`）。設定で切れる。
- 3 つのビューは `registry` の変化イベントを購読して印を更新する。
- 終了済みの後始末：`onLayoutReady` と `layout-change` で、デーモンの `list` の `exited` のうちターミナルタブが無い `id` に `forget` を送る。タブがある `id` は、そのタブが「再開」「閉じる」で `forget` するまで残す。

### 6.6 名前変更・圧縮・終了・アーカイブ

- `/rename NAME`・`/compact` は PTY へ `文字列 + CR` を書く。送る条件：デーモンにセッションがあり、状態が `idle`。満たさなければ名前変更は `pendingRenames` に入れ、次に attach して状態が `idle` になった 1 秒後に送る。圧縮は「待機中でないと送れない」と `Notice`。
- 送った後 `events.log` の次の追記で `--only` 再走査し、名前が transcript に現れたら `pendingRenames` から消す。
- 新規セッション：ダイアログ（名前・開始ボタン）。`id = crypto.randomUUID()`、`sessions[id] = {agent:'claude', cwd: vault}` を書き、名前があれば `pendingRenames[id]` に入れ、`openSession(id)`。タブが `start` し、最初の `idle` で `/rename` が送られる。
- セッションを終了：確認 → `kill` → `exit` イベント → 終了画面。
- アーカイブ：`sessions.json` の `archived` に入れる。起動中でもタブがあっても構わない（一覧から消えるだけ）。解除はマネージャーのアーカイブ区分から。

### 6.7 リンクと `@` とジャンプ

- リンク（`links.ts`）：`registerLinkProvider`。行から `[\w./~\-]+(?:\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?` を候補にし、絶対パスは vault 配下なら相対に、相対はセッションの `cwd` から vault 相対に直し、`vault.getAbstractFileByPath` で実在するものだけリンクにする。クリックで `openLinkText`（メイン領域）、行番号があれば `editor.setCursor`。
- `@` 挿入：コマンド「Agent Sessions: 現在のノートを @ で挿入」とヘッダの `@`。対象はアクティブな Markdown ビューのファイル。パスはセッションの `cwd` からの相対（`cwd` の外なら絶対）。エディタの選択が複数行なら `#L{from}-{to}`。空白を含むパスは引用符で囲む。PTY へ `@path ` を書き、ターミナルにフォーカスを移す。
- ジャンプ（`marks.ts`）：`onData` に CR が含まれ、かつ括弧付きペースト中でないとき `registerMarker(0)` を「指示」として記録。`registry` の `idle → busy` で `registerMarker(0)` を「応答の先頭」として記録（最後の 1 つを保持）。前の指示＝現在の表示先頭より上で最も近いマーカー、次の指示＝表示先頭より下で最も近いマーカー、最後の応答＝応答マーカー。`scrollToLine(marker.line)`。破棄済みマーカーは捨てる。

### 6.8 Enter の役割（送信／改行）

Claude Code は `~/.claude/keybindings.json`（`$CLAUDE_CONFIG_DIR` 配下。vault の `.claude/` は読まない）の `Chat` コンテキストで `enter → chat:submit`、`ctrl+j → chat:newline` を既定とし、キーはコンテキスト毎に付け替えられる。プラグインはこのファイルで「Enter の役割」を切り替える。Claude Code 全体の設定なので、iTerm など他の端末の claude にも効く。

- **設定画面の表示**：開くたびに `keybindings.json` を読み、`Chat` の `enter` を解釈して現在値を出す。
  - `enter` が無い、または `chat:submit` → **送信**
  - `enter` が `chat:newline` → **改行**
  - それ以外（`null` や別のアクション）→ **カスタム**（`enter → <値>` をそのまま表示。プラグインからは変更しない）
  - ファイルが無い → 送信。JSON が壊れている → 「読めない」と表示し変更を受け付けない。
- **改行に切り替える**：確認（「Claude Code 全体に効く」旨）→ 読み込み → `Chat` ブロック（無ければ作る）に `enter: chat:newline`、`shift+enter: chat:submit`、`meta+enter: chat:submit` を入れ、他の鍵は触らずに書く（`$schema`・`$docs` が無ければ足す）。
- **送信に戻す**：`Chat` の `enter`・`shift+enter`・`meta+enter` が上の値と一致するものだけ消す。空になった `Chat` ブロックは消す。一致しない鍵は残して「手で直す必要がある」と `Notice`。
- 改行モードのときの Shift／Option／Cmd+Enter は、ターミナルが ESC CR（meta+enter）を送るので Claude Code 側で `chat:submit` になる。

### 6.9 設定

| 項目 | 既定 |
|---|---|
| フォント | `Menlo, "Hiragino Sans", monospace` |
| フォントサイズ | 13 |
| 余白 | ゆったり（`comfortable`／`compact`／`none`） |
| Enter の役割 | 送信（§6.8。実体は `keybindings.json`） |
| 最近の件数（サイドパネル） | 10 |
| 指示待ちの通知 | オン |
| `claude` のパス | 空＝ログインシェルで `command -v claude` |
| `agent-sessions` のパス | 空＝`~/bin/agent-sessions` |
| Python のパス | `/usr/bin/python3` |
| スクロールバック行数 | 5000 |

### 6.10 テーマ

`theme.ts` が Obsidian の CSS 変数（`--background-primary`・`--text-normal`・`--text-accent`・`--text-selection`）から `background`・`foreground`・`cursor`・`selectionBackground` を作る。ANSI 16 色は明暗それぞれの固定表。`css-change` で再適用。

## 7. エラー処理

| 事象 | 振る舞い |
|---|---|
| デーモンに繋がらない | 起動を試みる。3 回失敗で終了画面に理由（Python が無い・ソケットが作れない） |
| `claude` が見つからない | 終了画面に「claude が見つからない」と設定へのリンク |
| `--resume` が失敗（transcript 消失） | claude の出力をそのまま見せ、終了画面に「新規として開始」を足す |
| `json scan` が失敗 | 一覧に前回の結果を残し、`Notice` に stderr の先頭行 |
| `sessions.json` が壊れている | `.broken-<時刻>` に退避して初期化 |
| `keybindings.json` が読めない | 設定画面に「読めない」と出し、Enter の役割は変更不可 |
| `sessions.json.lock` が 2 秒取れない | 書込みを諦めて `Notice`。10 秒より古いロックは壊れたものとして消す |
| デーモンの二重起動 | 後発が `flock` に失敗して即終了。プラグインは 1 秒待って再接続 |
| `exited.json` が壊れている | `.broken-<時刻>` に退避して空で始める（デーモンは起動する） |
| WebGL が使えない | canvas に落ちる（ログのみ） |

## 8. テスト

- Python（unittest、`-W error`）：既存 90 件を移設。追加：`protocol`（フレームの分割・結合）、`daemon`（`cat` を子にした start/attach/replay/resize/kill/forget、バッファ上限、複数接続と最小サイズ、切断の後始末、終了済みへの attach、`exited.json` の書き出しと読み込み）、`store` のロック（2 プロセスで同時に書く）、`setup`（settings.json の置換と backup）、`store`（sessions.json、旧 md の取り込み）、`cache`、`jsonout`、`tui` のパネル幅。
- TypeScript（vitest）：`tree`、`index`（開いているタブ／起動中／最近の区分け）、`links`、`marks`、`keybindings`（読解・書換・戻し）、`daemon-client` のフレーム、`statusline` の整形、`store` の読み書きとロック（tmp dir）、旧 md の取り込み、`openSession` の多重呼出（モックの workspace）。
- 手動：`requirements.md` の「受け入れの確認」。

## 9. 段 2 以降への接続

- 外部エディタ：デーモンが `env` に `VISUAL=agent-sessions edit` を足せるよう `start` の `env` はプラグインが組む。`agent-sessions edit` はソケット（デーモンとは別、`~/.agents/sessions/plugin.sock`、プラグインが待ち受け）へ依頼し、プラグインはターミナルビューの中に編集領域を割って開く（ターミナルは残る）。
- Codex：`agent` フィールド、`argv` の組み立て、走査元（`~/.codex/sessions`）を `agentsessions/agents/<name>.py` に分ける。段 1 では `claude.py` のみ。
- トークン集計：transcript の `usage` を区間で集計する `json usage ID [--from TS --to TS]` を足す。

## 10. 内蔵エディタ（段 2）

### 10.0 Claude Code 側の事実（binary 2.1.270 で確認）

- 外部エディタは `$VISUAL` → `$EDITOR` の順。文字列を空白で分割し、`spawnSync(cmd, [...args, tmpfile], {stdio:'inherit'})` で**終了を待つ**。終了コード 0 でファイルを読み戻す。非 0・シグナルなら「quit unexpectedly」と出て元の内容のまま。
- 実行ファイルの basename に `code`／`cursor`／`windsurf`／`codium`／`subl`／`atom`／`gedit`／`notepad` を含むと GUI エディタ扱いで、代替スクリーンに**切り替えない**（`prepareTerminalForHandoff`）。含まなければ代替スクリーンに切り替える（編集中はターミナルの表示が消える）。
- `/memory` も同じ経路。

### 10.1 実行ファイルと環境

- `bin/agent-sessions-code`（sh、`exec "$(dirname "$0")/agent-sessions" edit "$@"`）。`install.sh` が `~/bin/agent-sessions-code` に symlink。名前に `code` を含めるのは上の判定に乗るため。
- プラグインはデーモンの `start` の `env` に `VISUAL=<~/bin/agent-sessions-code の絶対パス>` を足す（`EDITOR` は触らない）。パスに空白があってはならない（`~/bin` は空白なし）。
- `agent-sessions edit FILE`（`agentsessions/cmd_edit.py`）：
  1. `~/.agents/sessions/plugin.sock` に接続し、`J {"op":"edit","seq":1,"file":FILE,"session":$AGENT_SESSIONS_ID,"cwd":os.getcwd()}` を送る。
  2. 応答 `{"ok":true}` で 0。`{"ok":false,"error":"cancel"}` は **1 で終わる（vi は開かない。Claude は元の内容を使う）**。`error` が `no-tab`／`busy` なら 3 へ。応答が来るまで待つ（タイムアウト無し。Ctrl+C／`SIGTERM` で `{"op":"cancel"}` を送って 1）。**接続が確立した後に相手が消えた（`recv` が空・`ECONNRESET`）ときも 3 へ倒す**（Obsidian のクラッシュ）。
  3. 接続できない・EOF・`no-tab`／`busy` なら**従来のエディタに倒す**：`$AGENT_SESSIONS_FALLBACK_EDITOR`、無ければ `vi` を `execvp`（同じ端末で開く）。
- `AGENT_SESSIONS_ID` はデーモンが `start` で環境に入れる（段 1 のとおり）。

### 10.2 プラグイン側ソケット

- `src/edit-server.ts`：`net.createServer` を `~/.agents/sessions/plugin.sock` で listen（`onload` で古いソケットを unlink、`onunload` で close と unlink、`umask` 相当として作成後 `chmod 0600`）。フレームは `daemon-client.ts` の `encodeFrame`／`FrameDecoder` を共用（J のみ）。
- 要求 `edit`：`session` に対応するターミナルビューを探す。無ければ `{"ok":false,"error":"no-tab"}`。あれば `view.openEditor(file, cwd)` を呼び、送る／取消の結果で `{"ok":true}`／`{"ok":false,"error":"cancel"}` を返して接続を閉じる。同じタブで編集中に 2 つ目が来たら `{"ok":false,"error":"busy"}`。
- 接続が先に切れたら（claude 側の中断）編集領域を閉じる。
- **タブ側が先に閉じるとき**（`onClose`、プラグインの `onunload`、`plugin.sock` の close）は、進行中の編集に対して元の内容を一時ファイルへ書き戻し `{"ok":false,"error":"cancel"}` を返してから閉じる。`agent-sessions edit` は 1 で終わり、Claude Code は固まらず元の内容を使う。編集中の状態はビューの `pendingEdit` 1 つに集約し、閉じる経路すべてがそれを解決する。

### 10.3 編集領域

- ターミナルビューの本体を上下に割る：上＝xterm（残り全部）、下＝編集領域（高さは設定 `editorHeight`、既定 40%、最小 6 行）。開くときに `fit()` を呼び直し、閉じたら戻す。
- 編集領域は `<textarea>`（ネイティブのペースト・IME・Undo を使う。Markdown の扱いは最小限）。等幅フォント（ターミナルと同じ設定）。開いたら一時ファイルの内容を入れてフォーカス、末尾にカーソル。
- 上部に 1 行のバー：ファイル名（basename）・「送る（⌘⏎）」・「取消（Esc）」。
- 自動保存：`input` を 300 ms でデバウンスし、一時ファイルへ tmp→rename で書く。
- 送る：最後の内容を書いてから `{"ok":true}`。取消：**元の内容を書き戻して**から `{"ok":false,"error":"cancel"}`（Claude は非 0 で元の内容を使うが、念のためファイルも戻す）。どちらも編集領域を閉じてターミナルに focus。
- キー：`Cmd+Enter`＝送る、`Esc`＝取消。どちらも IME 変換中（`isComposing`／`keyCode 229`）は無視する。他は textarea の既定。`keydown` の伝播は止める（Obsidian のホットキーに渡さない。Cmd+V／C／X／Z／A は textarea のネイティブ動作）。
- `@` 補完：検索語の更新は `input` イベントのうち `isComposing` でないものと `compositionend` で行う（IME の変換中の断片では候補を更新しない）。`@` を打った直後から次の空白までを検索語にし、textarea の直下に候補リスト（最大 8 件）を出す。候補は `app.vault.getFiles()` を `prepareFuzzySearch` で絞り、表示は vault 相対パス。↑↓ で選び、Enter／Tab で確定（`@` から検索語までを、`cwd` から見た相対パス（`path.relative(cwd, vaultPath/…)`、空白があれば `"…"`）＋空白に置き換える）。Esc で候補を閉じる（編集は続く）。候補が開いている間の Enter は確定であって送信ではない。
- `bracketed paste` は関係しない（textarea へのペースト）。

### 10.4 テストと受け入れ

- Python：`tests/test_edit.py` — 偽ソケットサーバーで `ok:true`→0、`cancel`→1（`execvp` を呼ばない）、`no-tab`／`busy`→fallback（`execvp` をモック）、接続不可→fallback、EOF→fallback。
- TS：`test/edit-server.test.ts`（フレームの往復とハンドラの分岐：no-tab／busy／ok／cancel）、`test/at-complete.test.ts`（検索語の切り出し、置換結果、空白の引用）。
- Obsidian：実機で Ctrl+G → 編集領域 → `@` 補完 → 送る／取消。編集中にタブを閉じて Claude Code が固まらず元の内容のまま戻る（`vi` は開かない）。段 1 のテスト全通し。

### 10.9 採らなかった案

| 案 | 理由 |
|---|---|
| CodeMirror 6 の編集領域 | ペースト・IME・Undo はネイティブの textarea で足りる。Obsidian が公開する CM パッケージの範囲が不確かで、要件は「Markdown は暫定で良い」 |
| Obsidian の Markdown エディタで開く | vault 外の一時ファイルを `TFile` として開けない |
| 代替スクリーンの制御列をプラグインで削る | 実行ファイル名で GUI 扱いにする方が確実。判定が変わったときの予備 |
| 別 leaf に編集領域を開く | ターミナルを隠さないという要件は同じタブの上下分割が最も確実 |

## 11. トークン集計（段 4）

### 11.1 事実

`assistant` 行の `message.usage`（`input_tokens`・`cache_creation_input_tokens`・`cache_read_input_tokens`・`output_tokens`、`output_tokens_details.thinking_tokens`）は同じ `message.id` が複数行に現れ、内容は同一。`message.model` が `<synthetic>` の行は API 呼出ではない。`isSidechain`（サブエージェント）・`isMeta` の行は数えない。

### 11.2 `agent-sessions json usage ID [--from ISO] [--to ISO]`

`agentsessions/usage.py`：transcript を先頭から読み、人の指示（`detail.is_human_prompt`）でターンを切る。以後の `assistant` 行の usage を `message.id` で重複排除してターンに足す。最初の指示より前の usage は「（開始前）」のターン（index −1）。出力 `{"turns":[{index, ts, prompt, calls, input, cache_create, cache_read, output, thinking, models}], "total":{…}, "from", "to"}`。`--from`／`--to` はターン開始時刻に当てる（両端含む）。`turns` は常に全部返し、`total` だけが区間の合計。

### 11.3 プラグイン

行メニュー「トークン集計」→ モーダル（`src/usage-modal.ts`）。上に区間の合計、「から」「まで」のドロップダウン（ターン #）、「全体」「コピー」、下にターンの表。合計の計算と Markdown 化は `src/usage.ts` の純関数（`sumRange`・`toMarkdown`。表は区間のターンだけ）。

## 12. 改修（段 5：2026-09-16 の指示）

### 12.1 事実と判断

- **コスト**：`message.usage` に価格（$/MTok）を掛ける。価格表は Python 側（`agentsessions/pricing.py`）に置き、`json usage` が `cost` を返す。単価は入力・出力を表で持ち、cache 作成 5 分＝入力×1.25、1 時間＝入力×2、cache 読出＝入力×0.1（例外は表に明記）。モデル ID の前方一致で引く（長い方を優先）：

| ID の前方 | 入力 | 出力 | cache 読出 |
|---|---|---|---|
| `claude-fable-5-1`・`claude-mythos-5-1` | 10 | 50 | 0.25（例外） |
| `claude-fable-5`・`claude-mythos-5` | 10 | 50 | 1.0 |
| `claude-opus-5`・`claude-opus-4-8`・`claude-opus-4-7`・`claude-opus-4-6`・`claude-opus-4-5` | 5 | 25 | 0.5 |
| `claude-opus-4-1`・`claude-opus-4` | 15 | 75 | 1.5 |
| `claude-sonnet-5` | 2 | 10 | 0.2 |
| `claude-sonnet-4-6`・`claude-sonnet-4-5`・`claude-sonnet-4`・`claude-3-7-sonnet` | 3 | 15 | 0.3 |
| `claude-haiku-4-5` | 1 | 5 | 0.1 |
| `claude-3-5-haiku` | 0.8 | 4 | 0.08 |
| `claude-3-haiku` | 0.25 | 1.25 | 0.03 |
`cache_creation.ephemeral_1h_input_tokens` があれば 1 時間の単価、残りは 5 分。未知のモデルは Opus の単価で見積もり `estimated: true`。
- **ツール使用**：`assistant` 行の `content` の `tool_use` ブロックを名前で数える（`message.id` で重複排除）。
- **期間**：最初の指示から最後の assistant 行までの経過。
- **セッション制限**：`status/<id>.json` の `rate_limits.five_hour/seven_day.{used_percentage, resets_at}`。アカウント共通なので、`rate_limits` を持つファイルのうち最新の mtime のものから取る（前提：アカウントを切り替えて並行使用しない）。カウントダウンは 1 秒毎に `resets_at − now`。
- **Ctrl+S の事実（実機で確認、Claude Code 2.1.276）**：`~/.claude/keybindings.json` の `Chat` に `chat:stash`（既定 `ctrl+s`）がある。入力中に `\x13` を送るとプロンプトの右上に「› stashed」と出て入力欄が空になり、もう一度 `\x13` で下書きが戻る。stash したまま別の指示を送ると、送信の後に下書きが自動で戻る（「Draft restored」）。Claude Code は端末を raw mode にするので XOFF にはならない。下書きが空で退避も無いときの `\x13` は何もしない。
- **`/compact`・`/rename` の送り方**（`main.ts` の `sendCommand(id, text)`）：
  1. タブがあり attach 済み → xterm の画面で入力行（最後の `❯ ` の行）が空か見る。空でなければ `\x13`（Ctrl+S＝`chat:stash`、下書きを退避）。コマンドは **bracketed paste**（`\x1b[200~` + text + `\x1b[201~`。文字を打つと `/` の補完が開いて壊れる）で入れ、送信キーを送る。**復元は送らない**：Claude Code は stash した下書きを次の送信の後に自動で戻す（「Draft restored」）。
  2. タブは無いがデーモンにある → 一時的に attach して同じ手順（画面が無いので `\x13` を無条件に送る。下書きが無ければ何も起きない）。
  3. デーモンに無い → **裏で起動**：`start`（`--resume`）→ registry の状態が `idle` になったら送信 → `idle` に戻ったら `/exit` を送信 → `exit` で `forget`。進行は `Notice` で知らせる（「名前を変更しています…」）。
  - 「状態が `idle` になったら」は**遷移イベントではなく状態を待つ**：`registry.waitFor(id, 'idle', timeoutMs)`（`refresh` のたびに `get(id)?.status` を見る。初めて観測する id でも成り立つ。既定 60 秒で諦めて `Notice`）。`Registry.refresh()` は、初めて現れた id が `busy` ならその時点で `busy` を発火する（応答マーカーが新規セッションでも記録されるように）。
  - 新規セッション（名前つき）は、`start` の後に同じ `waitFor(id,'idle')` → `sendCommand(id, '/rename NAME')`。`pendingRenames` は使わない。
  - 送信キー：設定の改行キーが `enter` なら `\x1b\r`（meta+enter＝送信）、それ以外は `\r`。
  - 直近の指示が `/compact` かどうかは `json detail` の `last_user`（`clean_text` 後）で判定。`pendingRenames` は廃止（`store` の項目は読み飛ばし、書かない）。
- **fullscreen レイアウト**：`~/.claude/settings.json` の `"tui": "fullscreen"` のとき、Claude Code は全面再描画でスクロールを自前で持ち、xterm のスクロールバックには溜まらない（`buffer.length === rows`）。この状態ではマーカー方式のジャンプは成り立たないので、3 つのボタンは Claude のスクロールキー（PageUp・PageDown・End）を送る。
- **分割**：`TerminalView.setState` の「同じ id の別 leaf があれば自分を閉じる」を外す。`openSession` は既存タブへ移動のまま（重複を作らない）。⋯ の「右に分割」「下に分割」は `app.workspace.duplicateLeaf(leaf, 'vertical' | 'horizontal')`。Obsidian 標準の「タブを複製」も同様に複数ビューになる（許容。どれも同じセッションに attach し、閉じれば detach）。複数ビューはそれぞれ attach（デーモンの最小サイズ規則）。
- **改行キー**：設定 `newlineKey`（5 択、既定 `shift+enter`）。ターミナルは、押されたキーが `newlineKey` なら `\x1b\r`（Claude の meta+enter＝改行）を送る。`enter` を選んだときだけ `keybindings.json` の `Chat` に `enter: chat:newline`・`meta+enter: chat:submit` を書き、送信キーは設定 `submitKey`（`meta+enter`／`ctrl+enter`／`shift+enter`／`super+enter`、既定 `super+enter`）で、押されたら `\x1b\r` を送る。`enter` 以外を選んだら `keybindings.json` から自分が書いた 2 鍵を消す。Option+Enter は xterm が元々 `\x1b\r` を送るので、設定に関わらず改行になる（設定画面に注記）。設定画面はこれまでどおり開くたびに `keybindings.json` を読む。
- **`@`**：`workspace.activeEditor` はターミナルにフォーカスがあると null。`main.ts` が `active-leaf-change` で最後に前面だった Markdown leaf（`MarkdownView`）を覚え、`lastMarkdownView()` として公開する。ターミナルのヘッダの `@` とコマンド `insertNoteAt` の両方がこれを使う。
- **ジャンプ**：指示マーカーは `onData` に `\r` が含まれたときに記録しているが、`\x1b\r`（改行）も `\r` を含むため誤記録し、送信の `\r` は `sendInput` 経由で `onData` を通らない。`handleKey` が **無修飾の Enter も横取り**して（IME 中を除く）`sendSubmit()` を呼び、修飾つきの送信キーも同じ関数を通す。`sendSubmit()` が送信列を書き、指示マーカーを記録する。`onData` からの `\r` 記録は消す。応答マーカーは registry の `busy`（初回観測を含む、上の修正）。ジャンプは `scrollToLine(marker.line)`。
- **余白のスクロールバー**：`.agent-sessions-terminal-body` に `overflow: hidden`、`fit()` は padding を引いた領域で計算（`FitAddon` は要素の `padding` を見るので、padding を xterm の親ではなく外側の要素に付ける）。
- **エディタ中のキー**：`pendingEdit` がある間は `attachCustomKeyEventHandler` で全部 `false`（xterm に渡さない）にし、`onData` も捨てる。
- **`statusLine`**：`agent-sessions status` の 1 行を `Opus 5 · high · ctx 6% · rc ●` に（effort は `effort.level`、rc は `~/.claude/sessions/*.json` の `sessionId` 一致行の `bridgeSessionId`）。
- **詳細ビューの総トークン・総コスト**：選択（または前面）のセッションについて `json usage` を呼ぶ（キャッシュ 60 秒）。
- **サイドパネルの領域**：CSS grid の行 `auto 1fr <detailHeight> auto`。一覧と詳細の間に 4px のハンドル（`mousedown`→`mousemove` で `detailHeight` を更新、`mouseup` で設定に保存 `sideDetailHeight`、既定 220px、最小 80px）。

### 12.2 作り

#### 12.2.1 Python：`json usage` の拡張・`status` の 1 行（I-60, I-62, I-67）

- `agentsessions/pricing.py`：`price_of(model) -> {input, output, cache_5m, cache_1h, cache_read, estimated}`（$/MTok）。`cost(usage_dict, model) -> float`。
- `usage.py`：各ターンに `cost`（$）・`tools: {name: count}`・`models` を、`total` に `cost`・`tools`・`duration`（秒）・`first_ts`・`last_ts`・`context_last`（最後の呼出の `input + cache_read + cache_create`）を足す。`estimated: true` を持つターンがあれば `total.estimated = true`。
- `hooks.format_status_line`：`モデル · エフォート · ctx NN% · rc ●/○`。
- テスト：`test_pricing.py`（各表・1h・未知モデル）、`test_usage.py`（cost・tools・duration）。

#### 12.2.2 プラグイン：設定とキー（I-68）

- `settings.ts`：`newlineKey`（既定 `shift+enter`）・`submitKey`（既定 `super+enter`、`newlineKey === 'enter'` のときだけ表示）・`sideDetailHeight`・`pythonPath` の既定 `''`。`enterMode` の設定項目は廃止し、`keybindings.ts` は `applyNewlineKey(path, newlineKey)`（`enter` なら 2 鍵を書き、それ以外なら自分の 2 鍵を消す）に変える。
- 設定タブの文言：「Enter を改行にする場合は `~/.claude/keybindings.json` に書くため、他のターミナルアプリで起動した claude にも効きます」「空欄時のデフォルト: $(which claude)」「空欄時のデフォルト: ~/bin/agent-sessions」「空欄時のデフォルト: /usr/bin/python3」。
- `views/terminal.ts` の `handleKey`：Enter の修飾（shift／alt／ctrl／meta）を `newlineKey`／`submitKey` に照合。`sendSubmit()` を 1 箇所に集約（マーカー記録もここ）。

#### 12.2.3 プラグイン：セッションタブ・コマンド送信・名前変更・圧縮（I-64, I-65, I-66）

- `main.ts`：`sendCommand(id, text)`（上の 3 経路）、`renameSession`・`compactSession` はこれを使う。`pendingRenames` の送信・確定の仕組みを外す（`index.ts` の `PendingRenamer` も外す）。`RenameModal`：広い入力（`width: 100%`）、「変更」「キャンセル」、Enter では確定しない。
- `views/terminal.ts`：余白のスクロールバー、エディタ中のキー遮断、`@`（最後の Markdown leaf）、ジャンプ、⋯ メニュー（`onPaneMenu`：Obsidian 標準の項目（右に分割・下に分割を含む）の後に **区切り線**／名前を変更／セッションを圧縮／セッション解析結果を表示／ID をコピー）、`setState` の自己閉鎖を外す。
- `rows.ts` の行メニュー：「圧縮」→「セッションを圧縮」（直近が `/compact` なら `setDisabled(true)`）、「トークン集計」→「セッション解析結果」、「フォルダを開く」を外す。`rows.ts` の `renderDetailPane` と `pendingRename`（「（未適用）」）の表示は消し、詳細は `views/detail.ts` に一本化する（T-43 で置き換え）。

#### 12.2.4 プラグイン：サイドパネル（I-61, I-62）

- `views/side.ts`：4 領域の grid、ナビ（`＋` `layout-grid`（マネージャー） … `⋯`：設定・再走査）、一覧（行の右に常に `⋯`）、ハンドル、詳細、制限ビュー。
- `views/detail.ts`（新規、共通部品）：名前・バッジ（モデル／エフォート／rc）・円グラフ（SVG、`ctxPercent`）・総トークン／総コスト（`json usage` を 60 秒キャッシュ）・直近の指示／応答（`-webkit-line-clamp: 6`、クリックで展開）・ツール・フォルダ・ID。
- `views/limits.ts`（新規）：5h／7d のバー＋`used%`＋「リセットまで h:mm:ss」（1 秒更新。`resets_at` が無ければ「—」）。

#### 12.2.5 プラグイン：マネージャー（I-63）

- `views/manager.ts`：左＝表（グループ見出し行に件数と折畳、行＝印・名前・最終更新・フォルダ；選択行の強調；↑↓ で移動、Enter で開く、`/` で絞込にフォーカス）、右＝詳細パネル（`views/detail.ts`）。ツールバー：`＋`・`再走査（rotate-cw）`・絞込・`⋯`（「アーカイブを表示」チェック）。CSS は `agent-sessions-manager` 配下で独自（罫線・等幅の日時列）。

#### 12.2.6 プラグイン：セッション解析結果（I-60）

- `usage-modal.ts` を作り直す：`modalEl.addClass('agent-sessions-usage-modal')`（CSS：`width: 90vw; max-width: 1100px`）。固定ヘッダ（題名「セッション解析結果：<名前>」・コピー・閉じる）。要約カード 4 枚（コスト $・トークン（入力合計、下に出力）・ターン数・期間）。入力バー（cache 読出／cache 作成／非キャッシュの割合、凡例に数）、出力バー。ツール使用（横バー、上位 12）。ターン表（#・時刻・指示（`text-overflow: ellipsis`、ホバーで全文）・入力・出力・コスト）。区間：行クリックで開始、次のクリックで終了（範囲を強調）、もう一度で解除。カードとバーは区間の値、副題に「#a〜#b」。読み込み中は本文だけに表示し、完了で消す。`usage.ts` に `formatK`（1,234→1.2k、1,234,567→1.2M）・`sumRange` に cost・tools を足す。

#### 12.2.7 文書・記録

- `docs/design.md` §6・§10・§11 を更新、`docs/requirements.md` の R-S6・R-S8・R-T5b を現状に合わせる。README。`plan/04-実行記録.md` に I-60〜I-69。
