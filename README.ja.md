**[English](README.md) | 日本語**

# Agent Sessions

[Claude Code](https://claude.com/claude-code)・[Codex](https://github.com/openai/codex)・[OpenCode](https://opencode.ai) を、ノートの隣のターミナルタブで動かす [Obsidian](https://obsidian.md) のプラグインです。すべてのセッションの状態とコスト、エージェントごとの利用枠を1つの一覧で見られます。

デスクトップ専用です。macOS、Linux、Windows（Claude Code のみ）で動きます。

![ターミナルタブで動く Claude Code のセッションと、開いている・実行中・最近の Claude Code と Codex のセッションを並べたサイドパネル](docs/images/overview.png)

## 機能

- **エージェントの CLI をそのままタブで。** 設定、ログイン、スラッシュコマンド、フック、スキル、MCP サーバーは、ターミナルと同じように使えます。出力に出た vault 内のパスは、リンクとして開けます。
- **セッションは動き続けます。** タブを閉じても、Obsidian を終了しても止まりません。開き直すと最後の画面が出て、続きから作業できます。
- **状態がひと目でわかります。** 作業中、回答待ち、未読の返答あり、完了を、どこでも同じアイコンで示します。別のタブのセッションが終わったときや質問してきたときは、通知が出ます。
- **セッションマネージャー。** セッションをカテゴリごとにまとめます（名前を `カテゴリ: 名前` の形にします）。並べ替えと、状態での絞り込みができます。
- **セッション名とカテゴリを整理。** 手元のエージェントが名前とカテゴリを提案します。適用するまで名前は変わりません。提案のため、セッションの抜粋をそのエージェントに送ります（[整理で送る内容](#整理で送る内容)）。
- **利用状況とコスト。** エージェントごとの5時間枠と7日枠、リセットまでの時間、今のペースでの週の見通しを出します。セッションごと・カテゴリごとの推定コストと、Markdown でコピーできるターンごとの解析もあります。エージェントが残すファイルをもとに、このマシンの中で計算します。
- **稼働カレンダー。** 各エージェントが作業していた時間を、7日枠・週・日の単位で示します。ブロックをクリックすると、その中のプロンプトを見て、セッションを開けます。
- **内蔵エディタ**（Ctrl+G）。ターミナルの下の枠でプロンプトを書けます。`@` でのファイル補完、ふつうの貼り付け、取り消し、IME での入力が使えます。
- **セッションを再起動**で、変えた設定やスキルを読み込み直し、会話を続けます。
- **モデルを変更…**（Claude Code）で、モデルとエフォート を切り替えます。
- **ようこそガイド。** Python とエージェントを確かめ、補助プログラムを入れ、最初のセッションまで案内します。
- **エージェントスキル。** 利用状況、ほかのセッション、プラグインの使い方を、エージェントに尋ねられます。

![セッションマネージャー：カテゴリ別のセッションと枠ごとのコスト、その下に5時間枠と7日枠の利用状況](docs/images/manager.png)

![稼働カレンダー：1週間のセッションを色付きのブロックで並べ、日ごとにエージェント別のレーンと、エージェントごとの時間と同時実行数を表示](docs/images/calendar.png)

すべての機能は [`docs/usage.md`](docs/usage.md) にあります。

**ないもの：** チャットパネル、ノートをその場で書き換える機能、Obsidian のモバイル版。OpenCode には利用枠がありません。OpenCode のサブエージェントのセッションと、`opencode run` で始めたセッションは一覧に出ません。

## 動作に必要なもの

- Obsidian 1.8.7 以降のデスクトップ版。
- Python 3.9 以降。追加のパッケージは要りません。セッションを動かし続ける補助プログラムに使います。
- Claude Code・Codex・OpenCode のどれか（インストール済みのもの）。

## 対応環境

| Obsidian | エージェント | 対応 |
|---|---|---|
| macOS | macOS | 対応 |
| Linux | Linux | 対応 |
| Windows 10（1809 以降）、11 | Windows | Claude Code のみ |
| Windows | WSL | 非対応 |
| WSL2（WSLg） | 同じ WSL ディストリビューション | 対応 |

Obsidian とエージェントは、同じ OS で動かしてください。プラグインがエージェントのプロセスを起動し、そのファイルを読むためです。エージェントを WSL で使うなら、Obsidian も WSLg で WSL の中で動かし、vault は `/mnt/c` ではなく WSL のファイルシステムに置いてください。

## インストール

1. Obsidian で **設定 → コミュニティプラグイン → 閲覧** を開き、**Agent Sessions** を検索して、インストールし、有効にします。
2. 開いたようこそガイドに沿って進めます。補助プログラム `agent-sessions` を入れ、最初のセッションを始めます。あとで戻るときは、コマンドパレットで **ようこそガイドの続きから** を実行します。

プログラムの置き場所と、ソースからのインストールは [`docs/installation.md`](docs/installation.md) にあります。

## 困ったとき

- **「agent-sessions が見つからない」**：サイドパネルの **agent-sessions をインストール** を押すか、プラグインの設定でプログラムの場所を指定します。
- **「agent-sessions を自分でインストールし（README を参照）」**：リポジトリから入れて（[`docs/installation.md`](docs/installation.md#from-a-clone)）、プラグインの設定でその場所を指定します。
- **エージェントに「見つかりませんでした。」と出る**：プラグインの設定でパスを指定するか、ようこそガイドの **検出し直す** を押します。
- **変えた設定・フック・スキルがセッションに効かない**：セッションの ⋯ メニューで **セッションを再起動** を選びます。
- **Windows で、インストールのダイアログに Python か Claude Code が無いと出る**：**WinGet で Python をインストール** か **WinGet で Claude Code をインストール** を押します（ユーザー単位で、管理者の確認は出ません）。
- **フックが `node: not found` で失敗する**、そのほかの場合：[`docs/usage.md`](docs/usage.md#more-troubleshooting)。

## アンインストール

1. **設定 → agent-sessions プログラム → 削除**。動いているセッションを終え、プログラム、エージェントの設定に足した項目、vault のスキルを取り除きます。OpenCode の `tui.json` は元の値に戻します。
2. コミュニティプラグインで **Agent Sessions** を無効にして、削除します。
3. 何も残したくない場合は、`~/.agents/sessions/`、`<vault>/.agents/sessions/`、バックアップの `~/.claude/settings.json.bak-*` と `~/.codex/config.toml.bak-*` を削除します。

ソースから入れた場合：[`docs/installation.md`](docs/installation.md#uninstall)。

## 開示事項

テレメトリーはなく、アカウントも要りません。エージェントの権限はターミナルで使うときと同じで、各自のアカウントでそれぞれのサービスに接続します。

### ネットワーク

- プラグインとプログラムは、自分の処理のためにネットワークへ接続しません。プラグインは、同じマシンで動くプログラムの常駐プロセスとやりとりします。Unix ソケット（モード 0600）を使い、Windows では `127.0.0.1` のランダムなポートと秘密のトークンを使います。
- ようこそガイドを開いているあいだは、図を `raw.githubusercontent.com` から読み込みます。利用者のデータは送りません。GitHub には IP アドレスと、どの図を求めたかが伝わります。設定の **ガイドの図を GitHub から読み込む** で止められます。

### 起動するプログラム

- `agent-sessions` を、このマシンにある Python で動かします。インストールを押したときにプラグインから書き出すもので、ダウンロードはしません。
- インストール済みの Claude Code・Codex・OpenCode の CLI。選んだ場合は `ollama launch opencode`。設定画面では、Ollama のモデルを並べるために `ollama list` を実行します。
- ターミナルと同じ `PATH` を得るため、シェルをログインシェルと対話シェル（`.zshrc` や `.bashrc` を読みます）として起動します。
- Windows では `reg.exe`（`PATH` を読むため）、`py.exe`（Python を探すため）。`winget.exe` は、インストールのボタンを押したときだけです。

### vault の外で読むファイル

セッションの一覧と利用状況のために読みます。

- `~/.claude/projects/`、`~/.claude/sessions/`、`~/.claude/settings.json`
- `~/.codex/`（または `$CODEX_HOME`）
- `~/.local/share/opencode/opencode.db`（読み取り専用で開きます）

読み取り専用で開けないデータベースは、一時フォルダに写して読み、そのあと削除します。

### 書き込むファイル

| パス | 中身 | いつ |
|---|---|---|
| `~/.agents/sessions/` | ソケット、ログ、状態ファイル、キャッシュ | 常に |
| `~/.local/share/agent-sessions`（Windows：`%LOCALAPPDATA%\agent-sessions`） | プログラム | インストール時 |
| `~/.claude/settings.json` | 4つのフック、`statusLine` | インストール時 |
| `~/.claude/keybindings.json` | 送信キー、エディタキー | 既定から変えたとき |
| `~/.codex/config.toml` | 変えた送信キーとエディタキー、未設定ならステータスライン | Codex が有効なとき |
| `~/.config/opencode/plugins/agent-sessions.js` | ステータス用プラグイン | OpenCode が有効なとき |
| `~/.config/opencode/agent-sessions-tui.jsx` | ステータスライン | OpenCode が有効なとき |
| `~/.config/opencode/tui.json` | エディタキー、送信キー、ステータスラインの項目 | OpenCode が有効なとき |
| 一時ファイル | 編集中のプロンプト | 内蔵エディタを開いているとき |
| `<vault>/.agents/sessions/sessions.json` | ここで始めたセッション（フォルダ、エージェント）、アーカイブ、カテゴリの色、折りたたんだグループ | 常に |
| `<vault>/.claude/skills/` | `agent-sessions` と `agent-sessions-help` のスキル | Claude Code が有効なとき |
| `<vault>/.agents/skills/` | 同じスキル | Codex が有効なとき |
| `<vault>/.opencode/skills/` | 同じスキル | OpenCode だけのとき |

- `~/.claude/settings.json` と `~/.codex/config.toml` は、変える前にバックアップします。`tui.json` の元の値は `~/.agents/sessions/opencode-tui-backup.json` に残します。
- プラグインが足した項目には印を付けるか（Codex、OpenCode、スキルのファイル）、コマンドで見分けます（Claude Code）。それ以外は変えません。
- vault を同期していれば、`sessions.json` も同期されます。
- プログラムが置かれうるほかのフォルダ：[`docs/installation.md`](docs/installation.md#where-the-program-goes)。

### 整理で送る内容

**セッション名とカテゴリを整理** で **提案する** を押すまで、何も送りません。押すと、プラグインはエージェントを1回だけ起動します。使うのは、Claude Code、Codex、OpenCode のうち最初に見つかったものです。どれを使うかはダイアログに出ます。

- Claude Code：`claude -p` を Sonnet（設定で Haiku）で、ツールなし・記録なしで実行します。
- Codex：`codex exec` を読み取り専用のサンドボックスで実行します。
- OpenCode：`opencode run` を実行し、保存されたセッションは直後に削除します。

最大30件のセッション（または選んだ1件）について、今の名前、フォルダ、最初のプロンプト、直近に入力した3つのプロンプト、最後の返答の短い抜粋を送ります。あわせて、既存のカテゴリ名と、カテゴリごとのセッション数、セッション名の例を最大3つ送ります。もう一度提案させるときは、前回の提案とコメントも送ります。送り先はそのエージェントのサービスで、そのアカウントの利用枠に数えられます。

### その他のアクセス

- vault のファイル一覧：内蔵エディタで `@` のパスを補完するときだけ読みます。
- クリップボード：セッション ID や解析の表をコピーするときと、ターミナルタブで Ctrl+Shift+C / Ctrl+Shift+V を押したとき（macOS 以外）だけ使います。

## 開発

ビルド、テスト、リリース、設計：[`docs/development.md`](docs/development.md)。

## ライセンス

MIT です（[`LICENSE`](LICENSE)）。`plugin/main.js` には xterm.js とそのアドオン（これも MIT）を同梱しています。それらの表示は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) にあります。
