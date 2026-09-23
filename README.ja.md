**[English](README.md) | 日本語**

# Agent Sessions

[Obsidian](https://obsidian.md) の中で [Claude Code](https://claude.com/claude-code) のセッションをターミナルタブとして開き、管理するプラグイン。セッション一覧・利用状況ダッシュボード・タブを閉じても Obsidian を閉じてもセッションを生かし続けるデーモンを持つ。

## 主な特徴

- **ターミナルタブ** — 1 セッション＝1 タブ、実体は PTY（xterm.js）。タブを閉じても Obsidian を終了してもセッションは動き続け、開き直すと直前の画面が再生される。
- **サイドパネル** — 右サイドバーに「開いているタブ」「起動中」「最近」の一覧、詳細欄、5 時間／7 日のレート制限（リセットまでのカウントダウン付き）。
- **セッションマネージャー** — カテゴリでまとまったセッションの木、並べ替えられる表（最終更新・モデル・エフォート・5h／7d のコスト・フォルダ）、利用状況の分析パネル：5 時間／7 日枠の統計カード、7 日枠のペース判定（「順調」か「このままでは使い切る」）、カテゴリ別のコスト内訳。
- **状態が分かるタブと行** — 処理中・シェルコマンド実行中・回答待ち・未読の応答・編集中・compact 済み・未接続・終了・エラーなど、セッションの状態ごとにアイコン・色・動きを出す。ターミナルタブ・サイドパネル・マネージャーで表示を揃える。
- **命名とカテゴリ** — 「カテゴリ: 名前」の形で名付けると、カテゴリごとに固定の色が付き、マネージャーで専用のグループになる。
- **内蔵エディタ** — セッション中に Ctrl+G を押すと、ターミナルの下に分割された編集領域が開き、今のプロンプト（または `/memory`・`/keybindings` 等）を編集できる。`@` によるファイル補完・自動保存・ネイティブのペースト／IME／Undo に対応。編集中もターミナルの出力は見えたまま。
- **移動の補助** — 出力中に現れるファイルパスは vault 内に実在すればクリックできるリンクになり、「現在のノートを `@path` として挿入」、前の指示・次の指示・最後の応答へのジャンプボタンを持つ。
- **セッション解析と利用状況** — セッション単位のトークン・コストをターン表付きで、アカウント全体の 5 時間／7 日の利用量を、どちらも Claude Code 自身の transcript から算出する。
- **CLI と TUI** — Obsidian の外や自動化から使える単体の `agent-sessions` コマンド：セッションを選んで attach する TUI と、プラグインを裏で支える `json` サブコマンド。
- **日英 2 言語の UI** — 「自動」（Obsidian の言語設定に合わせる）・日本語・English を選べる。

## 必要なもの

- macOS。Windows は対象外、Linux は未検証。
- Obsidian desktop、1.7.2 以降（`isDesktopOnly`。プロセスの起動と Unix ソケットを使うため）。
- 標準ライブラリのみを使う Python 3.9 以降。通常は `/usr/bin/python3`（パスはプラグインの設定で変更できる）。
- [Claude Code](https://claude.com/claude-code) CLI（インストール済みで `PATH` にあるか、プラグインの設定でパスを指定する）。
- ソースからプラグインをビルドする場合のみ、Node.js と npm（[開発](#開発)を参照）。

## インストール

パッケージ化された配布物はまだ無いため、ローカルの clone から入れる。

```sh
git clone <このリポジトリ> agent-sessions
cd agent-sessions
(cd plugin && npm install && npm run build)
./install.sh
```

`install.sh` が行うこと：

- `bin/agent-sessions`・`bin/agent-sessions-code` を `~/bin` に symlink する。
- `plugin/` を `<vault>/.obsidian/plugins/agent-sessions` に symlink する（vault は既定で固定のパスを使う。スクリプトを実行する前に `AGENT_SESSIONS_VAULT` を設定すれば変えられる）。
- `agent-sessions setup` を実行する。これは **`~/.claude/settings.json` を書き換える**（先に `settings.json.bak-<時刻>` としてバックアップを残す）：`Stop`・`SessionEnd`・`SessionStart`（matcher `compact`）・`UserPromptSubmit` の各フックを `agent-sessions hook` に向けて追加・更新し、`statusLine` を `agent-sessions status` に設定する。自分が付けたと分かるエントリだけを触り、他のフックはそのまま残す。

その後、Obsidian の「コミュニティプラグイン」で **Agent Sessions** を有効にする。

**送信キー**の設定を既定（Enter）以外に変えると、Claude Code 自身のキー割当と揃えるため、プラグインは `~/.claude/keybindings.json`（`Chat` コンテキスト）にも書き込む——これは Obsidian の外で起動した Claude Code を含め、Claude Code 全体に効く。設定を元に戻すと、プラグインが足した 2 つの鍵だけが消える。

## 使い方

| 場所 | できること |
|---|---|
| サイドパネル（右サイドバー） | 新規セッション、セッションマネージャーを開く、設定。一覧は「開いているタブ」「起動中（デーモンには居るがタブが無い）」「最近」に分かれ、各行は状態の印・カテゴリのチップ・名前を出す。詳細欄（モデル・エフォート・接続状況、コンテキスト使用率、総トークン・総コスト、直近の指示・応答）。5 時間／7 日枠のレート制限とリセットまでのカウントダウン。 |
| セッションマネージャー | 新しいタブの既定の画面。セッションの木（カテゴリでグループ化、「その他」区分とアーカイブを含む）と、その下の折畳・リサイズ可能な分析パネル：5 時間／7 日の利用状況カード、7 日枠のペース判定、カテゴリ別のコストの帯。開いてもセッションは始まらない。 |
| ターミナルタブ | 1 セッション＝1 タブ。ヘッダの操作：現在のノートを `@path` として挿入、前の指示・次の指示・最後の応答へジャンプ。`Cmd +`／`Cmd −`／`Cmd 0` でそのタブのフォントサイズを変える。出力中のパスは vault 内に実在すればクリックできる。 |
| Ctrl+G（内蔵エディタ） | Claude Code が本来 `$VISUAL` に渡すファイルを、ターミナルの下の分割された編集領域で編集する。`@` によるファイル補完・自動保存・ネイティブのペースト／IME／Undo に対応。プロンプト編集での「送る」は即座に送信、Esc は送信せず入力欄に戻る。 |
| 行メニュー（⋯／右クリック） | 名前を変更、圧縮（`/compact`）、セッション解析結果を見る、アーカイブ⇄解除、セッションを終了、ID をコピー。 |
| セッション解析結果 | 行メニューから開く。コスト・トークン・ターン数・期間のカード、入力／出力／ツール使用のバー、ターン表。行をクリックして区間を選び、結果を Markdown としてコピーできる。 |

### セッションの状態

ターミナルタブ・サイドパネルの行・マネージャーの行は、セッションの状態について同じアイコン・色・動きを共有する：接続中、処理中（応答を生成中）、シェルコマンド実行中、回答待ち（質問または許可プロンプト）、未読（応答が終わったがまだタブを前面にしていない）、編集中（内蔵エディタが開いている）、待機、未接続（タブはあるがまだ接続していない）、compact 済み（`/compact` の直後で文脈がリセットされている）、終了、エラー。動きのある状態は `prefers-reduced-motion` を尊重する。

## 設定

フォント名とサイズ、余白（ゆったり／小さめ／なし）、送信キー、最近の件数、指示待ちの通知、`claude`／`agent-sessions`／Python のパス、ターミナルのスクロールバック行数、内蔵エディタの高さ、表示言語（自動／日本語／English）、サイドパネルの詳細欄とマネージャーの分析パネルの保存された高さ。

## CLI

```sh
agent-sessions                 # TUI：セッションを選んで attach／再開
agent-sessions attach ID       # 端末から attach（Ctrl+\ で detach）
agent-sessions daemon [--detach]
agent-sessions json scan|live|detail ID|usage ID [--from ISO --to ISO]|stats
agent-sessions setup [--dry-run]
```

`agent-sessions json` はプラグイン自身が使う機械可読の窓口（`scan`・`live`・`detail`・`usage`・`stats`）。`hook`・`status` は上記の Claude Code のフックと `statusLine` の受け口。`edit` は内蔵エディタの受け口。

## 仕組み

小さなデーモン（`agent-sessions daemon`。プラグインが必要なときに起動する）が各 Claude Code セッションの PTY を Unix ドメインソケット越しに保持するので、タブが attach していなくてもセッションは動き続ける。プラグインはターミナルの入出力についてデーモンと直接やり取りし、それ以外（transcript の走査、利用状況・コストの計算、セッションの木の構築）は `agent-sessions json …` を呼ぶ——このロジックはすべて Python 側にあり、プラグインと CLI／TUI が同じデータを見る。

セッションの管理情報（折畳・アーカイブ・カテゴリの色）は `<vault>/.agents/sessions/sessions.json` に、デーモンと実行時の状態（ソケット・ログ・status のスナップショット・キャッシュ）は `~/.agents/sessions/` 配下に置く。Claude Code 自身のファイル（`~/.claude/projects/*/*.jsonl`・`~/.claude/sessions/*.json`）は読むだけで、書き換えることはない。

設計の全体は [`docs/design.md`](docs/design.md)、本プラグインが拠って立つ要件は [`docs/requirements.md`](docs/requirements.md) を参照。

## アンインストール

アンインストール用のスクリプトは無い。`install.sh` が行ったことを手で戻す：

1. Obsidian の「コミュニティプラグイン」で **Agent Sessions** を無効化・削除し、`<vault>/.obsidian/plugins/agent-sessions` の symlink（またはディレクトリ）を消す。
2. `~/bin/agent-sessions`・`~/bin/agent-sessions-code` の symlink を消す。
3. `~/.claude/settings.json` から、`agent-sessions hook` を呼ぶ `Stop`／`SessionEnd`／`SessionStart`（matcher `compact`）／`UserPromptSubmit` のフックと、`agent-sessions status` を呼ぶ `statusLine` のエントリを消す（`setup` がインストール前に残した `settings.json.bak-<時刻>` が残っていればそこから戻せる）。
4. 送信キーを Enter 以外に変えていた場合、`~/.claude/keybindings.json` の `Chat` にプラグインが足した `enter`／`meta+enter` のエントリを消す。
5. デーモンはセッションも接続も無い状態が 10 分続くと自分で終了する。すぐ止めたければ `SIGTERM` を送る（pid は `~/.agents/sessions/daemon.pid`）。
6. 保存された状態をすべて消したければ `<vault>/.agents/sessions/` と `~/.agents/sessions/` を削除する。

## 開発

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # プラグイン（vitest・tsc・esbuild）
AGENT_SESSIONS_BIN=$PWD/../bin/agent-sessions npm test   # 実デーモンを使うテストも走らせる

cd ..
/usr/bin/python3 -W error -m unittest discover -s tests -t .   # Python（標準ライブラリのみ）
```
