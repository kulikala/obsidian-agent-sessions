**[English](README.md) | 日本語**

# Agent Sessions

[Obsidian](https://obsidian.md) の中で [Claude Code](https://claude.com/claude-code) と [Codex](https://github.com/openai/codex) のセッションをターミナルタブとして開き、管理するプラグイン。セッション一覧・利用状況ダッシュボード・タブを閉じても Obsidian を閉じてもセッションを生かし続けるデーモンを持つ。

## 主な特徴

- **複数エージェント対応** — Claude Code と Codex のセッションを同じ一覧に混在させ、並べ替え・絞り込みも一緒に行う。初回起動時に自動検出、どちらか一方、または両方を有効化でき、エージェントごとにパスと環境変数を設定できる。両方有効なときは「新規セッション」でどちらを起動するか選べる。
- **ターミナルタブ** — 1 セッション＝1 タブ、実体は PTY（xterm.js）。タブを閉じても Obsidian を終了してもセッションは動き続け、開き直すと直前の画面が再生される。
- **サイドパネル** — 右サイドバーに「開いているタブ」「起動中」「最近」の一覧、詳細欄、5 時間／7 日のレート制限（リセットまでのカウントダウン付き）。
- **セッションマネージャー** — カテゴリでまとまったセッションの木、並べ替えられる表（最終更新・モデル・エフォート・5h／7d のコスト・フォルダ）、利用状況の分析パネル：5 時間／7 日枠の統計カード、7 日枠のペース判定（「順調」か「このままでは使い切る」）、カテゴリ別のコスト内訳。
- **状態が分かるタブと行** — 処理中・シェルコマンド実行中・回答待ち・未読の応答・編集中・compact 済み・未接続・終了・エラーなど、セッションの状態ごとにアイコン・色・動きを出す。ターミナルタブ・サイドパネル・マネージャーで表示を揃える。
- **命名とカテゴリ** — 「カテゴリ: 名前」の形で名付けると、カテゴリごとに固定の色が付き、マネージャーで専用のグループになる。
- **内蔵エディタ** — セッション中に Ctrl+G を押すと、ターミナルの下に分割された編集領域が開き、今のプロンプト（または `/memory`・`/keybindings` 等）を編集できる。`@` によるファイル補完・自動保存・ネイティブのペースト／IME／Undo に対応。編集中もターミナルの出力は見えたまま。
- **移動の補助** — 出力中に現れるファイルパスは vault 内に実在すればクリックできるリンクになり、「現在のノートを `@path` として挿入」、前の指示・次の指示・最後の応答へのジャンプボタンを持つ。
- **セッション解析と利用状況** — セッション単位のトークン・コストをターン表付きで、アカウント全体の 5 時間／7 日の利用量を、どちらも各エージェント自身の transcript から算出する。
- **CLI と TUI** — Obsidian の外や自動化から使える単体の `agent-sessions` コマンド：セッションを選んで attach する TUI と、プラグインを裏で支える `json` サブコマンド。
- **日英 2 言語の UI** — 「自動」（Obsidian の言語設定に合わせる）・日本語・English を選べる。

## 対応環境

| | |
|---|---|
| **OS** | macOS——動作確認済み。Linux（WSLg 上の Linux 版 Obsidian を含む）——対応（ターミナルのキー割当と Python 側の両方にプラットフォーム分岐を持ち、CI と手動での Linux コンテナ検証を通している）が、実機の Obsidian での通しの動作確認はまだ済んでいない。Windows（ネイティブ）——非対応：デーモンは `pty`・`fcntl`・`termios`（Windows に相当するもののない Unix 専用の標準ライブラリ）に依存しており、Windows ネイティブ版の Obsidian には保持すべき PTY 自体が存在しない。WSLg 等で Linux 版の Obsidian を動かせばこの制約を回避できる。 |
| **Obsidian** | デスクトップ版のみ（`isDesktopOnly`。プロセスの起動と Unix ソケットを使うため——どちらもモバイル版・Web 版では使えない）、バージョン 1.7.2 以降（`minAppVersion`）。 |
| **Python** | 3.9 以降、標準ライブラリのみ。`$PATH`（`python3`）から見つける。 |
| **Claude Code／Codex（いずれか一方以上）** | どちらか一方、または両方をインストール済みで、`PATH` にあるか、プラグインの「エージェント」設定でパスを指定する（初回起動時に自動検出）。Claude Code：本プラグインは Claude Code のフック（`Stop`・`SessionEnd`・`SessionStart`（matcher `compact`）・`UserPromptSubmit`）と `statusLine`、そして送信キーの設定を既定から変えた場合のみ `keybindings.json` に依存する。Codex：hooks／statusLine 相当はまだ使っていない。実機での確認はまだ済んでいない（[`docs/design.md`](docs/design.md) §7.7・§25 参照）。 |
| **Node.js／npm** | ソースからプラグインをビルドする場合のみ必要（[開発](#開発)を参照）。CI では Node.js 20 でビルドしている。 |

## インストール

パッケージ化された配布物はまだ無いため、ローカルの clone から入れる。

```sh
git clone https://github.com/kulikala/obsidian-agent-sessions.git
cd obsidian-agent-sessions
(cd plugin && npm install && npm run build)
./scripts/install.sh /path/to/your/vault
```

vault のパスは必須——`install.sh` の第 1 引数として渡すか、環境変数 `AGENT_SESSIONS_VAULT` で指定する（`AGENT_SESSIONS_VAULT=/path/to/your/vault ./scripts/install.sh`）。

`install.sh` が行うこと：

- `bin/agent-sessions`・`bin/agent-sessions-code` を `~/bin` に symlink する。
- `plugin/` を `<vault>/.obsidian/plugins/agent-sessions` に symlink する。
- `agent-sessions setup` を実行する。これは **`~/.claude/settings.json` を書き換える**（先に `settings.json.bak-<時刻>` としてバックアップを残す）：`Stop`・`SessionEnd`・`SessionStart`（matcher `compact`）・`UserPromptSubmit` の各フックを `agent-sessions hook` に向けて追加・更新し、`statusLine` を `agent-sessions status` に設定する。自分が付けたと分かるエントリだけを触り、他のフックはそのまま残す。

その後、Obsidian の「コミュニティプラグイン」で **Agent Sessions** を有効にする。

**送信キー**の設定を既定（Enter）以外に変えると、Claude Code 自身のキー割当と揃えるため、プラグインは `~/.claude/keybindings.json`（`Chat` コンテキスト）にも書き込む——これは Obsidian の外で起動した Claude Code を含め、Claude Code 全体に効く（ただし、選んだキーが確実に働くのはこのプラグイン自身のターミナルタブだけで、他のターミナルアプリがそのキーを素の Enter と区別できるかはターミナル次第）。設定を元に戻すと、この設定のためにプラグインが管理している鍵が消える。

プラグインが一度でも起動していれば、Obsidian の外で `agent-sessions` CLI を使うときも vault のパスを重ねて指定する必要はない——`~/.agents/sessions/vault.json`（プラグインが最新に保つ）から vault の場所を読む。

## 使い方

| 場所 | できること |
|---|---|
| サイドパネル（右サイドバー） | 新規セッション、セッションマネージャーを開く、設定。一覧は「開いているタブ」「起動中（デーモンには居るがタブが無い）」「最近」に分かれ、各行は状態の印・カテゴリのチップ・名前を出す。詳細欄（モデル・エフォート・接続状況、コンテキスト使用率、総トークン・総コスト、直近の指示・応答）。5 時間／7 日枠のレート制限とリセットまでのカウントダウン。 |
| セッションマネージャー | 新しいタブの既定の画面。セッションの木（カテゴリでグループ化、「その他」区分とアーカイブを含む）と、その下の折畳・リサイズ可能な分析パネル：5 時間／7 日の利用状況カード、7 日枠のペース判定、カテゴリ別のコストの帯。開いてもセッションは始まらない。 |
| ターミナルタブ | 1 セッション（Claude Code または Codex）＝1 タブ。ヘッダの操作：現在のノートを `@path` として挿入、前の指示・次の指示・最後の応答へジャンプ。`Cmd +`／`Cmd −`／`Cmd 0`（macOS）または `Ctrl+Shift+=`／`Ctrl+Shift+-`／`Ctrl+Shift+0`（それ以外）でそのタブのフォントサイズを変える。非 macOS では `Ctrl+Shift+C`／`Ctrl+Shift+V` が選択のコピー・貼り付け、`Ctrl+Shift+W` でタブを閉じ、`Ctrl+Shift+P` でコマンドパレットを開く。素の `Ctrl+<key>`（`Ctrl+C`・`Ctrl+G`・`Ctrl+W`・`Ctrl+P` 等）は常にそのエージェントへ届き Obsidian には渡らない。送信キーの設定と Enter の横取りは Claude Code のタブだけに効く——Codex のタブは自身のキー割当のまま。出力中のパスは vault 内に実在すればクリックできる。 |
| Ctrl+G（内蔵エディタ） | Claude Code が本来 `$VISUAL` に渡すファイルを、ターミナルの下の分割された編集領域で編集する。`@` によるファイル補完・自動保存・ネイティブのペースト／IME／Undo に対応。プロンプト編集での「送る」は即座に送信、Esc は送信せず入力欄に戻る。 |
| 行メニュー（⋯／右クリック） | 名前を変更、圧縮（`/compact`）、セッション解析結果を見る、アーカイブ⇄解除、セッションを終了、ID をコピー。 |
| セッション解析結果 | 行メニューから開く。コスト・トークン・ターン数・期間のカード、入力／出力／ツール使用のバー、ターン表。行をクリックして区間を選び、結果を Markdown としてコピーできる。 |

### セッションの状態

ターミナルタブ・サイドパネルの行・マネージャーの行は、セッションの状態について同じアイコン・色・動きを共有する：接続中、処理中（応答を生成中）、シェルコマンド実行中、回答待ち（質問または許可プロンプト）、未読（応答が終わったがまだタブを前面にしていない）、編集中（内蔵エディタが開いている）、待機、未接続（タブはあるがまだ接続していない）、compact 済み（`/compact` の直後で文脈がリセットされている）、終了、エラー。動きのある状態は `prefers-reduced-motion` を尊重する。

これらはさらに、Claude 本体のアプリがセッションを絞り込む際と同じ区分にまとめられる——入力待ち・レビュー待ち・実行中・完了、それぞれ対応するアイコンと色を揃え、加えてアーカイブ済みの区分もある。セッションマネージャーのツールバーには、この同じ6区分（すべて／入力待ち／レビュー待ち／実行中／完了／アーカイブ済み）で絞り込むメニューがある。

状態マークの横の小さなアイコンで、そのセッションがどのエージェント（Claude Code／Codex）かが分かる——ブランドロゴではなく、ただのアイコン。

## 設定

フォント名とサイズ、余白（ゆったり／小さめ／なし）、送信キー、最近の件数、指示待ちの通知、エージェント（Claude Code／Codex——有効化・パス・環境変数）、`agent-sessions` のパス、ターミナルのスクロールバック行数、内蔵エディタの高さ、表示言語（自動／日本語／English）、サイドパネルの詳細欄とマネージャーの分析パネルの保存された高さ。

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

```sh
"<このリポジトリのパス>/scripts/uninstall.sh" "<vault>"
```

これに加えて、Obsidian の「コミュニティプラグイン」で **Agent Sessions** を無効化・削除する。

`uninstall.sh` は、デーモンを止め（動いているセッションが残っていれば確認を求める——飛ばすには
`--force`）、`~/.claude/settings.json` から自分が足したフックと `statusLine` を取り除き
（`install.sh` と同じやり方で先に backup を残す）、送信キーを Enter 以外に変えていた場合は
`~/.claude/keybindings.json` の `Chat` に足した `enter`／`meta+enter` を取り除き、
`~/bin/agent-sessions`・`~/bin/agent-sessions-code`・`<vault>/.obsidian/plugins/agent-sessions`
の symlink を外す（symlink でなければ——手で置き換えている等——消さずに案内だけ出す）。他の
ツールのフック・`statusLine`・キーバインドには触れず、何度実行しても安全（冪等）。

`--purge` を付けると `~/.agents/sessions/`（デーモンの実行時状態）と
`<vault>/.agents/sessions/`（折畳・アーカイブ・カテゴリの色などのセッション管理情報）も消す。

## 開発

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # プラグイン（vitest・tsc・esbuild）
AGENT_SESSIONS_BIN=$PWD/../bin/agent-sessions npm test   # 実デーモンを使うテストも走らせる

cd ..
python3 -W error -m unittest discover -s tests -t .   # Python（標準ライブラリのみ）
```

### 言語を追加するには

`plugin/src/i18n/locales/<code>.ts`（`Partial<Record<MessageKey, string>>` と、自称名を持つ
`<CODE>_SELF_NAME` の組——`locales/ja.ts` を参照）と `agentsessions/i18n/locales/<code>.py`
（`MESSAGES` 辞書——`locales/ja.py` を参照）を追加し、それぞれ1行ずつ `i18n/index.ts` の
`LOCALES` と `i18n/__init__.py` の `_TABLES` に登録する。言語は不完全な状態から始めてよく、
未対応のキーはどちらの側でも英語にフォールバックする。詳細は
[`docs/design.md`](docs/design.md#17-i18n) を参照。

### リリース（メンテナ向け）

```sh
cd plugin && npm version patch   # minor / major も可。plugin/manifest.json・直下の manifest.json・versions.json を更新する
git push && git push --tags
```

`plugin/.npmrc` で `tag-version-prefix=""` を設定してあるので、`npm version` が打つタグは素のバージョン番号（`v0.1.1` ではなく `0.1.1`）——`manifest.json` の `version` と完全に一致する。Obsidian のリリース側のツールが期待する形。

タグを push すると `.github/workflows/release.yml` が走り、プラグインをビルドして `main.js`・`manifest.json`・`styles.css` を GitHub Release の draft に添付する。draft の内容を確認してから公開する。

## ライセンス

MIT。全文は [`LICENSE`](LICENSE)。`plugin/main.js` には xterm.js とそのアドオン（同じく MIT）が同梱されており、そのライセンス全文と著作権表示は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) にある。
