# Agent Sessions 設計

要件は `requirements.md`。

## 1. 概要

Obsidian の中で Claude Code のセッションをターミナルタブとして開き、管理する。
4 つの実体が 1 つの道具になる：

- **デーモン**（`agent-sessions daemon`）：PTY を保持し続ける常駐プロセス。プラグインだけが起動する。
- **CLI／`json` 出力**（`agent-sessions` バイナリ）：走査・集計をすべて Python 側に持ち、プラグインは JSON を受け取って描くだけにする。
- **フック／`statusLine`**（`agent-sessions hook` / `status`）：Claude Code の `settings.json` から呼ばれ、状態とトークン使用量をファイルに落とす。
- **プラグイン**（Obsidian、TypeScript）：一覧・ターミナル描画・タブ管理・復元・通知・`sessions.json` の書込。

走査・判定・集計のロジックは Python 側にだけ置く（`agentsessions/`）。プラグインはその JSON を表示し、`sessions.json` を書き、PTY をターミナルとして描く。

```
agent-sessions/
├── plugin/                    Obsidian プラグイン（TypeScript, esbuild, vitest）
│   ├── src/
│   │   ├── main.ts            Plugin 本体：ビュー登録・コマンド・設定・openSession・sendCommand
│   │   ├── settings.ts        設定の型・既定値・設定タブ
│   │   ├── store.ts           <vault>/.agents/sessions/sessions.json の読み書き・ロック
│   │   ├── backend.ts         `agent-sessions json …` の呼び出しと結果の型
│   │   ├── daemon-client.ts   Unix ソケットのクライアント（フレーム・attach・resize）
│   │   ├── edit-server.ts     `~/.agents/sessions/plugin.sock`（内蔵エディタの受け口）
│   │   ├── registry.ts        ~/.claude/sessions/*.json の監視（状態・pid・rc）
│   │   ├── statusline.ts      ~/.agents/sessions/status/<id>.json の監視
│   │   ├── ui-state.ts        ~/.agents/sessions/ui.json の書込（statusLine への送信キー記号）
│   │   ├── vault-state.ts     ~/.agents/sessions/vault.json の書込（vault の場所。T-80）
│   │   ├── tree.ts            JSON → グループ木・サイドの 3 区分（純関数。splitName・OTHER_GROUP・buildManagerTree・buildSideList）
│   │   ├── category.ts        カテゴリの固定色（パレット番号の割当）
│   │   ├── chip.ts            カテゴリのチップ描画（サイド・マネージャー・ダイアログ共通）
│   │   ├── name.ts            名前の分解・命名ダイアログの入力トークナイズ
│   │   ├── keys.ts            Enter の分類・送信キーの動作決定・keybindings.json との整合・非macOS の Ctrl キー分類
│   │   ├── terminal-status.ts タブの状態を 1 つに決める純関数（`TerminalStatus`）
│   │   ├── attention.ts       asking／waiting の集計（サイドのバッジ・マネージャー見出しの印）
│   │   ├── compacted.ts       ~/.agents/sessions/compacted/ の監視（compact 直後の印）
│   │   ├── autosave.ts        内蔵エディタの自動保存デバウンス（`SaveDebouncer`）
│   │   ├── links.ts           出力中のパス検出と vault 内解決（純関数）
│   │   ├── at-complete.ts     `@` 補完の検索語切出しと置換（純関数）
│   │   ├── marks.ts           指示／応答のマーカー管理（純関数＋xterm 依存の薄い層）
│   │   ├── index.ts           SessionIndex：走査結果＋起動中＋タブの合成、購読、waitForName
│   │   ├── open-session.ts    openSession・多重呼出の抑止（純関数寄りの薄い層）
│   │   ├── keybindings.ts     ~/.claude/keybindings.json の読解と書換
│   │   ├── tui-mode.ts        ~/.claude/settings.json の `tui` が `fullscreen` かの判定
│   │   ├── types.ts           `json` 出力の型
│   │   ├── usage.ts / usage-modal.ts   セッション解析結果（合計・整形・モーダル）
│   │   ├── i18n.ts            日英辞書と `t()`
│   │   ├── theme.ts           Obsidian の CSS 変数 → xterm テーマ
│   │   ├── views/side.ts      サイドパネル（骨組み・一覧の描画・バッジ）
│   │   ├── views/side-list.ts サイドパネルの 3 区分の組み立て（純関数。`buildSideList` を呼ぶ）
│   │   ├── views/manager.ts   セッションマネージャー（骨組み・描画）
│   │   ├── views/manager-model.ts  マネージャーの表を 1 本に平らにする純関数
│   │   ├── views/detail.ts    詳細欄（サイド・マネージャー共通部品）
│   │   ├── views/limits.ts    5h／7d のバー・カウントダウン
│   │   ├── views/terminal.ts  ターミナルビュー
│   │   ├── views/editor-pane.ts  内蔵エディタの編集領域
│   │   ├── views/rows.ts      行・行メニュー（共通部品）
│   │   └── modals.ts          新規セッション・名前変更のダイアログ
│   ├── test/                  vitest（純関数・daemon-client のフレーム・DOM の薄い層）
│   ├── manifest.json          id: agent-sessions / name: Agent Sessions / isDesktopOnly: true
│   ├── styles.css
│   ├── esbuild.config.mjs     → plugin/main.js
│   └── package.json
├── bin/agent-sessions          #!/usr/bin/python3。agentsessions.cli.main を呼ぶ
├── bin/agent-sessions-code     内蔵エディタ用の `$VISUAL`（sh、名前に `code` を含める）
├── agentsessions/               Python パッケージ（標準ライブラリのみ）
│   ├── config.py               パス定数（VAULT, STORE_PATH, RUNTIME_DIR, SOCK_PATH, UI_STATE_PATH, …）。VAULT は既定値を持たず env→vault.json→None（§3.2）
│   ├── model.py scan.py detail.py live.py items.py   走査・抽出
│   ├── store.py                 sessions.json（折畳・アーカイブ・カテゴリ色）。mkdir ロック付き
│   ├── cache.py                 走査キャッシュ（path → mtime,size,結果）
│   ├── jsonout.py               `json` サブコマンドの出力組立
│   ├── cmd_json.py / cmd_attach.py / cmd_daemon.py / cmd_hook.py / cmd_status.py / cmd_edit.py
│   │                            `cli.py` が `agentsessions.cmd_<name>.main(args)` へ振り分ける各サブコマンド
│   ├── protocol.py              ソケットのフレーム（デーモンとクライアント共通）
│   ├── daemon.py                PTY デーモン
│   ├── attach.py                端末からの attach クライアント（raw mode）
│   ├── hooks.py                 `hook`・`status` の受け口、`format_status_line`
│   ├── pricing.py               モデル別の $/MTok 単価表とコスト計算
│   ├── usage.py                 `json usage`（セッション単位のターン集計）
│   ├── stats.py                 `json stats`（5h／7d 窓の全体集計）
│   ├── setup.py                 `setup`（settings.json のフックと statusLine を整える）
│   ├── cli.py                   サブコマンドの振り分け
│   └── tui.py                   TUI（選んで起動するだけ）
├── tests/                       Python unittest
├── docs/
└── install.sh                   symlink を張り、`agent-sessions setup` を呼ぶ
```

`~/.config/dotfiles` は `bin/agent-sessions` → `~/work/agent-sessions/bin/agent-sessions` の symlink を持つ。

## 2. プロセスと責務

| プロセス | 起動 | 責務 |
|---|---|---|
| プラグイン | Obsidian | 一覧・ターミナル描画・タブ管理・復元・通知・`sessions.json` の書込 |
| `agent-sessions daemon` | プラグインだけが起動する（ソケット不応答時に `--detach`）。CLI・TUI は起動しない | PTY の保持、出力バッファ、attach/detach、claude の起動と終了検知 |
| `agent-sessions json …` | プラグインが必要時に spawn | 走査・最終更新・子判定・起動中・直近の指示／応答・トークン集計・全体統計 |
| `agent-sessions`（TUI）| ユーザー | 選んで attach／起動 |
| `agent-sessions hook` / `status` | Claude Code（settings.json） | フック・statusLine の受け口 |
| `agent-sessions setup` | `install.sh`／手動 | `~/.claude/settings.json` のフックと `statusLine` を整える |

## 3. データと置き場

| 場所 | 内容 | 書く者 |
|---|---|---|
| `<vault>/.agents/sessions/sessions.json` | 折畳・アーカイブ・カテゴリの色（下記） | プラグイン、`agent-sessions`（TUI の折畳）。§3.1 のロックの中で読み→更新→tmp→rename |
| `<vault>/.agents/sessions/sessions.json.lock/` | 書込みの排他（§3.1） | 書く者 |
| `~/.agents/sessions/daemon.sock` | デーモンのソケット（vault 配下は macOS のパス長制限 104 バイトに掛かる）。ディレクトリ 0700・ソケット 0600 | デーモン |
| `~/.agents/sessions/daemon.pid` / `daemon.log` | デーモンの pid とログ | デーモン |
| `~/.agents/sessions/exited.json` | 終了済みで未 `forget` のセッション（`id → {code, exitedAt}`）。デーモンが終了時に書き、起動時に読む | デーモン |
| `~/.agents/sessions/status/<session_id>.json` | `statusLine` が渡す JSON をそのまま | `agent-sessions status` |
| `~/.agents/sessions/ui.json` | `{submitKey, submitSymbol}`。statusLine が送信キーの記号を付けるための控え | プラグイン（`onload`・設定保存のたび） |
| `~/.agents/sessions/vault.json` | `{"vault": "<path>"}`。vault は既定値を持たないので、Obsidian の外（TUI・CLI）から見るための控え（T-80。§3.2 参照） | プラグイン（`onload` に 1 回、tmp→rename） |
| `~/.agents/sessions/plugin.sock` | 内蔵エディタの受け口（プラグインが listen） | プラグイン |
| `~/.agents/sessions/events.log` | フック 1 件 1 行 `{"event","session_id","transcript_path","ts"}` | `agent-sessions hook` |
| `~/.agents/sessions/scan-cache.json` | 走査キャッシュ | `agent-sessions json scan` |
| `~/.agents/sessions/stats-cache.json` | `json stats` の 10 分バケット・読取位置・重複排除用の直近 `message.id` | `agent-sessions json stats` |
| `~/.agents/sessions/compacted/<id>.json` | compact 直後でまだ次の指示を送っていない印（中身は `{"compactedAt"}`。プラグインは存在だけを見る） | `agent-sessions hook`（`_update_compacted`） |
| `~/.claude/projects/<p>/<id>.jsonl` | transcript（真実源） | Claude Code（読むだけ） |
| `~/.claude/sessions/<pid>.json` | 起動中の台帳と状態 | Claude Code（読むだけ） |

`sessions.json`：

```json
{
  "version": 1,
  "folded": ["RIM", "その他のセッション"],
  "archived": [{"id": "5778f81f-…", "name": "酔い酒鮨庵", "agent": "claude"}],
  "pendingRenames": {},
  "sessions": {"68d25490-…": {"agent": "claude", "cwd": "/Users/…/obsidian-projects"}},
  "categoryColors": {"RIM": 0, "スキル開発": 3}
}
```

- `sessions` はプラグインが起動したセッションの `agent` と `cwd`。走査で transcript が見つかれば transcript が優先。新規直後（transcript 未生成）の行を一覧に出すために持つ。
- `archived` の `name` はマネージャーの「アーカイブ」区分に出すための控え。真実は transcript。
- `categoryColors` はカテゴリ名（`splitName` が返す `カテゴリ: 名前` の前半）→ パレット番号（0〜11）。一度決めた番号は変えない（§11）。
- `pendingRenames` は Python・TypeScript とも読み込んだ値を同じ形で書き戻すだけで、参照する処理は無い。名前変更は §6 の `sendCommand` が直接送る。

### 3.1 `sessions.json` の排他

書く者はプラグイン（名前変更・アーカイブ・折畳・新規・カテゴリ色の確定）と `agent-sessions` TUI（折畳）で、同時に動きうる。書込みは `sessions.json.lock/` ディレクトリを `mkdir` で取ってから行う（Python `os.mkdir`、Node `fs.mkdirSync`。作れた者がロックを持つ）。`EEXIST` なら 50 ms 待って再試行、2 秒で諦めてエラー（プラグインは `Notice`）。ロックの mtime が 10 秒より古ければ壊れたものとして `rmdir` して取り直す。ロックの中で読み→更新→tmp に書き→rename→`rmdir`。読むだけの者はロックを取らない。

### 3.2 vault の場所（T-80）

`agent-sessions` は既定の vault を持たない。`agentsessions/config.py` の `VAULT`（`_resolve_vault()`。import 時に 1 回だけ決める）は、env `AGENT_SESSIONS_VAULT` → `~/.agents/sessions/vault.json` の `vault` フィールド → どちらも無ければ `None`、の順で決める。`STORE_DIR`・`STORE_PATH`・`LOCK_DIR` は `VAULT` が `None` なら同じく `None`（`import` 時にここで落ちない）。

- **プラグイン**：`agent-sessions json …`（`backend.ts` の `runJson`）・デーモンの `start` に渡す `env`（`main.ts`・`views/terminal.ts`）のどちらにも `env AGENT_SESSIONS_VAULT=<this.vaultPath()>` を必ず付ける（`backend.ts` の `envWithVault`）。デーモン自身は `env` を素通しして `execvpe` するだけなので（`daemon.py` の `_op_start`）、claude 本体やその子（フック・statusLine）にもここから伝わる。`onload` の 1 回だけ `vault.json` を書く（vault は起動中に変わらない）。
- **python**：`config.require_vault()` は `VAULT` を返すか、`VaultNotConfigured`（英語の分かりやすいメッセージ）を投げる。TUI の入口（`tui.main()`）はこれを呼び、curses を起こす前に止まる（終了コード 1）。`store.load()` は `path` が `None`（＝ vault 不明）でも空の `Store` を返す（`json scan` はプラグインから必ず env が来る前提だが、来なくても落ちない）。`store.save()`・`store.update()` は `path` が `None` なら `VaultNotConfigured` を投げる（書く先が無いので黙って諦めない）。
- **install.sh**：vault は第 1 引数か `$AGENT_SESSIONS_VAULT` の必須値（既定値なし）。どちらも無ければ usage を出して終了。

## 4. デーモンとプロトコル

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
- 環境は要求の `env` に `TERM=xterm-256color`・`COLORTERM=truecolor`・`AGENT_SESSIONS_ID=<id>`・`VISUAL=<~/bin/agent-sessions-code の絶対パス>` を足す。プラグインはログインシェル（`$SHELL -l -c 'env'`）から取った `PATH`・`LANG`・`HOME` などを `env` に渡す（Dock から起動した Obsidian の環境は貧弱なため）。`EDITOR` は触らない。
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
| `agent-sessions json scan [--only ID …]` | 走査結果 `{"sessions":[…],"store":{"folded","archived","pendingRenames","sessions"}}`。`--only` は指定 transcript だけ再走査してキャッシュを更新し、その分だけを返す |
| `agent-sessions json live` | 起動中の台帳（`~/.claude/sessions`）とデーモンの `list` を併せて `{"live":{id:{status,pid,rc,updated_at,waiting_for?}},"daemon":{"running":bool,"sessions":[list の要素]}}`（`status` は表示用ラベル「実行中」「コマンド実行中」「待機中」「回答待ち」「起動中」。`waiting_for` は claude の値が `waiting` のときだけ載る）。デーモンが無ければ `running:false`（起動はしない）。プラグインは `daemon.sessions` から行ごとの `daemon`／`exited` を導く |
| `agent-sessions json detail ID` | `{"last_user","last_assistant","tools","last_command"}`（`last_command` は直近のスラッシュコマンド名。引数は含めない） |
| `agent-sessions json usage ID [--from ISO --to ISO]` | セッション単位のターン集計（§13.1） |
| `agent-sessions json stats` | 5 時間・7 日窓の全体集計（§13.2） |
| `agent-sessions attach ID` | 端末を raw mode にしてデーモンの PTY へ接続。`Ctrl+\` で detach |
| `agent-sessions edit FILE` | 内蔵エディタの窓口（§7.4） |
| `agent-sessions hook` | stdin の JSON を `events.log` に 1 行追記し、compacted 印を更新する（§7.5） |
| `agent-sessions status` | stdin の JSON を `status/<session_id>.json` に書き、statusLine の 1 行を出力（Claude Code のステータス行になる。§12） |
| `agent-sessions setup` | `~/.claude/settings.json` を読み、`settings.json.bak-<時刻>` を残してから、`hooks.Stop`（matcher `.*`）・`hooks.SessionEnd`（`.*`）・`hooks.SessionStart`（`compact`。compacted 印の「入る」、§7.5）・`hooks.UserPromptSubmit`（`.*`。compacted 印の「出る」）を `"$HOME/bin/agent-sessions" hook` に揃え（無ければ追加、既にあれば event＋matcher の一致で冪等、他のフックは触らない）、`statusLine` が null か既定と違えば `{"type":"command","command":"$HOME/bin/agent-sessions status"}` を設定。結果を表示する |

TUI：一覧（グループ→カテゴリの無い名前付きセッション（見出し無し）→その他、折畳、`/` 絞込、`h` でアーカイブを見せる）と ⏎。「その他」（既定で折畳）に載るのは名前が無く `child` でないセッションだけ（`items.py` の `build_items`。表示名は最初の指示の先頭 40 字、無ければ id の先頭 8 字）。⏎ はデーモンに `id` があれば `attach`（終了済みなら `forget` して `--resume`）、無ければ `claude --resume ID` を `execvp`。デーモンを起動することはない。折畳の保存は §3.1 のロックの中で書く。管理操作は持たない。サイドパネル：`cols >= 60` なら幅 `clamp(cols×0.4, 30, 60)` で常に出す。`cols < 60` では `p` で「一覧」と「パネルのみ」を切り替える。

`json scan` の出力（1 セッション）：

```json
{"id":"…","agent":"claude","name":"RIM: 議事メモ作成","group":"RIM","label":"議事メモ作成",
 "cwd":"/Users/…","folder":"obsidian-projects","last_activity":1789400538.7,"child":false,
 "transcript":"/Users/…/68d25490-….jsonl"}
```

キャッシュ：`scan-cache.json` に `path → {mtime,size,head,last_activity}`。`mtime`・`size` が一致すれば再読しない。全走査の 2 回目以降は 0.1 秒以下。

`install.sh`：`~/bin/agent-sessions`・`~/bin/agent-sessions-code` の symlink と、`<vault>/.obsidian/plugins/agent-sessions` → `plugin/` の symlink を張る。vault は既定値を持たない（T-80）——`$AGENT_SESSIONS_VAULT` か第 1 引数で渡す必須の値で、どちらも無ければ usage を出して終了する。`plugin/main.js` が無ければ build を促す。最後に `agent-sessions setup`（残りの引数をそのまま渡す）を呼ぶ。

## 6. コマンド送信（名前変更・圧縮）

`/rename NAME`・`/compact` はどちらも `main.ts` の `sendCommand(id, text)` を通して PTY へ送る。行メニュー・ダイアログはこの 1 つの関数を呼ぶだけで、経路の違いは意識しない。

送る列はどの経路も同じ 1 列（`commandBytes`）：Ctrl+S（`\x13`。Claude Code の既定 `chat:stash`。下書きがあれば退避し、空なら何も起きないので無条件に送る）→ コマンドを **bracketed paste**（`\x1b[200~` + text + `\x1b[201~`。文字を打つと `/` の補完が開いて壊れる）→ 送信列（§7.2 の `submitSequence()`）。**復元は送らない**：Claude Code は stash した下書きを次の送信の後に自動で戻す（「Draft restored」）。

1. **タブがあり attach 済み**：そのタブから PTY へ書く。
2. **タブは無いがデーモンにあり動作中**：一時的に attach（120×40）して書き、detach する。
3. **デーモンに無い、または終了済み**（終了済みなら先に `forget`）：**裏で起動**：`start`（`--resume`、120×40）→ attach → `registry.waitFor(id, 'idle', 60 秒)` で `idle` になるのを待つ（遷移イベントではなく状態そのものを待つ。初めて観測する id でも成り立つ）→ 送信 → `waitFor(id, 'busy', 10 秒)`（`busy` にならないコマンドはここで見切る）→ `waitFor(id, 'idle', 60 秒)` → `/exit` を同じ列で送る → `exit` を 30 秒待つ（来なければ `kill`）→ detach → `forget` → `rescan([id])`。進行は `Notice` で知らせる（「名前を変更しています…」）。待ちが切れると例外になり、呼出側が `Notice` に出す。この経路の間は `busy→idle` の通知（§12）を出さない。

新規セッション（名前つき）は `start` の後に同じ `waitFor(id,'idle')` → `sendCommand(id, '/rename NAME')`。名前変更・新規どちらも、送信の直後に `SessionIndex.waitForName(id, expected, timeoutMs=5000, intervalMs=300)` を fire-and-forget で呼ぶ：一致していれば即 `true`、一致しなければ `rescan([id])` を挟みながら 300 ms ごとに見直し、5 秒で諦めて `false`（失敗しても `Notice` は出さない。最悪でも §10 の周期走査で追いつく）。`/rename` はモデルを呼ばないコマンドなので `busy` にならず、フックの `events.log` にも記録が来ない。この `waitForName` が無いと、タブの題名は次の周期走査（60 秒）まで直らない。

直近のスラッシュコマンドが `/compact` かどうかは `json detail` の `last_command` で判定し、行メニュー・ターミナルの ⋯ の「セッションを圧縮」を非活性にする（キャッシュ済みの detail で同期に判定し、未取得なら活性のまま出す。`compactSession` が改めて判定し、`/compact` 済みなら送らずに `Notice` を出す）。

## 7. プラグイン：ターミナル（`agent-sessions-terminal`）

状態（`getState`）：`{id, agent, cwd, fontSize?, fresh?}`（`fresh` は新規で未起動のときだけ真。最初の `start` で消える）。Obsidian の workspace に保存され、再起動で戻る。

### 7.1 接続・入出力・サイズ

- xterm 5.x：`fontFamily`・`fontSize` は設定（タブ毎の `fontSize` があれば優先）、`lineHeight: 1.0`、`letterSpacing: 0`、`scrollback: 5000`、`allowProposedApi: true`、`macOptionIsMeta: true`、`cursorBlink: true`。アドオン：fit・webgl（失敗時は既定の canvas）・unicode11。
- 余白：設定 `padding`（`comfortable`＝12px／`compact`＝4px／`none`＝0）をコンテナの CSS 変数に流す。`.agent-sessions-terminal-body` は `overflow: hidden`、`fit()` は padding を引いた領域で計算する（`FitAddon` は要素の `padding` を見るので、padding は xterm の親ではなく外側の要素に付ける。スクロールバーが余白側に出るのを防ぐ）。
- 接続：初回に ResizeObserver が 0 でない大きさを報告したとき `ensureAttached()`。デーモンに `id` があれば `attach`（終了済みなら再生の後に `exit` が届き終了画面になる）、無ければ `start`（`argv = [claudePath, '--resume', id]`、新規は `['--session-id', id]`）。デーモンに繋がらなければ起動を試み、1 秒待って再接続、3 回失敗で終了画面にエラー。
- 出力：`D` フレームを `terminal.write(Uint8Array)`。再生（`R`）中は `write` をまとめ、`replayed` で `scrollToBottom()`。
- 入力：`onData` の文字列を UTF-8 で `D`。`onBinary` も同様。
- サイズ：ResizeObserver → 50 ms デバウンス → `fit()` → `onResize` → `resize`。
- 終了（`exit` イベント）：出力の上に「セッションは終了しました（code）」と **再開**・**閉じる**。再開は `forget` → `--resume` で `start`。閉じるは `forget` してタブを閉じる。
- タブを閉じる（`onClose`）：`detach` して接続を閉じ、xterm を `dispose`。セッションは残る。`SessionIndex`・`registry`・`statusline`・`settings-changed` の購読は `this.register(unsubscribe)` で登録してあり、Obsidian が `onClose` で解く。
- 設定の反映：`main.ts` が設定保存時に `settings-changed` を発火し、全ターミナルビューが `applySettings()` でフォント・サイズ（タブ毎の値があればそれ）・余白・スクロールバックを xterm に当てて `fit()` する。
- ヘッダの操作（`addAction`）：`@`（現在のノートを挿入）・前の指示・次の指示・最後の応答。セッションへの操作（名前変更・圧縮・アーカイブ・終了・セッション解析結果・ID をコピー）はサイドパネルとマネージャーの行メニューに集約する。ターミナルの ⋯（`onPaneMenu`）は Obsidian 標準の項目（右に分割・下に分割を含む）の後に区切り線を置き、`名前を変更`・`セッションを圧縮`・`セッション解析結果`・`ID をコピー` を並べる（アーカイブ・終了は行メニューだけ）。

### 7.2 送信キーと Enter

設定は **送信キー** 1 つ（`enter`（既定）／`shift+enter`／`ctrl+enter`／`alt+enter`（Option）／`cmd+enter`。`cmd+enter` は macOS だけ選べる——非macOS対応は下記）。送信キー以外の Enter の組合せは改行になる。`views/terminal.ts` の `handleKey`（`attachCustomKeyEventHandler`）が Enter の組合せを IME 変換中を除きすべて横取りする（純関数は `keys.ts`）：

- `classifyEnter(ev)`：Enter でなければ、または IME 変換中（`isComposing`／`keyCode 229`）なら `passthrough`。修飾は shift・ctrl・alt・cmd（metaKey）・無し（enter）の優先順で 1 つに分類する。
- `resolveEnterAction(cls, submitKey)`：一致すれば `submit`、しなければ `newline`（Enter 以外・IME 中だけ `passthrough`）。
- `sendSequence(action, submitKey)` ＝ `submitSequence()`：`submitKey === 'enter'` なら Claude Code の既定どおり送信＝`\r`・改行＝`\x1b\r`。それ以外は `keybindings.json` で逆にしてあるので送信＝`\x1b\r`（meta+enter）・改行＝`\r`。`sendSubmit()` に集約し、指示マーカー（§7.3）の記録もここで行う。コマンド送信（§6）・内蔵エディタの「送る」（§7.4）も同じ関数を使う。

Esc は `keyup` の伝播を止める（Obsidian がフォーカスを奪うため）。`Cmd + / − / 0` はフォントサイズ。それ以外の Cmd 付きキーは伝播を止めず Obsidian に渡す（xterm は Cmd の組合せに何も送らないため、止めると Cmd+W・Cmd+P が効かなくなる）。Ctrl・Option 付きと無修飾のキーは xterm に任せ、`keydown` の伝播を止めて Obsidian のホットキーに渡さない。Option+Enter を含む Enter の組合せはすべて `handleKey` が横取りするので、送信キーの設定どおりに送信か改行になる。

`submitKey !== 'enter'` のときだけ、`keybindings.json`（`$CLAUDE_CONFIG_DIR` 配下。vault の `.claude/` は読まない）の `Chat` に `enter: chat:newline`・`meta+enter: chat:submit` を書く（他の鍵は触らない。`$schema`・`$docs` が無ければ足す）。Claude Code 全体の設定なので、iTerm など他の端末の claude にも効く（設定画面で伝える）。`submitKey === 'enter'` に戻すときは自分が書いた 2 鍵だけを消す。起動時は `reconcileSubmitKey(chatBindings, current)`：ファイルの状態（Enter が改行になっているか）と今の設定（`enter` か否か）が合っていれば設定を保ち（`shift+enter`／`ctrl+enter`／`alt+enter`／`cmd+enter` はファイルの 2 鍵からは区別できない）、食い違うときだけ `deriveSubmitKey(chatBindings)`（`enter: chat:newline` があり `cmd+enter`／`super+enter` もあれば `cmd+enter`、無ければ `alt+enter`。`enter` が無いか `chat:submit` なら `enter`）で導いた値にする。設定画面は開くたびに `keybindings.json` を読み、食い違いがあれば示して合わせられる。ファイルが無ければ送信、JSON が壊れていれば「読めない」と表示し変更を受け付けない。

送信キーの記号（`⏎`／`⇧⏎`／`⌃⏎`／`⌥⏎`／`⌘⏎`、`keys.ts` の `SUBMIT_KEY_SYMBOLS`）は macOS の「送る」ボタンの表記（例「送る（⌘⏎）」）と statusLine（§14）に使う。非macOS対応は下記。

#### 7.2.1 非 macOS のキー割当

`Platform.isMacOS`（Obsidian）で分岐する。macOS は上記のまま変えない。

非 macOS では Obsidian のホットキーの修飾キーが Ctrl（Cmd ではない）で、claude 自身も Ctrl+C／D／G／R／O／S／L／T 等の組合せを使う（R-T5）。そのため「Ctrl は素通りで Obsidian へ渡す」とはできず、`keys.ts` の `classifyCtrlKeyNonMac(ev)` が Ctrl 付きキーの行き先を決める（`views/terminal.ts` の `handleKey` から、`!Platform.isMacOS` のときだけ呼ぶ）。既定は **ターミナルへ**（claude を優先）で、以下だけ例外にする：

| キー | 行き先 |
|---|---|
| Ctrl+Shift+C | ターミナルの選択をコピー（`terminal.getSelection()` → `navigator.clipboard.writeText`）。選択が無ければ何もしない |
| Ctrl+Shift+V | クリップボードを PTY へ（`navigator.clipboard.readText()` → `sendInput`）。`terminal.modes.bracketedPasteMode` が立っていれば bracketed paste（`\x1b[200~`…`\x1b[201~`）で囲む（§6 の bracketed paste と同じ理由。`/` の補完を誤って開かせない） |
| Ctrl+Shift+=／−／0 | フォントサイズ（macOS の Cmd +／−／0 に相当。`TerminalView.zoomFont()`） |
| Ctrl+Shift+<その他の key> | Obsidian へ（claude は Ctrl+Shift の組合せを使わないため） |
| Ctrl+Tab／Ctrl+, ／Ctrl+W | Obsidian へ（タブ切替・設定・タブを閉じる） |
| それ以外の Ctrl+<key>（Ctrl+P を含む） | ターミナルへ |

Obsidian へ渡すときは xterm には渡さず（`false` を返す）が `preventDefault`／`stopPropagation` は呼ばない——macOS の Cmd 付きキーと同じ考え方で、ネイティブの `keydown` をそのまま Obsidian のホットキー処理へ通す。コピー・貼り付け・フォントサイズは自前で処理するので `preventDefault`・`stopPropagation` を呼び、xterm にも Obsidian にも渡さない。

Ctrl+P はコマンドパレットと衝突しうるが（claude の readline 系入力は Ctrl+P を履歴の「1 つ前」に使う可能性がある）、R-T5（claude が使うキーはすべてターミナルに届く）を優先し、既定のターミナル行きのままにした——Obsidian のコマンドパレットは他の手段（リボン・メニュー、または非フォーカス時の Ctrl+P）で開ける。Ctrl+W（タブを閉じる）も readline の「1 語削除」と重なりうるが、タブを閉じる操作の可用性を優先してある。どちらも実機での衝突確認はまだ済んでいない（§21）。

右クリックのコピー・貼り付け（xterm.js 自身の `rightClickHandler`／`copyHandler`／`handlePasteEvent`。`element` の `copy`・`paste`・`contextmenu` DOM イベントを購読）はプラットフォームで分岐しない——ブラウザのネイティブ `copy`／`paste` イベントに乗るだけなので、非 macOS でも同じ経路で動く。

### 7.3 リンクと `@` とジャンプ

- リンク（`links.ts`）：`registerLinkProvider`。行から `[\w./~\-]+(?:\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?` を候補にし、絶対パスは vault 配下なら相対に、相対はセッションの `cwd` から vault 相対に直し、`vault.getAbstractFileByPath` で実在するものだけリンクにする。クリックで `openLinkText`（メイン領域）、行番号があれば `editor.setCursor`。
- `@` 挿入：コマンド「Agent Sessions: 現在のノートを @ で挿入」とヘッダの `@`。`workspace.activeEditor` はターミナルにフォーカスがあると null なので、`main.ts` が `active-leaf-change` で最後に前面だった Markdown leaf（`MarkdownView`）を覚え、`lastMarkdownView()` として公開する。パスはセッションの `cwd` からの相対（`cwd` の外なら絶対）。エディタの選択が複数行なら `#L{from}-{to}`。空白を含むパスは引用符で囲む。PTY へ `@path ` を書き、ターミナルにフォーカスを移す。
- ジャンプ（`marks.ts`）：`handleKey` が無修飾の Enter も含め送信になる Enter を横取りして `sendSubmit()` を呼ぶたびに指示マーカーを記録する（`onData` の `\r` では記録しない。`\x1b\r` を含む改行の誤記録を避けるため）。応答マーカーは `registry` の `idle → busy`（初めて観測する id が `busy` ならその時点で発火する `Registry.refresh()` の扱いを含む）で記録（最後の 1 つを保持）。前の指示＝現在の表示先頭より上で最も近いマーカー、次の指示＝表示先頭より下で最も近いマーカー、最後の応答＝応答マーカー。`scrollToLine(marker.line)`。破棄済みマーカーは捨てる。
- `~/.claude/settings.json` の `"tui": "fullscreen"` のとき、Claude Code は全面再描画でスクロールを自前で持ち、xterm のスクロールバックには溜まらない（`buffer.length === rows`）。この状態ではマーカー方式のジャンプは成り立たないので、3 つのボタンは Claude のスクロールキー（PageUp・PageDown・End）を送る。

### 7.4 内蔵エディタ

Claude Code は Ctrl+G で `$VISUAL` を、`spawnSync(cmd, [...args, tmpfile], {stdio:'inherit'})` で終了を待って呼ぶ（終了コード 0 でファイルを読み戻す。非 0・シグナルなら「quit unexpectedly」と出て元の内容のまま）。実行ファイルの basename に `code`／`cursor`／`windsurf`／`codium`／`subl`／`atom`／`gedit`／`notepad` を含むと GUI エディタ扱いで、代替スクリーンに切り替えない（`prepareTerminalForHandoff`）。`/memory` も同じ経路。

- `bin/agent-sessions-code`（sh、`exec "$(dirname "$0")/agent-sessions" edit "$@"`）。`install.sh` が `~/bin/agent-sessions-code` に symlink。名前に `code` を含めるのは上の判定に乗るため。デーモンが `start` の `env` に `VISUAL=<その絶対パス>` を足す（§4.2。パスに空白があってはならない）。
- `agent-sessions edit FILE`（`agentsessions/cmd_edit.py`）：`~/.agents/sessions/plugin.sock` に接続し `{"op":"edit","file":FILE,"session":$AGENT_SESSIONS_ID,"cwd":…}` を送る。応答 `{"ok":true}` で 0。`{"ok":false,"error":"cancel"}` は 1 で終わる（vi は開かない。Claude は元の内容を使う）。`error` が `no-tab`／`busy`、接続できない、EOF・`ECONNRESET`（Obsidian のクラッシュを含む）なら**端末のエディタに倒す**：`$AGENT_SESSIONS_FALLBACK_EDITOR`、無ければ `vi` を `execvp`（同じ端末で開く）。応答が来るまで待つ（タイムアウト無し。Ctrl+C／`SIGTERM` で `{"op":"cancel"}` を送って 1）。
- `edit-server.ts`：`~/.agents/sessions/plugin.sock` で listen（`onload` で古いソケットを unlink、`onunload` で close と unlink、作成後 `chmod 0600`）。フレームは `daemon-client.ts` の `encodeFrame`／`FrameDecoder` を共用（J のみ）。要求 `edit`：`session` に対応するターミナルビューを探す。無ければ `{"ok":false,"error":"no-tab"}`。あれば `view.openEditor(file, cwd)` を呼び、送る／取消の結果で応答して接続を閉じる。同じタブで編集中に 2 つ目が来たら `{"ok":false,"error":"busy"}`。接続が先に切れたら（claude 側の中断）編集領域を閉じる。**タブ側が先に閉じるとき**（`onClose`・プラグインの `onunload`・`plugin.sock` の close）は、進行中の編集に対して元の内容を一時ファイルへ書き戻し `cancel` を返してから閉じる。編集中の状態はビューの `pendingEdit` 1 つに集約し、閉じる経路すべてがそれを解決する。
- `views/editor-pane.ts`：ターミナルビューの本体を上下に割る（上＝xterm 残り全部、下＝編集領域。高さは設定 `editorHeight`（既定 40%、10〜90% に収める）を上限とし、ターミナルの最小 8 行を優先して縮む。編集領域の下限は 4 行＋バー。開閉で `fit()` を呼び直す）。編集領域は `<textarea>`（ネイティブのペースト・IME・Undo。Markdown の扱いは最小限）。フォント名・サイズは設定を使い、`applySettings(fontFamily, fontSize)` を `terminal.ts` の `applySettings()`（`settings-changed` のたび）から呼ぶので、エディタを開いたまま設定を変えても即反映する。読みやすさのため `.agent-sessions-editor-text` に `letter-spacing: var(--as-editor-letter-spacing, 0.03em)`・`line-height: var(--as-editor-line-height, 1.7)` を既定で当てる（ターミナル本体より字間・行間を広くとる）。開いたら一時ファイルの内容を入れてフォーカス、末尾にカーソル。上部に 1 行のバー：ファイル名（basename）・「送る（送信キーの記号）」・「入力欄に戻る（Esc）」。自動保存は `autosave.ts` の `SaveDebouncer`（`schedule`／`flush`／`cancel`。DOM にも obsidian にも依存しない純クラス）を使い、入力が 800 ms 止まったら tmp→rename で書く（IME 変換中の `input` は `onChanged()` を呼ばず `compositionend` で改めて呼ぶので、変換途中では保存しない）。「送る」「入力欄に戻る」は待っているタイマーを `flush()` してから即書く（`text === lastSaved` なら空振り）。「取消」（元の内容へ戻す経路）はタイマーを `cancel()` するだけで、別途 `original` を書き戻す。自動保存の書込み失敗は `Notice` を出さず `console.warn` のログだけにする（最短 800 ms 間隔で走りうる経路のため）。
  - **送る**：一時ファイルが `claude-prompt-` で始まるプロンプト編集なら、最後の内容を書いて `ok` を返した後（Claude が読み戻す 300 ms を置いて）`submitSequence()` を PTY へ送る。`/keybindings` など他のファイルは送信しない。
  - **入力欄に戻る**（Esc も同じ）：今の内容を書いて `ok` を返す（送信しない。Claude は非 0 でなく `ok` を受けて元の入力欄に戻る）。
  - キー：設定の送信キー＝送る、それ以外の Enter の組合せ＝改行（修飾つきは自前で改行を入れる）、`Esc`＝入力欄に戻る（候補が開いていれば候補を閉じる）。IME 変換中（`isComposing`／`keyCode 229`）は無視。他は textarea の既定。`keydown` の伝播は止める（Obsidian のホットキーに渡さない。Cmd+V／C／X／Z／A はネイティブ動作）。`pendingEdit` がある間、ターミナル側の `attachCustomKeyEventHandler` は全部 `false` を返し、`onData` も捨てる（キーは PTY に送らない）。
  - `@` 補完（`at-complete.ts`）：検索語の更新は `input` イベントのうち `isComposing` でないものと `compositionend` で行う。`@` を打った直後から次の空白までを検索語にし、textarea の直下に候補リスト（最大 8 件）を出す。候補は `app.vault.getFiles()` を `prepareFuzzySearch` で絞り、表示は vault 相対パス。↑↓ で選び、Enter／Tab で確定（`@` から検索語までを、`cwd` から見た相対パス（空白があれば引用符）＋空白に置き換える）。Esc で候補を閉じる（編集は続く）。候補が開いている間の Enter は確定であって送信ではない。
  - `bracketed paste` は関係しない（textarea へのペースト）。

### 7.5 タブの状態とアイコン

ビューのアイコン：セッションマネージャーは `layout-dashboard`、サイドパネルは `list-tree`（リボン・サイドバーのタブ）。ターミナルは状態で変わる（基本形は `square-terminal`）。

純関数 `terminalStatus(input)`（`terminal-status.ts`）が 1 つの `TerminalStatus` を決める：

| 状態 | 条件 | アイコン | 色・動き |
|---|---|---|---|
| connecting | attach／start の途中 | `loader` | 薄い色・回転 |
| working | registry の状態が `busy` | `loader-circle` | アクセント色・回転 |
| running-shell | registry の状態が `shell`（ツールのコマンド実行中） | `terminal` | 黄・点滅（opacity） |
| asking | registry の状態が `waiting`（claude 自身が `~/.claude/sessions/<pid>.json` に書く値。AskUserQuestion・許可プロンプト・elicitation・モデル切替の確認等、ダイアログを開いて答えを待っている） | `message-circle-question` | 赤紫・脈動（scale） |
| waiting | `busy→idle` の後、まだそのタブを前面にしていない（claude 自身の `waiting` とは別物・名前が重なるだけ） | `bell-dot` | オレンジ・脈動（scale） |
| editing | 内蔵エディタが開いている | `pencil-line` | 青 |
| idle | 接続中で待機（見た） | `square-terminal` | 通常色 |
| detached | タブはあるが未接続（復元後、前面にする前） | `square-dashed` | 薄い色 |
| compacted | `/compact` 完了直後（手動・自動とも）から、次の指示を送る／セッションが終わるまで（下記） | `archive-restore` | 青緑（動き無し） |
| exited | claude が終了 | `circle-stop` | 薄い色 |
| error | デーモン不通・claude 不在・起動失敗 | `triangle-alert` | 赤 |

優先順：error＞exited＞asking＞editing＞connecting＞running-shell＞working＞waiting＞compacted＞detached＞idle。アニメーション（connecting・working・running-shell・asking・waiting）は `prefers-reduced-motion` で止める。

タブの状態は `plugin.terminalStatuses`（id → 状態）に集約し、同じ id のビューが複数あれば優先順の高い方。サイドパネル・マネージャーの行の印はタブがあればこの値、無ければ `Row` と registry から分かる範囲（working／running-shell／asking／compacted／exited／idle／detached）。行の印は状態アイコンそのもの（`TERMINAL_STATUS_ICON[status]`、`rowStatusMark`）で、タブ見出しと同じ絵柄・色・動き（`agent-sessions-status-<status>` クラスを共有）になる。tooltip に状態名。asking・waiting の行はさらに背景でも目立たせる（§8・§10.1）。

`asking` はフックを使わずに検出する：claude 自身が `~/.claude/sessions/<pid>.json` に `status: "waiting"` と、理由を表す `waitingFor`（`"input needed"`・`"permission prompt"`・`"dialog open"` 等）を書く。`registry.ts` はこのファイルを watch しており、生の値をそのまま通す（`RegistryEntry.waitingFor`・`Row.waitingFor`、`json live` では `waiting_for`）。`Notification` フック（`notification_type`：`permission_prompt`・`idle_prompt`・`elicitation_dialog`・`agent_needs_input` 等）は一度きりのイベントで、状態を自前で持ち直す必要があり、届かなければ取りこぼすため使わない。`status: "waiting"` は持続的な状態なので、読むだけで足りる。

`compacted` は `~/.claude/sessions/<pid>.json` に情報が無いため、フックで検出する。`SessionStart` は `source`（`startup`／`resume`／`clear`／`compact`／`fork`）を持ち、`compact` は手動の `/compact` と自動の文脈圧縮の両方に共通の値。圧縮そのものの前に鳴る `PreCompact` は一度きりで「完了」の合図には使えないため、`SessionStart`（`source=compact`。圧縮が終わってセッションが実質再開した時点）を「入る」の合図にする。`agentsessions/hooks.py` の `_update_compacted(data)` が `record_hook` から呼ばれ、`SessionStart`＋`source=compact` で `~/.agents/sessions/compacted/<session_id>.json` を tmp→rename で作り、`UserPromptSubmit`（次の指示）・`SessionEnd`（セッション終了）で消す。`setup` は `SessionStart` のフックを matcher `compact` に絞って登録する（無関係な起動のたびに呼ばれないように）。プラグインの `CompactedTracker`（`compacted.ts`。`registry.ts`・`statusline.ts` と同じ `fs.watch`＋200ms デバウンスの形）がこのディレクトリを監視し、中身は見ずファイルの有無だけを `has(id)` として持つ。`SessionIndex.compactedTracker` を `Row.compacted` に合成する。

Obsidian 1.7 以降、前面にしたことのないタブは deferred view で、アイコンと題名は保存された値がそのまま使われる。`refreshDeferredTerminalTabs()`（`main.ts`）が `onLayoutReady`・`layout-change`・`index`／`registry` の変化のたびに、`leaf.view.title`（`DeferredView` が持つフィールド）とタブ見出し DOM（`.workspace-tab-header-inner-icon`・`.workspace-tab-header-inner-title`）の両方を直接書き換える。アイコンは `rowTerminalStatus(row)`（行が無ければ `detached`）の状態アイコンで、`agent-sessions-status-<status>` クラスと状態名の tooltip も付け替える。題名は `Row.name`（無ければ `sessionDisplayName`「無題 <id8>」。`name.ts` の純関数で、`views/terminal.ts` の `getDisplayText()` も同じ関数を使い、両者が同じ規則で名前を決めることを保証する）。

### 7.6 1 セッション＝1 タブと分割

`openSession(id)`（`open-session.ts`）：`workspace.getLeavesOfType('agent-sessions-terminal')` から `view.state.id === id` の leaf を探し、あれば `revealLeaf` して終わり。無ければメインエリアに `workspace.getLeaf('tab')` で leaf を作り `setViewState`。新規セッションも同じ経路（先に `sessions.json` の `sessions[id]` を書く）。多重呼出は `opening: Map<id, Promise<WorkspaceLeaf>>` で抑止し、同じ `id` の呼出が進行中ならその Promise を返す。

「右に分割」「下に分割」（⋯ メニュー、`app.workspace.duplicateLeaf(leaf, 'vertical' | 'horizontal')`）と Obsidian 標準の「タブを複製」「新しいウィンドウへ」は、同じ `id` を持つ複数のビューを作ってよい（`openSession` を経由しない経路。`TerminalView.setState` はこれらを自己閉鎖しない）。複数ビューはそれぞれ独立に attach し（デーモンの最小サイズ規則で PTY のサイズが決まる）、閉じればそのビューだけ detach する。`openSession` からの通常の open は既存タブへ移動するので、重複は作らない。

## 8. プラグイン：サイドパネル（`agent-sessions-side`）

右サイドバー、常設。4 領域を CSS grid（`auto 1fr <detailHeight> auto`）で上から並べる：

1. **ナビ行**：`＋`（新規セッションダイアログ）・`layout-grid`（セッションマネージャーをメインに開く。あればそこへ）・`⋯`（再走査・設定を開く）。セッションに対する操作はここに置かない。
2. **一覧**（`views/side-list.ts`。区分は見出し付き、空の区分は出さない）
   - **開いているタブ**：ターミナルタブがあるセッション。タブの順。前面のタブの行は強調。クリックでそのタブを前面に。見出しの横に「入力待ち N・未読 M」のバッジ（`attentionCounts`。asking を「入力待ち」、waiting を「未読」と呼ぶ。0 件なら出さない）。クリックで最初の対象（asking 優先、無ければ waiting）を開く。件数は「開いているタブ」「起動中」「最近」の全体から数える（`attentionCounts(source, [...openTabs, ...running, ...recent])`）。
   - **起動中**：デーモンが持っていてタブが無いセッション。クリックで attach したタブを開く。
   - **最近**：それ以外を最終更新順に N 件（設定、既定 10）。アーカイブ済みと名前の無い子セッションは出さない。クリックで `--resume` のタブを開く。
   - 行：状態の印（§7.5 と同じアイコン・色・動き）＋カテゴリのチップ（あれば、§11）＋カテゴリを除いた名前＋最終更新（`MM-DD HH:MM`）＋タブがあれば `▣`＋`⋯`（常に表示）。「開いているタブ」「起動中」「最近」のどの区分も同じ表示。asking の行は淡い赤紫の背景＋左端 3px の色帯＋名前を太字、waiting の行はそれより弱いオレンジの背景（帯・太字は無し）で目立たせる。
   - `⋯` のクリックで行メニュー：`名前を変更`・`セッションを圧縮`（直近が `/compact` なら非活性）・`アーカイブ`⇄`アーカイブ解除`・（起動中なら）`セッションを終了`・`セッション解析結果`・`ID をコピー`（`views/rows.ts` の `showRowMenu`）。右クリックでも同じメニュー。クリック・`⋯`・右クリックでその行を選択状態にする（強調のみ）。
3. **詳細欄**（折畳可、`views/detail.ts`。§9）：一覧との間に 4px のドラッグハンドル（`mousedown`→`mousemove` で `sideDetailHeight` を更新、`mouseup` で保存。既定 220px、最小 80px）。
4. **セッション制限**（`views/limits.ts`）：5h・7d のバー・使用率・「リセットまで h:mm:ss」（24 時間以上は「N 日 h:mm」）を 1 秒ごとに更新。`resets_at` が無ければ「—」。元は `~/.agents/sessions/status/*.json` のうち `rate_limits` を持つ最新 mtime のファイル（アカウント共通。前提：アカウントを切り替えて並行使用しない）。リセット直後でまだ新しい `rate_limits` が届いていないときは、`rollForwardWindow`（§10.2 と同じ規則の純関数）が窓を先へ送って「今の窓」を表示する。1 秒ごとの再描画のたびに `Date.now()` で判定し直すので、リセットを過ぎた瞬間から自然に切り替わる。

サイドパネルは `workspace` の `layout-change`・`active-leaf-change` と `registry`・`SessionIndex` の変化を購読して描き直す。

## 9. プラグイン：詳細ビュー（共通部品）

`views/detail.ts` はサイドパネル・セッションマネージャーの両方が使う共通部品。渡された `Row`（何も指していなければ前面のタブのセッション）について描く：

- 名前の上に小さなカテゴリのチップ（あれば、§11 の色）、`<h4>` はカテゴリを除いた名前だけ（`categoryAndLabel(row)`：`row.name` を `splitName` で分ける純関数）。
- バッジ：モデル・エフォート（`statusInfo` から。無ければ「デフォルト」）・rc（○／●、§10.1 の判定と同じ見た目のチップ）。
- コンテキスト使用率のドーナツ（SVG、`ctxPercent`）。`row.compacted`（§7.5）が真なら、その右に小さな「compact 済み」ラベル（`.agent-sessions-detail-compacted`。文脈がリセットされていることを示す）。
- 総トークン・総コスト：`json usage` を呼んで 60 秒キャッシュ（`totalTokens` ＝入力＋出力＋cache 読出＋cache 作成、`formatCost` ＝ `$x.xx`）。
- 直近の指示・直近の応答（カード。`-webkit-line-clamp: 6`、クリックで全文展開）・直近のツール・フォルダ・ID。

行にポインタが 300 ms 乗ったとき（一覧の hover）も `json detail`（キャッシュ）を引いて同じ内容を出す。

## 10. プラグイン：セッションマネージャー（`agent-sessions-manager`）

メインエリアのタブ、「新しいタブ」相当の既定ビュー。開いても claude は起動しない。**新規を選ぶか、行をクリックしない限り新しいセッションは始まらない。** マネージャーは**利用状況の分析**の画面、サイドパネルは**今の作業**の画面という役割分担を持つ。

`buildSkeleton()` は上下 2 段：**上**＝ツールバー＋本体（`.agent-sessions-manager-body`。表＋右の詳細パネル、残りの高さを使う）、**下**＝解析（`.agent-sessions-manager-analysis`。§10.3）。

### 10.1 木・一覧・その他・アーカイブ

木は「グループ（見出し、折畳）→ その他（見出し、折畳）→ アーカイブ（見出し。ツールバーの「アーカイブを表示」が入のときだけ出し、常に展開）」の順。グループの並びは各グループの最も新しい最終更新の順。折畳状態は `sessions.json` の `folded` に保存する（既定は展開）（`tree.ts`／`views/manager-model.ts` の `flattenTree`）。各区分の中は最終更新順。

- グループはカテゴリ名（`splitName` の前半、`カテゴリ: 名前` の `カテゴリ`）ごとにまとまる。見出しはキャレット＋カテゴリのチップ（§11）＋件数＋その区分の 5h／7d のコスト合計（`categoryTotals`。列の位置に揃える）。実カテゴリの見出しはチップだけで、カテゴリ名をもう一度プレーンテキストでは出さない（チップの文字＝カテゴリ名のため）。
- カテゴリの無い名前付きセッションと、名前も無く `json scan` の `child` が偽のセッションは、1 つの「その他」区分（`OTHER_GROUP`＝`"その他のセッション"`。表示は `t("group.other")`）にまとめ、最終更新順で混在させる。無名の子セッションはここにも出さない。直前の区分の最後の行と続いて見えないよう、すべての区分の見出し行の上に 4px（`--size-4-1`）の余白を置く。折畳の識別子は `OTHER_GROUP`（`folded` に `__no_category__` があっても畳んだ扱いにする）。
- グループ・その他の区分の中の行にはチップを付けない（見出しが既に示しているため）。その他・アーカイブの見出しは色を持たないため、チップではなく文字（「その他」「アーカイブ」）で示す。
- 5h／7d の列見出しをクリックしてグループを外した平らな一覧に並べ替えたときだけ、見出しが無くなるため行ごとにチップを出す（唯一の色手がかりになるため）。

グループ・その他の見出しには、その区分の中（折畳んでいても）に asking／waiting のセッションがあれば、優先度の高い方（asking＞waiting）の印を付ける（`urgencyByGroupKey`（`attention.ts`）→ `renderGroupUrgencyMark`。アーカイブは数えない）。

行は状態の印（§7.5。タブと同じアイコン・色・動き）・名前列（チップ＋名前、上記の規則）・最終更新・モデル・エフォート・5h のコスト・7d のコスト・フォルダ・⋯。モデル・エフォートは短い表記で出し、完全な値は tooltip、不明は空欄にする。行の高さは 32px 以上。列は `table-layout: fixed` の固定幅（印 24px・最終更新 120px・モデル 90px・エフォート 64px・5h／7d 各 72px・フォルダ 120px・⋯ 28px、名前が残り）で重ならない。幅が足りないときはコンテナクエリでフォルダ（600px 未満）→エフォート（550px 未満）→モデル（500px 未満）→5h（460px 未満）の順に列を隠す。列見出しのクリックで並べ替え（最終更新＝既定のグループの木、5h／7d のコスト＝グループを外した一覧のコスト降順）。asking／waiting の行は §8 と同じ背景・帯で目立たせる。

ツールバー：`＋`・`再走査`（`rotate-cw`）・絞込（名前の部分一致）・`⋯`（「アーカイブを表示」チェック）。行クリック → `openSession(id)`（タブがあればジャンプ）。↑↓ で行の移動、Enter で開く、`/` で絞込にフォーカス。行の `⋯` と右クリックはサイドパネルと同じ行メニュー（`showRowMenu`、§8）。右の詳細パネルは `views/detail.ts`（§9）そのもの。

再走査のタイミング：ビューを開いたとき、再走査ボタン、`events.log` の追記（該当 ID だけ `--only`）、`~/.claude/sessions/` の変化（状態の更新のみ、走査はしない）、ビューが見えている間 60 秒毎。サイドパネルも同じ走査結果を共有する（`main.ts` が 1 つの `SessionIndex` を持ち、両ビューが購読）。

### 10.2 解析：統計カード・カテゴリ別の帯

解析領域は上に統計の帯、下にカテゴリ別の横バー。

**統計カード**：5 時間枠・7 日枠の 2 枚。見出しの横に「リセットまで …」（カウントダウン）。上段は使用率のバー。下段は 2×2 のラベル付きの小さな表——「コスト $22.90」「トークン 31.5M」「呼出 142 回」「セッション 2」（ラベルは薄い文字、値は太字）。各値に tooltip（例：トークン＝入力＋出力＋cache 読出＋cache 作成、この枠の中）。数値は `agent-sessions json stats`（§13.2）から。窓がリセット時刻を過ぎているのに新しい `rate_limits` がまだ届いていないときは、Python 側の `_roll_forward`（§13.2）が窓を先送りした「今の窓」を返すので、カードは常に今の窓を表示する（先送りした窓は使用率が不明「—」になる）。

**7 日枠のペース判定**：7 日枠のカードの使用率バーの下に 1 行（`renderPaceLine`）。純関数 `weeklyPace(usedPct, start, end, now, windowCost)`（`views/manager-model.ts`）が経過率 `e`（今が窓の何割目か）から予測使用率＝使用率 `/ e` を出す。予測 ≤100 のときは「順調 — このペースで枠の終わりに約 N%」（緑）。>100 のときは、このままのペースで使い切る時刻（`start + 経過 × 100 / 使用率`。`formatWeekdayTime` で「<曜日> HH:MM」）とリセットまでの余り（「このペースでは 火 14:00 に使い切ります（リセットの D 日 H 時間前）」）、2 行目に残り期間を保たせるための目安（「残り 1 日あたり Z% 以下（約 $W／日）」。コストが出せなければ % だけ）をオレンジで出す。使用率が不明（`used_percentage` が無い）なら「使用率が分かりません」、経過が 6 時間未満なら「判定には経過が足りません」を薄い色で出す（母数が小さすぎるため）。tooltip に経過％・使用％。5 時間枠には出さない（1 日あたりの目安に意味がないため）。

**カテゴリ別（7 日枠）の帯**：コストの上位 8 カテゴリの横バー（カテゴリの無いセッションは名前の有無を問わず「その他」1 本にまとめる。`categoryKeyOf`。値は $ と割合）。実カテゴリはバーの塗りにそのカテゴリのチップと同じ色相、「その他」は灰色（`.is-neutral`）。コスト 0 のカテゴリは出さない。全部 0 なら「この枠の使用はありません」。クリックでそのグループへスクロールして開く。純関数 `categoryTotals(rows, stats, window)` は `views/manager-model.ts` に置く。

### 10.3 上下配置・折畳・リサイズ

解析領域は見出し（キャレット＋「解析」）をクリックで折畳める。一覧本体と解析の間には §8 の詳細欄と同じ作りのドラッグハンドルがあり、高さを変えられる（下限 120px）。折畳状態（`managerAnalysisCollapsed`）と高さ（`managerAnalysisHeight`、既定 240px）は設定に保存し、骨組みを作り直しても（言語切替など）保たれる。折畳んだときはハンドルも隠す。

## 11. 名前とカテゴリ

**カテゴリ**＝名前の `: ` より前（`tree.ts` の `splitName`。TUI・マネージャーのグループと同じ判定）。カテゴリの無い名前はそのまま。

**入力**：新規セッション・名前を変更のダイアログはどちらも 1 つの入力欄（`modals.ts` の `buildComposedNameField`）で、カテゴリと名前をまとめて打てる。半角 `:` は打った時点で区切りと認め、続く空白は要らない。全角 `：` は直後に空白が来て初めて区切りと認める（IME の変換途中で `：` だけが先に入ることがあるため）。区切りを認識した瞬間、区切りより前の文字列（カテゴリ名・区切り文字とも）は入力欄から取り除かれ、代わりにチップとして確定表示になる（貼り付けで一括入力された場合も、同じ `input` イベント経由で同様に効く）。区切りがまだ無い間は、既存カテゴリの部分一致候補（`filterCategories`）をドロップダウンで出し、↑↓ で移動、Enter／Tab で確定（チップになる）、Escape で候補を閉じる。名前が空でカーソルが先頭のとき Backspace、またはチップのクリックで、チップを解いてテキストに戻せる（`tokenizeNameInput`・`filterCategories` は `name.ts` の純関数）。ダイアログの確定はボタンだけで、この入力欄での Enter は候補の確定であって、ダイアログの確定にはならない。

結果の名前は「カテゴリ: 名前」（カテゴリが空なら「名前」）。名前変更ダイアログはいまの名前を `splitName` で 2 つに分けて入力欄に反映する（チップ＋残りの名前）。

**色**：カテゴリごとに固定のパレット番号（0〜11、`category.ts` の `paletteHueDeg(index)` が色相角度 0〜330 を 30 度刻みで返す）を割り当て、`sessions.json` の `categoryColors`（§3）に書いて覚える。`assignCategoryColor(colors, category)`：既にあればその番号を不変で返す。無ければ「まだ使われていない番号のうち最小」、12 個すべて使われていれば「使用回数が最も少ない番号（同数なら小さいほう）」を選ぶ。`SessionIndex.categoryColorIndex(category)` は確定済みならその番号を返し、未確定なら（走査で確定するまでの見込みとして）その場で計算した番号を書き戻さずに返す（命名ダイアログのプレビュー色に使う）。走査のたびに `SessionIndex` が今のセッション一覧に出てくるカテゴリのうち未確定のものを `ensureCategoryColors` でまとめて確定し、ロック付きで `sessions.json` に書き戻す（ロックが取れなくても例外を握りつぶし、次の走査で再試行する）。

チップの描画は `chip.ts` の `renderCategoryChip(container, category, colorIndex)` に一本化し、命名ダイアログ・サイドパネルの行・マネージャーの見出し／行／カテゴリ別バー・詳細ビューがすべてこれを使う（暗いテーマは `hsl(h 40% 50% / 0.18)` の背景と `hsl(h 45% 60%)` の文字、明るいテーマ（`.theme-light`）は `hsl(h 50% 50% / 0.16)` の背景と `hsl(h 45% 32%)` の文字。カテゴリ別の帯の塗りも同じ色相で、暗 `45% 60%`・明 `45% 32%`）。チップは `max-width` や省略記号を持たず全文表示し、名前側（`flex: 1 1 auto`）だけが幅に応じて縮む。

## 12. 状態・通知・deferred タブ

- `registry.ts`：`fs.watch(~/.claude/sessions)` を 200 ms でまとめ、全 `*.json` を読み `sessionId → {status, pid, rc, updatedAt, waitingFor?}`（`rc` は `bridgeSessionId` の有無、`waitingFor` は `status` が `waiting` のときだけ）。pid が生きているか `process.kill(pid, 0)` で確かめ、死んでいる台帳は無視。
- 状態の遷移 `busy|shell → idle` で、そのセッションのタブが前面でない（または Obsidian が非アクティブ）なら 8 秒の `Notice`「<名前>：指示待ち」（クリックで `openSession`）。設定で切れる。§6 の裏で起動した経路の間は出さない。
- 3 つのビューは `registry`・`SessionIndex` の変化イベントを購読して印を更新する（§7.5）。
- 終了済みの後始末：`onLayoutReady` と `layout-change` で、デーモンの `list` の `exited` のうちターミナルタブが無い `id` に `forget` を送る。タブがある `id` は、そのタブが「再開」「閉じる」で `forget` するまで残す。
- deferred タブの名前とアイコン：`refreshDeferredTerminalTabs()` が §7.5 の通り書き換える。

## 13. 集計

### 13.1 `agent-sessions json usage ID [--from ISO] [--to ISO]`

`assistant` 行の `message.usage`（`input_tokens`・`cache_creation_input_tokens`・`cache_read_input_tokens`・`output_tokens`、`output_tokens_details.thinking_tokens`）は同じ `message.id` が複数行に現れ、内容は同一。`message.model` が `<synthetic>` の行は API 呼出ではない。`isSidechain`（サブエージェント）・`isMeta` の行は数えない。

`agentsessions/usage.py`：transcript を先頭から読み、人の指示（`detail.is_human_prompt`）でターンを切る。以後の `assistant` 行の usage を `message.id` で重複排除してターンに足す。最初の指示より前の usage は「（開始前）」のターン（index −1）。各ターンに `cost`（$、`pricing.py`）・`tools: {name: count}`（`content` の `tool_use` ブロックを名前で数える。`message.id` で重複排除）・`models` を持ち、`total` に `cost`・`tools`・`duration`（最初の指示から最後の assistant 行までの経過秒）・`first_ts`・`last_ts`・`context_last`（最後の呼出の `input + cache_read + cache_create`）を持つ。`estimated: true` を持つターンがあれば `total.estimated = true`。`--from`／`--to` はターン開始時刻に当てる（両端含む）。`turns` は常に全部返し、`total` だけが区間の合計。

行メニュー「セッション解析結果」→ モーダル（`src/usage-modal.ts`、`width: 90vw; max-width: 1100px`）。固定ヘッダ（題名・コピー・閉じる）。要約カード 4 枚（コスト・トークン（入力合計、下に出力）・ターン数・期間）。入力バー（cache 読出／cache 作成／非キャッシュの割合、凡例に数）・出力バー・ツール使用（横バー、上位 12）。ターン表（#・時刻・指示（省略表示、ホバーで全文）・入力・出力・コスト）。区間は行クリックで開始、次のクリックで終了（範囲を強調）、もう一度で解除。カードとバーは区間の値、副題に「#a〜#b」。数は k／M 表記（`usage.ts` の `formatK`）。合計の計算と Markdown 化（コピー用）は `usage.ts` の純関数（`sumRange`・`toMarkdown`）。

### 13.2 `agent-sessions json stats`

出力：`{"windows":{"five_hour":W,"seven_day":W}}`、`W = {"start","end","used_percentage","total":{calls,input,output,cache_read,cache_create,cost},"sessions":{id:{calls,input,output,cache_read,cache_create,cost}}}`。`end` は `resets_at`（無ければ現在）、`start` は `end − 5h／7d`。`used_percentage` は rate_limits から（無ければ null）。

`end`（`resets_at`）が現在時刻より過去（リセット直後で、まだ新しい `rate_limits` が届いていない）なら、`_roll_forward(end, used_percentage, duration, now)` が窓の長さ（5h／7d）ずつ `math.ceil((now - end) / duration)` 回分だけ先送りして「今の窓」の `end` にする（2 期分以上ずれていても対応）。先送りしたときは `used_percentage` を `null`（不明）にする——新しい `rate_limits` が届くまで実際の値は分からないため。`start` は新しい `end` から計算されるので、コスト集計も新しい窓の開始からだけになる（直前の窓のコストは含まない）。プラグインのサイドパネル（`views/limits.ts`、§8）は `json stats` を経由せず `status/*.json` を直接読む独立実装なので、同じ規則の純関数 `rollForwardWindow(w, durationSeconds, now)` を別に持つ。

集計：`~/.claude/projects/*/*.jsonl`（サイドチェーンの行も含める。サブエージェントの transcript が `<project>/<id>/` 配下にあれば親の id に加える）のうち mtime が 7d 窓の開始より新しいもの。`assistant` 行の `message.usage` を `message.id` で重複排除、`<synthetic>` 除外、`pricing.cost` でコスト。

キャッシュ：ファイル毎に 10 分単位のバケット（`{bucket_start: {calls,…,cost}}`）と読んだ位置（`offset`）・直近の `message.id` 200 件を `~/.agents/sessions/stats-cache.json` に持つ。サイズが増えていれば `offset` から続きだけ読む（transcript は追記のみ。縮んでいたら読み直す）。窓の合計はバケットから（10 分の粒度）。壊れたキャッシュ（ファイル全体・エントリ単位のどちらも）は捨てて読み直す。2 回目以降は 1 秒未満。

### 13.3 `pricing.py`

`price_of(model) -> {input, output, cache_5m, cache_1h, cache_read, estimated}`（$/MTok）。`cost(usage_dict, model) -> float`。モデル ID の前方一致で引く（長い方を優先）：

- `claude-fable-5-1`・`claude-mythos-5-1`：入力 10・出力 50・cache 読出 0.25（例外）
- `claude-fable-5`・`claude-mythos-5`：入力 10・出力 50・cache 読出 1.0
- `claude-opus-5`・`claude-opus-4-8`・`claude-opus-4-7`・`claude-opus-4-6`・`claude-opus-4-5`：入力 5・出力 25・cache 読出 0.5
- `claude-opus-4-1`・`claude-opus-4`：入力 15・出力 75・cache 読出 1.5
- `claude-sonnet-5`：入力 2・出力 10・cache 読出 0.2
- `claude-sonnet-4-6`・`claude-sonnet-4-5`・`claude-sonnet-4`・`claude-3-7-sonnet`：入力 3・出力 15・cache 読出 0.3
- `claude-haiku-4-5`：入力 1・出力 5・cache 読出 0.1
- `claude-3-5-haiku`：入力 0.8・出力 4・cache 読出 0.08
- `claude-3-haiku`：入力 0.25・出力 1.25・cache 読出 0.03

cache 作成は 5 分＝入力×1.25、1 時間＝入力×2（`cache_creation.ephemeral_1h_input_tokens` があれば 1 時間の単価、残りは 5 分）。未知のモデルは Opus の単価で見積もり `estimated: true` を立てる。

## 14. statusLine

`agent-sessions status`（`hooks.format_status_line`）が Claude Code のステータス行に 1 行を出す：

```
[<送信キー記号> · ]<モデル> · <エフォート> · ctx NN% · rc ●/○
```

- モデルは `model.display_name`、無ければ「デフォルト」。エフォートは `effort.level`（辞書のとき）または `effort` 自身（文字列のとき）、無ければ「デフォルト」。
- `ctx` は `context_window.used_percentage`（`round`）、無ければ「—」。
- `rc` は `~/.claude/sessions/*.json` のうち `session_id` の一致する行の `bridgeSessionId` の有無（`live.live_sessions`）。一致が無ければ `○`。台帳が無い・未接続はどちらも `○`、接続中だけ緑の `●`（サイド・マネージャーの詳細ビューの rc バッジと同じ判定）。
- 送信キーの記号（macOS は `⏎`／`⇧⏎`／`⌃⏎`／`⌥⏎`／`⌘⏎`、非 macOS は短い文字表記 `⏎`／`S-⏎`／`C-⏎`／`A-⏎`。`keys.ts` の `submitKeyStatuslineSymbol(key, isMac)`）は、環境変数 `AGENT_SESSIONS_ID` が立っているとき（プラグインのデーモンから起動したセッション）だけ、`~/.agents/sessions/ui.json`（`plugin/src/ui-state.ts` の `writeUiState(runtimeDir, submitKey, isMac)`。プラグインが `onload` と設定保存のたびに `Platform.isMacOS` を渡して tmp→rename で書く）から読み、**行の先頭**に `· ` 区切りで付ける。`AGENT_SESSIONS_ID` が無い・`ui.json` が無い／壊れている／`submitSymbol` が無いときは何も付けない。

`agent-sessions status` は同時に、stdin の JSON をそのまま `status/<session_id>.json` に tmp→rename で書く（§3）。

## 15. 設定

| 項目 | 既定 |
|---|---|
| フォント | macOS：`Menlo, "Hiragino Sans", monospace`。非 macOS：`"DejaVu Sans Mono", "Noto Sans Mono CJK JP", monospace`（`settings.ts` の `defaultFontFamily(isMac)`。新規インストールだけ分岐——一度でも保存された値は変えない） |
| フォントサイズ | 13 |
| 余白 | ゆったり（`comfortable`／`compact`／`none`） |
| 送信キー | `enter`（§7.2。実体は `keybindings.json`。選択肢は macOS が 5 つ、非 macOS は `cmd+enter` を除く 4 つ） |
| 最近の件数（サイドパネル） | 10 |
| サイドパネルの詳細欄の高さ | 220px（`sideDetailHeight`、最小 80px） |
| マネージャーの解析領域の高さ／折畳 | 240px／展開（`managerAnalysisHeight`／`managerAnalysisCollapsed`） |
| 指示待ちの通知 | オン |
| `claude` のパス | 空＝ログインシェル（`$SHELL`、無ければ macOS は `/bin/zsh`・非 macOS は `/bin/bash`。`backend.ts` の `defaultLoginShell(isMac)`）で `command -v claude` |
| `agent-sessions` のパス | 空＝`~/bin/agent-sessions` |
| Python のパス | 空＝`/usr/bin/python3`（Linux にもある） |
| スクロールバック行数 | 5000 |
| 内蔵エディタの高さ | `editorHeight`、既定 40%（10〜90%。§7.4） |
| 言語 | 自動（§16） |

## 16. テーマ

`theme.ts` が Obsidian の CSS 変数（`--background-primary`・`--text-normal`・`--text-accent`・`--text-selection`）から `background`・`foreground`・`cursor`・`selectionBackground` を作る。ANSI 16 色は明暗それぞれの固定表。`css-change` で再適用。

## 17. i18n

`manifest.json` の `description` は英語（`Open and manage Claude Code sessions as terminal tabs in Obsidian.`）。UI 本体は日本語と英語の 2 言語。設定「言語」：自動（既定。`window.localStorage.getItem("language")` が `"ja"` なら日本語、それ以外は英語）／日本語／English。

`src/i18n.ts`：`t(key, vars?)`。辞書は `ja`・`en`。ビュー・メニュー・ダイアログ・設定・通知・モーダル・ツールチップなど UI の文字列はすべて `t()` を通す。言語を変えたら `settings-changed` を発火し、全ビューが骨組みから描き直す。Python 側（TUI・CLI）の文字列は対象外（日本語のまま）。

## 18. エラー処理

| 事象 | 振る舞い |
|---|---|
| デーモンに繋がらない | 起動を試みる。3 回失敗で終了画面に理由（Python が無い・ソケットが作れない） |
| `claude` が見つからない | 終了画面に「claude が見つからない」と設定へのリンク |
| `--resume` が失敗（transcript 消失） | claude の出力をそのまま見せ、終了画面に「新規として開始」を足す |
| `json scan` が失敗 | 一覧に前回の結果を残し、`Notice` に stderr の先頭行 |
| `sessions.json` が壊れている | `.broken-<時刻>` に退避して初期化 |
| `keybindings.json` が読めない | 設定画面に「読めない」と出し、送信キーが `enter` 以外の変更は不可 |
| `sessions.json.lock` が 2 秒取れない | 書込みを諦めて `Notice`。10 秒より古いロックは壊れたものとして消す |
| デーモンの二重起動 | 後発が `flock` に失敗して即終了。プラグインは 1 秒待って再接続 |
| `exited.json` が壊れている | `.broken-<時刻>` に退避して空で始める（デーモンは起動する） |
| `stats-cache.json` が壊れている | 該当ファイル（またはエントリ）を捨てて読み直す |
| WebGL が使えない | canvas に落ちる（ログのみ） |

## 19. テスト

- **Python**（unittest、`-W error`。`tests/`）：`protocol`（フレームの分割・結合）、`daemon`（`cat` を子にした start/attach/replay/resize/kill/forget、バッファ上限、複数接続と最小サイズ、切断の後始末、終了済みへの attach、`exited.json` の書き出しと読み込み）、`store` のロック（2 プロセスで同時に書く。`categoryColors` の往復・`path=None`（vault 未設定）で `load` は空、`save`／`update` は `VaultNotConfigured` を含む）、`setup`（settings.json の置換と backup。`SessionStart`（matcher `compact`）・`UserPromptSubmit` の追加を含む）、`cache`、`jsonout`（`waiting_for` を条件付きで持つこと）、`live`（`waiting`／`waiting_for`／ラベル）、`pricing`（各表・1h・未知モデル）、`usage`（cost・tools・duration）、`stats`（窓・バケット・重複排除・`_roll_forward` の 1 期分／複数期分の先送りと境界）、`hooks`（`format_status_line`・送信キー記号・`_update_compacted` の書込と削除）、`config`（`_resolve_vault` の優先順・`require_vault`。T-80）、`model`・`scan`・`detail`（`last_command` を含む）・`items`（TUI の区分け）・`tui_state`（vault 未設定時の `main()` の早期終了を含む）、`edit`（偽ソケットサーバーで `ok:true`→0、`cancel`→1、`no-tab`／`busy`→fallback、接続不可／EOF→fallback）、`attach`。
- **TypeScript**（vitest、`plugin/test/`）：`tree`・`manager-model`（開いているタブ／起動中／最近・グループ／その他／アーカイブの区分け、`categoryTotals`、`weeklyPace`・`formatWeekdayTime`・`shortModelName`）、`links`・`at-complete`、`marks`、`keys`（`classifyEnter`・`resolveEnterAction`・`sendSequence`・`deriveSubmitKey`・`reconcileSubmitKey`）、`keybindings`（読解・書換・戻し）、`daemon-client`（フレーム）、`daemon-integration`、`statusline`・`limits`（整形・並べ替え・`rollForwardWindow`）、`store`（読み書きとロック、tmp dir）、`category`（パレット番号の割当）、`name`（`tokenizeNameInput`・`filterCategories`・`sessionDisplayName`）、`detail`（`categoryAndLabel`）、`terminal-status`（`terminalStatus` の優先順・`asking`・`compacted`・アイコン対応表）、`attention`（`attentionCounts`・`urgencyByGroupKey`）、`compacted`（`CompactedTracker`）、`autosave`（`SaveDebouncer`）、`ui-state`、`vault-state`（`writeVaultState`。T-80）、`backend`（`envWithVault`。T-80）、`registry`（`waitingFor` の素通し）、`index`（`waitForName`・`row.compacted` の合成を含む）、`edit-server`（フレームの往復とハンドラの分岐）、`i18n`、`settings`、`usage`、`tui-mode`、`side-list`、`key-role`、`dedupe`。`openSession` の多重呼出はモックの workspace で確認する。
- **手動**：`requirements.md` の「受け入れの確認」。実機での目視は崩れを指摘されたときと、Obsidian CLI で組立てにくい操作（右クリックメニューなど）に限る。

## 20. 検証の手段と Obsidian の注意点

実機の確認は Obsidian CLI（`obsidian plugin:reload id=agent-sessions` の後、起動中の Obsidian に対してコマンド・DOM の問い合わせを行う）で行う。確認の前後で `document.querySelectorAll(".modal-container").length === 0` を見て、モーダルを開けっぱなしにしていないか確かめる。副作用で作ったタブ・セッションは確認後に畳む／`forget` する。

気をつける点：

- **`Modal.open()`** は閉じるときに戻す選択範囲を `this.selection` に書く。Modal のサブクラスで同名のフィールドを使わない。
- **deferred view**：前面にしたことのないタブは `DeferredView` で、アイコン・題名は保存された値がそのまま使われる（§7.5・§12）。DOM を直接書き換えないと反映されない。
- **`hidden` な要素は `ResizeObserver` が発火しない**：背面のタブ・折畳んだ領域は大きさ 0 として報告されるか、そもそも観測されない。ターミナルの `ensureAttached()` は「0 でない大きさを初めて報告したとき」に接続するため、前面にするまで接続されないのは設計どおり（§7.1）。
- **`tui: fullscreen`** の Claude Code は画面を自前で描き直し、xterm のスクロールバックに溜まらない（`buffer.length === rows`）。マーカー方式のジャンプが効かないことを前提に、スクロールキー送出で代替する（§7.3）。
- Obsidian CLI の合成イベントでは `showAtMouseEvent`（右クリックメニュー）が反応しないことがあるため、その経路は手動確認に回す。

## 21. 今後の見込み

- **Codex（他のエージェント CLI）**：データ・CLI/JSON・画面のいずれも `agent` の軸を持つが、今動くのは Claude Code だけ。対応するときは `agent` フィールド・`argv` の組み立て・走査元（`~/.codex/sessions`）を `agentsessions/agents/<name>.py` に分ける想定。
- **IDE ブリッジ**（差分の accept/reject、選択範囲の随時通知）：要否未定、対象外。
- **非 macOS の実機確認**（§7.2.1）：Linux（WSLg を含む）の Obsidian でまだ通しの動作確認をしていない。特に Ctrl+P（コマンドパレットと claude の履歴操作が衝突しうる）・Ctrl+W（タブを閉じると claude の readline の「1 語削除」が衝突しうる）・Ctrl+Shift+C／V（選択コピー・貼り付け）・フォントサイズ・既定フォントの CJK 幅は、実機での見え方と衝突の有無を確かめてから、必要なら §7.2.1 の割当表を見直す。
