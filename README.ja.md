**[English](README.md) | 日本語**

# Agent Sessions

**Obsidian のノートの隣で、ターミナルのエージェントに仕事を頼むための作業台です。**

[![Release](https://img.shields.io/github/v/release/kulikala/obsidian-agent-sessions?style=flat-square)](https://github.com/kulikala/obsidian-agent-sessions/releases)
[![License](https://img.shields.io/github/license/kulikala/obsidian-agent-sessions?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square)

[インストール](#インストール) · [ドキュメント](docs/usage.md) · [English](README.md)

[Claude Code](https://claude.com/claude-code)・[Codex](https://github.com/openai/codex)・[OpenCode](https://opencode.ai) を、[Obsidian](https://obsidian.md) のターミナルタブで動かすプラグインです。ノートを開いたまま、隣のタブでエージェントに作業を頼めます。

![ターミナルタブで動く Claude Code のセッションと、開いているタブ・起動中・最近のセッションを並べたサイドパネル](docs/onboarding/ja/overview.png)

- **タブを閉じても、Obsidian を終了しても、セッションは止まりません。** このマシンに常駐する小さな補助プログラムが、セッションを動かし続けます。（[起動するプログラム](#起動するプログラム)）
- **終わったセッションも、続きから再開できます。** サイドパネルでクリックすると、新しいタブで会話の続きが始まります。（[サイドパネルでのセッションの切り替え](#サイドパネルでのセッションの切り替え)）
- **すべてのセッションの状態・使用量・コストを、1 つの一覧で確かめられます。** 実行中か、入力を待っているか、終わったかがわかります。使用量とコストは、エージェントが手元に残すファイルをもとに、このマシンの中で計算します。（[ネットワーク](#ネットワーク)）

## 向いている人

次のような人に向いています。

- Claude Code や Codex を一日中使い、仕様書・提案書・ノートの下書きを任せている。
- 複数の案件を同時に進めていて、どのセッションが自分の返事を待っているかを知りたい。
- 書類を Obsidian で管理していて、Obsidian のエディターをターミナルの隣で使いたい。

チャット欄でエージェントと話したい人や、開いているノートをエージェントにその場で書き換えてほしい人には向いていません。このプラグインで使うのは、エージェント自身のターミナルです。モバイルだけで使う人や、Windows の Obsidian から WSL の中のエージェントを使いたい人にも向いていません。

## インストールで起きること

![agent-sessions のインストールダイアログ。インストール先のフォルダ、Python、Claude Code の設定に追加するフック、vault に追加する 2 つのエージェントスキルが並んでいる](docs/onboarding/ja/install.png)

プラグインは、何かをインストールする前に、上のダイアログを表示します。

- テレメトリーはなく、アカウント登録も要りません。プラグインがネットワークに接続するのは、Remote Control サーバーと、ようこそガイドの図の読み込みだけです。どちらも[ネットワーク](#ネットワーク)で説明しています。
- `~/.claude/settings.json` に 4 つのフックとステータスラインを書き込みます。書き込む前にバックアップを取ります。（[書き込むファイル](#書き込むファイル)）
- 補助プログラムと、エージェントの設定に追加した項目は、**設定 → agent-sessions プログラム → 削除** で取り除けます。（[アンインストール](#アンインストール)）

## 動作に必要なもの

- デスクトップ版の Obsidian 1.8.7 以降（macOS、Linux、Windows）。
- Python 3.9 以降。追加のパッケージは要りません。補助プログラムは Python で動きます。
- Claude Code、Codex、OpenCode のどれか 1 つ以上を、インストールしてログインしておきます。費用はそれぞれの契約の範囲で済み、このプラグインのためのアカウントやキーは要りません。
- どれもまだ使ったことがなければ、先に公式ページからインストールしてください（[Claude Code](https://claude.com/claude-code)、[Codex](https://github.com/openai/codex)、[OpenCode](https://opencode.ai)）。

## エージェントを選ぶ

3 つのエージェントは、どれもタブで開けて、一覧にも並びます。違うのは、表示できる使用量の範囲です。

| エージェント | タブで開く | 状態つきで一覧に並ぶ | 使用量とコスト |
|---|---|---|---|
| Claude Code | ✅ あり | ✅ あり | ✅ あり |
| Codex | ✅ あり | ✅ あり | ✅ あり |
| OpenCode | ✅ あり | ✅ あり | コストのみ |

## Obsidian の中で動かす理由

- プロンプトエディター（Ctrl+G）は、Obsidian のペインとして開きます。`@` でファイル名を補完でき、貼り付け・元に戻す・日本語入力もふだんどおりに使えます。[詳しく](docs/usage.md#built-in-editor)
- エージェントの出力に vault のパスが出てくると、リンクとして開けます。
- セッションは普通の Obsidian のタブなので、画面を分割してノートの隣に置けます。

## 機能

### カテゴリ別のセッションと、利用状況とコスト

**セッションマネージャー** は、`カテゴリ: 名前` の形で名付けたセッションをカテゴリごとにまとめ、5 時間枠と 7 日枠のコストを示します。セッションの一覧の下には、Claude Code と Codex の利用枠について、リセットまでの時間と、今のペースで上限に届くかどうかが出ます。コストは推定値です。[詳しく](docs/usage.md#session-manager)

![セッションマネージャー。カテゴリ別のセッションとモデル・エフォート・コスト、その下に 5 時間枠と 7 日枠、カテゴリ別のコスト](docs/onboarding/ja/manager.png)

### どのエージェントでもセッションを開始

**新規セッション** を押すと、セッションの名前を聞かれます。設定で複数のエージェントを有効にしていれば、使うエージェントも選びます。Claude Code・Codex・OpenCode のセッションは、同じ一覧に並びます。[詳しく](docs/usage.md#start-a-session)

![新規セッションのダイアログ。エージェントの選択肢に Claude Code と Codex、名前に「ドキュメント: リリースノート」](docs/onboarding/ja/new-session.png)

### エージェントの CLI をそのままタブで

セッションのタブでは、エージェントのコマンドラインプログラムそのものが動きます。設定、ログイン、スラッシュコマンド、フック、スキル、MCP サーバーも、ターミナルで使うときと同じです。[詳しく](docs/usage.md#work-in-a-session-tab)

![ターミナルタブで動く Codex のセッションが、テストのコマンドを実行してよいか尋ねている](docs/images/ja/codex.png)

### サイドパネルでのセッションの切り替え

サイドパネルには、開いているタブ、タブを閉じたまま動いているセッション、最近のセッションが、状態のアイコンつきで並びます。クリックすると、セッションのタブが前に出ます。タブが無ければ新しいタブで開き、終わったセッションは会話の続きから再開します。一覧の下には、選んだセッションの状態が一文で出ます。[詳しく](docs/usage.md#switch-between-sessions)

![サイドパネル。開いているタブ・起動中・最近のセッションが状態のアイコンとカテゴリつきで並び、上に入力待ちとレビュー待ちの数](docs/onboarding/ja/side-panel.png)

### ほかの機能

- **[Remote Control](docs/usage.md#remote-control-server)**　サイドパネルの **rc** トグルをオンにすると、claude.ai や Claude アプリから、この vault で Claude Code のセッションを始められます。接続先は[ネットワーク](#ネットワーク)で説明しています。
- **[名前の変更とカテゴリ分け](docs/usage.md#name-and-group-sessions)**　`ドキュメント: リリースノート` のように名付けると、セッションが「ドキュメント」カテゴリに入ります。
- **[エージェントによる名前とカテゴリの提案](docs/usage.md#organize-names-and-categories)**　エージェントがセッションの名前とカテゴリを提案します。**選択を適用** を押すまで、名前は変わりません。提案するエージェントには、セッションの抜粋を送ります。送る内容は[整理で送る内容](#整理で送る内容)にあります。
- **[圧縮・再起動・モデル変更](docs/usage.md#compact-restart-and-change-model)**　セッションの ⋯ メニューから行えます。
- **[利用枠を増やす](docs/usage.md#stretch-your-usage-limit)**　直近の作業をエージェントが読み、トークンの無駄を 9 つの観点で探して、直し方を示します。送る内容は[「利用枠を増やす」で送る内容](#利用枠を増やすで送る内容)にあります。
- **[セッション解析](docs/usage.md#session-analytics)**　1 つのセッションのコスト・トークン数・ターン数を、プロンプトごとのコストとあわせて見られます。
- **[稼働カレンダー](docs/usage.md#activity-calendar)**　どのエージェントがいつ作業していたかを、7 日の利用枠ごと・週ごと・日ごとに見られます。
- **[ようこそガイド](docs/usage.md#welcome-guide)** と 2 つの[エージェントスキル](docs/usage.md#agent-skills)　ようこそガイドは、最初の設定から順に案内します。エージェントスキルは vault に追加され、使用量やほかのセッション、プラグインの使い方をエージェントに尋ねられます。

すべての機能の説明は [`docs/usage.md`](docs/usage.md) にあります。

## 対応環境

| Obsidian | エージェント | 対応 |
|---|---|---|
| macOS | macOS | ✅ 対応 |
| Linux | Linux | ✅ 対応 |
| Windows 10（1809 以降）、11 | Windows | ✅ 対応 |
| Windows | WSL | ❌ 非対応 |
| WSL2（WSLg） | 同じ WSL ディストリビューション | ✅ 対応 |

Obsidian とエージェントは、同じ OS の上で動かしてください。プラグインがエージェントのプロセスを起動し、エージェントのファイルを読み続けるからです。エージェントを WSL で使う場合は、Obsidian も WSLg を使って WSL の中で動かします。vault は `/mnt/c` の下ではなく、WSL のファイルシステムに置いてください。

## インストール

1. Obsidian で **設定 → コミュニティプラグイン → 閲覧** を開き、**Agent Sessions** を探してインストールし、有効にします。
2. ようこそガイドが開きます。補助プログラム `agent-sessions` のインストールから最初のセッションの開始まで、ガイドに沿って進めます。あとでガイドに戻るときは、コマンドパレットで **ようこそガイドの続きから** を実行します。

補助プログラムのインストール先と、ソースからインストールする方法は [`docs/installation.md`](docs/installation.md) にあります。

## 困ったとき

- **「agent-sessions が見つからない」と出る**：サイドパネルの **agent-sessions をインストール** を押します。または、プラグインの設定の **agent-sessions の場所** にプログラムの場所を入れます。
- **「agent-sessions を自分でインストールし（README を参照）」と出る**：リポジトリからインストールし（[`docs/installation.md`](docs/installation.md#from-a-clone)）、プラグインの設定の **agent-sessions の場所** に、インストールしたプログラムの場所を入力します。
- **エージェントの欄に「見つかりませんでした。」と出る**：プラグインの設定で、そのエージェントの **実行ファイル** を指定するか、ようこそガイドで **検出し直す** を押します。
- **変更した設定・フック・スキルがセッションに反映されない**：セッションの ⋯ メニューで **セッションを再起動** を選びます。
- **Windows で、インストールのダイアログに Python や Claude Code が無いと出る**：**WinGet で Python をインストール** または **WinGet で Claude Code をインストール** を押します。ユーザー単位でインストールするので、管理者の確認は出ません。
- **ARM 版 Windows で、OpenCode のタブが `bun:ffi dlopen() is not available in this build (TinyCC is disabled)` で止まる**：WinGet が入れる OpenCode の ARM64 版は、ターミナル画面を起動できません。x64 版の OpenCode を入れてください。x64 版は Windows のエミュレーションで動きます。
- **フックが `node: not found` で失敗する、またはここにない症状が出る**：[`docs/usage.md`](docs/usage.md#more-troubleshooting) の対処を見てください。

## アンインストール

1. **設定 → agent-sessions プログラム → 削除** を押します。動いているセッションを終了し、補助プログラム、エージェントの設定に追加した項目、vault のスキルを取り除きます。OpenCode の `tui.json` は、インストール前の値に戻します。
2. コミュニティプラグインの一覧で **Agent Sessions** を無効にし、削除します。
3. 何も残したくない場合は、`~/.agents/sessions/`、`<vault>/.agents/sessions/`、バックアップの `~/.claude/settings.json.bak-*` と `~/.codex/config.toml.bak-*` を手で削除します。

ソースからインストールした場合の手順は [`docs/installation.md`](docs/installation.md#uninstall) にあります。

## しないこと

- 会話の中身は、どこにも送りません。例外は、整理で **提案する** を押したときと、「利用枠を増やす」で **解析する** を押したときだけです。
- OpenCode には利用枠がないため、利用枠は表示しません。OpenCode のサブエージェントのセッションと `opencode run` のセッションも、一覧には出ません。

## 開示事項

テレメトリーはなく、アカウント登録も要りません。エージェントには、ターミナルで使うときと同じ権限があり、エージェントはあなたのアカウントでそれぞれのサービスに接続します。

### ネットワーク

- プラグインと補助プログラムが自分の処理のためにネットワークへ接続するのは、Remote Control サーバーと、ようこそガイドの図の読み込みだけです。どちらも下で説明します。プラグインと、同じマシンに常駐する補助プログラムとのやり取りには、Unix ソケット（モード 0600）を使います。Windows では、`127.0.0.1` のランダムなポートと秘密のトークンを使います。
- Remote Control は、サイドパネルの **rc** トグルでオンにしたときだけ、vault のフォルダで `claude remote-control --spawn=same-dir --permission-mode <モード>` を実行します。起動した Claude Code のプロセスは、Anthropic のサーバーに接続したままになります。あなたの Claude アカウントにログインしている人が claude.ai や Claude アプリから接続するたびに、vault で新しいセッションが始まります。モードは、プラグインの設定の Claude Code の欄にある **Remote Control の権限モード** で選びます。既定は auto で、Claude は確認を求めずにツールを使います。Claude Code が auto を受け付けない場合、セッションは Claude Code の既定のモードで動きます。初めてトグルをオンにするときと、設定を auto に変えたあと最初にオンにするときは、選んだモードで何が許されるかをダイアログで示し、確認を得てからサーバーを起動します。Obsidian やプラグインを読み込んだだけでは起動しません。
- ようこそガイドを開いているあいだは、ガイドの図を `raw.githubusercontent.com` から読み込みます。あなたのデータは送りません。GitHub には、IP アドレスと、どの図を読み込んだかが伝わります。設定の **ガイドの図を GitHub から読み込む** をオフにすると、読み込みを止められます。

### 起動するプログラム

- `agent-sessions`：このマシンにある Python で動かします。インストールを押したときにプラグインの中から書き出すもので、ダウンロードはしません。
- `claude remote-control`：**rc** トグルを押したときだけ起動します。
- Claude Code・Codex・OpenCode の CLI：インストール済みのものを、セッションを開くときに起動します。設定で OpenCode の起動方法に Ollama を選んだ場合は、`ollama launch opencode` を起動します。プラグインの設定画面では、Ollama のモデルを一覧にするために `ollama list` を実行します。
- あなたのシェル：ターミナルと同じ `PATH` を得るために、ログインシェルとして、また対話シェル（`.zshrc` や `.bashrc` を読む）として起動します。
- Windows では、`reg.exe`（`PATH` を読むため）と `py.exe`（Python を探すため）を起動します。`winget.exe` は、インストールのボタンを押したときだけ起動します。

### vault の外で読むファイル

セッションの一覧を作り、利用状況を計算するために、次のファイルを読みます。

- `~/.claude/projects/`、`~/.claude/sessions/`、`~/.claude/settings.json`
- `~/.codex/`（または `$CODEX_HOME`）
- `~/.local/share/opencode/opencode.db`（読み取り専用で開きます）

`opencode.db` を読み取り専用で開けないときは、一時フォルダにコピーしてから読み、読み終えたらコピーを削除します。

「利用枠を増やす」の解析でも、上の一覧にある Claude Code のセッション記録（transcript）、Codex の記録（rollout）、OpenCode のデータベースを読みます。Claude Code の記録には、各セッションの開始時点の `CLAUDE.md`・`.claude/rules/`・auto memory の `MEMORY.md` の大きさと、スキルの数が残っています。Codex の記録には、読み込んだ `AGENTS.md` が残っています。OpenCode については、セッションのフォルダから Git のルートまでの各フォルダにある `AGENTS.md`（無ければ `CLAUDE.md`）と、`~/.config/opencode/AGENTS.md` の大きさを読みます。ほかに、`$CODEX_HOME/config.toml` の最上位の `model` と `model_provider`、`$CODEX_HOME/models_cache.json` のモデル一覧、`~/.config/opencode/opencode.json` の各プロバイダの `baseURL` を読みます。`baseURL` は、ローカルのモデルかどうかを見分けるために使います。また、セッションが何度も読むファイルについては、どのプロジェクトの指示ファイルに属するかを調べます。そのために、ファイルのあるフォルダから親フォルダへ順にたどり、`.git`、`CLAUDE.md`、`AGENTS.md`（Codex と OpenCode の場合）があるかを確かめます。

### 書き込むファイル

| パス | 中身 | 書き込むとき |
|---|---|---|
| `~/.agents/sessions/` | ソケット、ログ、状態ファイル、キャッシュ | 常に |
| `~/.local/share/agent-sessions`（Windows：`%LOCALAPPDATA%\agent-sessions`） | 補助プログラム | インストール時 |
| `~/.claude/settings.json` | 4 つのフック、`statusLine` | インストール時 |
| `~/.claude/keybindings.json` | 送信キー、エディターキー | 既定から変えたとき |
| `~/.codex/config.toml` | 変えた送信キーとエディターキー、未設定ならステータスライン | Codex が有効なとき |
| `~/.config/opencode/plugins/agent-sessions.js` | 状態を伝えるプラグイン | OpenCode が有効なとき |
| `~/.config/opencode/agent-sessions-tui.jsx` | ステータスライン | OpenCode が有効なとき |
| `~/.config/opencode/tui.json` | エディターキー、送信キー、ステータスラインの項目 | OpenCode が有効なとき |
| 一時ファイル | 編集中のプロンプト | 内蔵エディターを開いているとき |
| `~/.agents/sessions/efficiency/cache/` | 「利用枠を増やす」の統計（数値と相対パスだけで、会話の文字列は入らない） | 「利用枠を増やす」を開いたとき |
| `~/.agents/sessions/efficiency/last-<タブ>.json`、`prev-<タブ>.json` | タブ（`claude`、`codex-openai`、`opencode-ollama` など）ごとの直近 2 回の解析結果（会話からの引用を伏せ字にしたものを含む） | 解析のあと |
| `~/.agents/sessions/efficiency-run/current/` | 解析用の空の作業フォルダ | 解析の最中 |
| `<vault>/.agents/sessions/sessions.json` | この vault で始めたセッション（フォルダ、エージェント）、アーカイブ、カテゴリの色、折りたたんだグループ | 常に |
| `<vault>/.claude/skills/` | `agent-sessions` と `agent-sessions-help` のスキル | Claude Code が有効なとき |
| `<vault>/.agents/skills/` | 同じスキル | Codex が有効なとき |
| `<vault>/.opencode/skills/` | 同じスキル | 有効なエージェントが OpenCode だけのとき |

- `~/.claude/settings.json` と `~/.codex/config.toml` は、書き換える前にバックアップします。`tui.json` の元の値は、`~/.agents/sessions/opencode-tui-backup.json` に保存します。
- プラグインは、自分が追加した項目を、Codex・OpenCode・スキルのファイルでは書き込んだ目印で、Claude Code ではフックのコマンドで見分けます。それ以外の項目は変更しません。
- vault を同期している場合は、`sessions.json` も一緒に同期されます。
- 補助プログラムがインストールされうるほかのフォルダは、[`docs/installation.md`](docs/installation.md#where-the-program-goes) にあります。

### 整理で送る内容

**セッション名とカテゴリを整理** で **提案する** を押すまでは、何も送りません。押すと、プラグインはエージェントを 1 回だけ起動します。プラグインの設定で有効にしているエージェントのうち、次の順で最初のものを使い、どれを使うかはダイアログに表示します。

- Claude Code：`claude -p` を Sonnet（設定で Haiku に変更可）で、ツールを使わせず、記録も残さずに実行します。
- Codex：`codex exec` を読み取り専用のサンドボックスで、ツール（シェル、Web 検索、MCP サーバー）を使わせずに実行します。
- OpenCode：`opencode run` をツールを使わせずに実行し、保存されたセッションを直後に削除します。

最大 30 件のセッション（または選んだ 1 件）について、現在の名前、フォルダ、最初のプロンプト、直近 3 つのプロンプト、最後の返答の短い抜粋を送ります。フォルダ、プロンプト、返答は、次の節の「利用枠を増やす」と同じ方法で伏せ字にします（パス、URL、メールアドレス、鍵やトークンのように見える文字列など）。ほかに、今あるカテゴリ名と、カテゴリごとのセッション数、カテゴリごとに最大 3 つのセッション名の例を送ります。もう一度提案させるときは、前回の提案とあなたのコメントも送ります。送り先はエージェントのサービスで、あなたのアカウントの利用枠を消費します。

### 「利用枠を増やす」で送る内容

**利用枠を増やす…** を開いただけでは、このマシンの中で統計を計算するだけで、何も送りません。送るのは、タブで **解析する** を押したときだけです。押すと、プラグインは、解析する会話で使われていたエージェント自身を起動します。9 つの観点を 1 回の依頼でまとめて判定し、解析する期間が 1 回の依頼に収まらないときは、より短い期間に分けて順に起動します（最大 10 回）。Codex と OpenCode では、会話で最も多く使われたプロバイダの会話だけを解析し、ほかのプロバイダとの会話は対象から外します。

- Claude Code：`claude -p` を Sonnet（設定で Opus に変更可）で、ツールを使わせず、記録も残さずに実行します。
- Codex：`codex exec` を読み取り専用のサンドボックスで、ツールを使わせず、rollout も残さずに実行します。モデルは、Codex があなたのアカウントに提供しているモデル（`$CODEX_HOME/models_cache.json`）のうち、最新の世代の Sol を使います。Sol が無ければ Terra、Terra も無ければ Luna を使います。Codex がモデルを受け付けないときは、同じ世代の次の段、1 つ前の世代、`config.toml` のモデルの順に試します。ローカルのプロバイダ（Ollama、LM Studio）では、期間の中で最も多く使われたモデルを使います。
- OpenCode：`opencode run` を、ツールを使わせずに、会話のプロバイダと、期間の中で最も多く使われたモデルで実行します。実行に使ったセッションは、終わったあとに削除します。プロバイダがこのマシンで動いている場合（Ollama、LM Studio、`baseURL` がこのマシンを指す場合）は、ローカルのモデルで解析するので、データはマシンの外に出ません。

会話を別のエージェントや別のプロバイダに送ることはありません。各タブの統計にも、タブのプロバイダのセッションだけが入ります。**解析する** の下の **詳細** を開くと、押す前に、送り先とおおよその量、依頼の回数がわかります。**詳細** の中の **送るものを見る** では、各回に送る文字列をそのまま確かめられます。

送るのは、解析する期間のすべての作業を、数値と短い抜粋にまとめたものです。伏せ字にしたセッション名とフォルダ、期間全体の合計、指示ファイルの大きさとスキルの数、統計で目立った箇所を送ります。ターンごとには、入力したプロンプト（最大 600 字）、エージェントの返答の冒頭（200 字）、ターンの数値（トークン数、種類ごとのツール呼び出し回数、読んだ・検索した・編集したパス、中断、途中の待ち時間、かかった時間、文脈の大きさ、キャッシュの再書き込み、モデル）を送ります。ツールの出力とファイルの中身は送りません。パス、URL（URL に含まれるユーザー名とパスワードも）、メールアドレス、鍵やトークンのように見える文字列は伏せ字にします。ホームフォルダとユーザー名は、どの OS の形式のパスに含まれていても、単独のフォルダ名として現れても置き換えます。1 回の依頼は最大 60,000 字です。収まらないときは期間で区切って最大 10 回に分け、それでも収まらなければプロンプトを短くし、さらに古い作業から外します。直したときに節約できるトークン数は、エージェントではなくプラグインが記録の数値から計算します。解析は、空のフォルダ `~/.agents/sessions/efficiency-run/current/` の中で動きます。作業フォルダは解析のたびに作り直し、終わると削除します。ただし Claude Code は、解析用の空のプロジェクトフォルダを `~/.claude/projects/` に 1 つ残します。統計のキャッシュには、会話の文字列は入りません。直近 2 回の結果は、伏せ字にした引用とともに、あなたが消すまで `~/.agents/sessions/efficiency/` に残ります。ローカルのモデルで解析する場合を除き、送り先はエージェントのサービスで、あなたのアカウントの利用枠を消費します。

**エージェントに直してもらう** を押しても、vault で新しいセッションを始めるだけです。依頼文は、セッションを始める前に読んで書き換えられます。Claude Code は plan モード、Codex は書き込む前に承認を求める読み取り専用のサンドボックス、OpenCode は `plan` エージェントで始めます。プラグイン自身はファイルを書きません。

### その他のアクセス

- vault のファイル一覧：内蔵エディターで `@` のパスを補完するときだけ読みます。
- クリップボード：セッション ID、解析の表、Remote Control の接続リンクをコピーするときと、macOS 以外でターミナルタブの Ctrl+Shift+C または Ctrl+Shift+V を押したときだけ使います。

## 開発

ビルド、テスト、リリース、設計については [`docs/development.md`](docs/development.md) を見てください。

## ライセンス

MIT ライセンスです（[`LICENSE`](LICENSE)）。`plugin/main.js` には xterm.js とアドオン（どちらも MIT）を同梱しています。著作権表示は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) にあります。
