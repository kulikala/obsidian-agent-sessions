**[English](README.md) | 日本語**

# Agent Sessions

**[Obsidian](https://obsidian.md) の中で [Claude Code](https://claude.com/claude-code)・[Codex](https://github.com/openai/codex)・[OpenCode](https://opencode.ai) を本物のターミナルタブとして動かし、すべてのセッションと、かかった金額を見渡せるプラグイン。**

*本物のターミナル。たくさんのセッション。全体像。*

Agent Sessions は、エージェントの CLI をターミナルで動かすのと同じ姿のまま動かし、すべてのセッションを裏で生かし続け、それぞれにいくらかかっているかを、タブのすぐ隣のセッションマネージャーと利用状況の分析で見せます。

![本物のターミナルタブで動く Claude Code のセッションと、Claude Code・Codex のセッションを開いているタブ・起動中・最近に分けて並べるサイドパネル](docs/images/overview.png)

## Agent Sessions を選ぶ理由

### たくさんのエージェントを並列に、全体を一目で

複数のエージェントを同時に走らせる人のために。タブを閉じても Obsidian を終了してもセッションは動き続け、開き直すと直前の画面が再生されます。サイドパネルと**セッションマネージャー**が、各セッションの状態（処理中・回答待ち・未読・完了）をカテゴリと名前でまとめて見せます。名前は `カテゴリ: 名前` の形で付け、**セッション名とカテゴリを整理**は、手元のエージェントで名前とカテゴリを提案します。Claude Code・Codex・OpenCode のセッションは同じ一覧に並びます。

### かかったコストが見える

利用枠を気にする人のために。5 時間・7 日の利用枠とリセットまでのカウントダウン、7 日枠のペース判定、セッション別・カテゴリ別のコスト、任意のセッションのターンごとの内訳、セッションがいつ動いていたかの稼働カレンダー。すべて各エージェント自身の transcript から手元で算出します。

![セッションマネージャー：カテゴリ別にまとめたセッションと枠ごとのコスト、その下に 5 時間／7 日の利用分析](docs/images/manager.png)

### 本物の CLI を、本物のターミナルで

すでにエージェントの CLI を使い込んでいる人のために。Claude Code・Codex・OpenCode は PTY に支えられた本物のターミナルタブ（TTY）で動くので、スラッシュコマンド・プランモード・フック・スキル・MCP はエージェント本来のものです。チャット画面を作り直していないため、エージェントに新機能が入ったその日から Agent Sessions でも使えます。

### ハードに使っても、始めやすい

ようこそガイドが、図つきで最初のセッションまで案内し、操作するたびに確かめます。長いプロンプトにはターミナルの下に内蔵エディタ（Ctrl+G）が開き、`@` によるファイル補完が効きます。実行中の Claude Code セッションのモデルとエフォートはメニューから切り替えられ、設定を反映したいときはセッションを再起動でき、長くなった一覧はダイアログ 1 つで整理できます。タブのアイコン・色・通知が、どのセッションが待っているかを教えます。

![承認を待つ Codex のセッションと、別タブの Claude Code のセッションが応答を終えたことを知らせる通知](docs/images/codex.png)

## 向いている人

**向いている人**：

- すでに Claude Code・Codex・OpenCode をターミナルで使っていて、ノートのすぐ隣に置きたい。
- 複数のセッションを同時に走らせ、探して、名前を付けて、まとめたい。
- Obsidian を離れずに、セッションごとの利用量とコストを見たい。
- タブを閉じても Obsidian を終了しても生き残るセッションが欲しい。

**向かない人**：

- 開いているノートをその場で書き換えさせる AI チャット画面が欲しい。それにはチャット型のプラグインが合う。Agent Sessions はエージェントの CLI そのものを動かすためのもの。
- モバイル版の Obsidian で使いたい（デスクトップ版のみ）。
- Windows 版 Obsidian で、WSL の中のエージェントを使いたい（[対応環境](#対応環境)を参照）。

## プライバシーと安全性

- プラグイン自身はネットワークに接続しない。通信するのは、同じマシン上の自分の裏方プロセスとだけ（ローカルのソケット）。唯一の例外は、ようこそガイドを開いているあいだ GitHub から読み込むガイドの図（設定でオフにできる）。起動するエージェントは、利用者自身のアカウントでそれぞれのサービスに接続する。
- テレメトリ・アカウント・広告・課金は無い。MIT ライセンス。
- エージェントの設定は、バックアップを取ってから、プラグインが足した行だけを書き換える。`agent-sessions setup --remove` がその行だけを取り除き、**設定 → agent-sessions プログラム → 削除** でも同じことができる。
- インストーラは、何かを書き込む前に、書き込み先・動かす Python・Claude Code の設定への変更を見せる。
- プログラムは Python の標準ライブラリだけで、読めるソースのままプラグインに同梱される。コードをダウンロードすることは無い。
- エージェントには、ターミナルで動かすときと同じ権限がある。ターミナルで動くためである。
- エージェントにテキストを送る機能は**セッション名とカテゴリを整理**だけで、ボタンを押したときに限る。

読み書きするファイルと起動するプログラムはすべて[開示事項](#開示事項)に並べてある。

## 動作要件（早見）

- **Obsidian** 1.8.7 以降、デスクトップ版のみ。
- **macOS・Linux・Windows**（Windows は Claude Code のみ。WSL の構成は[対応環境](#対応環境)を参照）。
- **Python 3.9 以降**、標準ライブラリのみ。
- **エージェントの CLI を 1 つ以上**：Claude Code・Codex・OpenCode のいずれか。

## インストール

1. Obsidian の **設定 → コミュニティプラグイン → 閲覧** で **Agent Sessions** を探し、インストールして有効にする。
2. サイドパネル（リボンの **Agent Sessions** アイコン）を開く。初回はようこそガイドが開き、残りを案内する：Python とエージェントを確認し、書き込む内容を見せたうえで、`agent-sessions` プログラムをワンクリックで入れる。ガイドはいつ閉じてもよく、コマンドパレットから再開できる。

ソースからの導入と、プログラムの置き場所は [`docs/installation.md`](docs/installation.md)（英語）にある。

## 対応環境

| 構成 | 対応 | 動作確認 |
|---|---|---|
| macOS | 対応 | macOS 26.6（Python 3.14）でスモークテスト（全 15 ステップ）に合格 |
| Linux（Ubuntu Desktop） | 対応 | Ubuntu 24.04（カーネル 6.8、Python 3.12）でスモークテストに合格 |
| Windows ①：Windows 版 Obsidian ＋ Windows 版 Claude Code | 対応（Claude Code のみ） | Windows 11 ビルド 26300（Python 3.13）でスモークテストに合格 |
| Windows ②：Windows 版 Obsidian ＋ WSL1 の Claude Code | 非対応 | — |
| Windows ③：Windows 版 Obsidian ＋ WSL2 の Claude Code | 非対応 | — |
| Windows ④：WSLg 上の Linux 版 Obsidian ＋ WSL2 の Claude Code | 対応 | 対応。未検証——手順は [`docs/testing.md`](docs/testing.md#4-platform--checks) |

スモークテストは 2026-10-04 に、arm64 の仮想マシン上で Obsidian 1.13.7 と偽のエージェントを使って実施した（[`docs/testing.md`](docs/testing.md)）。Windows 10 1809 以降にもデーモンが使う ConPTY はあるが、未確認。Windows ① では、Codex と OpenCode は設定に「Windows ではまだ使えません」と出て、オフのまま。

プラグイン・プログラム・エージェントは、同じ OS の上で動いている必要がある（[`docs/principles.md`](docs/principles.md#4-supported-platforms-are-the-ones-where-agent-and-plugin-share-an-os)）：

- **②** WSL1 は Windows と `localhost` を共有するが、エージェントは WSL の中で動くため、フック・ステータスライン・transcript・プロセスは Linux 側にあり、プラグインはセッションを起動することも、観測することも、つなぎ直すこともできない。
- **③** 同じ理由で非対応。さらに WSL2 の既定の NAT ネットワークでは、WSL から Windows の `127.0.0.1` に届かないため、内蔵エディタの往復が失敗する（ミラーモードは未検証）。
- **WSL を使う人へ**：WSLg で Obsidian 自体を WSL の中で動かす（④）。両側とも Linux になる。

### 動作要件

| | |
|---|---|
| **Obsidian** | デスクトップ版のみ（`isDesktopOnly`。プロセスの起動と ローカルのソケットを使うため——どちらもモバイル版・Web 版では使えない）、バージョン 1.8.7 以降（`minAppVersion`）。 |
| **Python** | 3.9 以降、標準ライブラリのみ。macOS：Command Line Tools の `python3`（`xcode-select --install`）・python.org・Homebrew のいずれか。Linux：ディストリビューションの `python3`。 Windows：`py` ランチャー・python.org のインストール・`PATH` 上の `python.exe` のいずれか（Microsoft Store の空の `python.exe` エイリアスは使わない）。Python が無ければ、インストール画面から WinGet で入れられる。 |
| **Claude Code／Codex／OpenCode（いずれか 1 つ以上）** | いずれか 1 つ以上をインストール済みで、`PATH` にあるか、プラグインの「エージェント」設定でパスを指定する（初回起動時に自動検出）。Claude Code：本プラグインは Claude Code のフック（`Stop`・`SessionEnd`・`SessionStart`（matcher `compact`）・`UserPromptSubmit`）と `statusLine`、そして送信キーの設定を既定から変えた場合のみ `keybindings.json` に依存する。Codex：hooks／statusLine 相当はまだ使っていない。実機での確認はまだ済んでいない（[`docs/design.md`](docs/design.md) §7.7・§25 参照）。OpenCode：セッションは SQLite のデータベースから読み、busy／idle／waiting は OpenCode を有効にしたときにプログラムが入れる小さな OpenCode プラグインが伝える。`ollama launch opencode` で起動するには [Ollama](https://ollama.com) も必要。 Windows では Claude Code のみ。フックと `statusLine` は、Git Bash があればそれ、無ければ PowerShell で Claude Code が実行する（Git for Windows は必須ではない）。Claude Code が見つからないときは、インストール画面から WinGet で入れられる。 |
| **Node.js／npm** | ソースからプラグインをビルドする場合のみ必要（[開発](#開発)を参照）。CI では Node.js 20 でビルドしている。 |

## 機能の詳細

各機能の詳しい説明は [`docs/usage.md`](docs/usage.md)（英語）にある。

- **セッションとタブ**：1 セッション＝1 Obsidian タブ、実体は PTY（Windows では ConPTY。xterm.js）。Claude Code・Codex・OpenCode のセッションを 1 つの一覧に混在させる。エージェントは自動検出し、OpenCode は `ollama launch opencode` 経由でも起動できてローカルモデルを使える。状態ごとにアイコン・色・動きを出し、別タブのセッションが終わったとき、または回答を待っているときは通知で知らせる。出力中のファイルパスは vault 内に実在すればクリックできるリンクになる。
- **サイドパネルとセッションマネージャー**：右サイドバーに「開いているタブ」「起動中」「最近」の一覧、詳細欄、リセットまでのカウントダウン付きの 5 時間／7 日のレート制限を出す。セッションマネージャーは、カテゴリでまとめたセッションを並べ替えられる表で見せ、状態の絞り込みと、その下に利用状況の分析パネルを持つ。
- **命名・カテゴリ・整理**：`カテゴリ: 名前` の形で名付けると、カテゴリごとに固定の色が付き、専用のグループになる。**セッション名とカテゴリを整理**は、最近のセッションの最新の指示と応答から名前とカテゴリを提案する。使うのは手元のエージェント（Claude Code、なければ Codex、OpenCode の順）。提案を確かめてから適用でき、適用を押すまで何も変わらない。セッションの抜粋がそのエージェントへ送られる——[開示事項](#開示事項)を参照。
- **再起動・モデル・エフォート**：**セッションを再起動**は、エージェントを終了し、同じ会話を同じタブで再開する。設定・フック・スキル・環境変数の変更を反映したいときに使う。**モデルを変更…**は、`/model`・`/effort` を打たずに、実行中の Claude Code セッションのモデルとエフォートを切り替える。
- **内蔵エディタ**：Ctrl+G で、ターミナルの下に分割された編集領域が開き、今のプロンプトを編集できる。`@` によるファイル補完・自動保存・ネイティブのペースト／IME／Undo に対応し、編集中もターミナルの出力は見えたまま。Claude Code のプロンプトでは、バーでモデルとエフォートを切り替えられる。
- **稼働カレンダー**：「セッション」「週」「日」を切り替えて稼働を一望できる（セッションは、使用量の上限のリセットに揃えた 7 日間）。日ごと・エージェントごとのレーンに、セッションが動いていた時間帯を色付きのブロックで描く（transcript の記録時刻から算出）。ブロックにホバーすると時間帯と名前、クリックするとそのセッションの詳細を表示する。
- **利用状況と枠**：エージェントごとのアカウント全体の 5 時間／7 日の利用枠を、カウントダウンと 7 日枠のペース判定つきで見せる。セッション別・カテゴリ別のコストと、Markdown としてコピーできるターンごとの**セッション解析**もある。すべて各エージェント自身の transcript から算出する。
- **エージェント用スキル**：プログラムと一緒に 2 つのスキルが vault に入る。`agent-sessions` は、vault のエージェントから利用状況の取得・他のセッションの一覧、頼んだときだけ新しいセッションの開始を行えるようにする。`agent-sessions-help` は、プラグインの使い方を質問した言語で答える。
- **Remote Control**：Remote Control つきで始めた Claude Code セッションの名前を変えると、その Remote Control のセッション（claude.ai と Claude アプリ）の名前も変わる。
- **ようこそガイド**：初回インストール時と、アップデート後に新しい版で見せるものがあるときに開く。プログラムとエージェントの準備のあと、本物のセッションの開始・タブの切り替え・名前の変更・内蔵エディタの使用を、操作するたびに確かめながら案内する。
- **CLI と TUI**：Obsidian の外やスクリプトから使える単体の `agent-sessions` コマンド。

![稼働カレンダー。1 週間のセッションを色付きのブロックで描き、日ごとにエージェント別のレーンに分ける。エージェントごとの稼働時間と同時数も並ぶ](docs/images/calendar.png)

![セッション名とカテゴリを整理するダイアログ。セッションごとに提案されたカテゴリと名前が並ぶ](docs/images/organize.png)

![ようこそガイド](docs/images/welcome.png)

セッションの状態・設定・CLI・まれなトラブルシューティングは [`docs/usage.md`](docs/usage.md)（英語）にある。

## トラブルシューティング

- **「agent-sessions が見つからない」と出る**：プラグインは入っているが、`agent-sessions` プログラムが入っていない。サイドパネルの **agent-sessions をインストール** を押す（[インストール](#インストール)）。`~/bin` 以外に置く場合は、プラグインの設定でパスを指定する。
- **Windows 版 Obsidian で WSL の Claude Code を使う**：非対応（[対応環境](#対応環境)の構成 ②・③）。WSLg で Obsidian 自体を WSL の中で動かす（④）。
- フックの `node: not found`、Windows での Python や Claude Code の導入など：[`docs/usage.md`](docs/usage.md#more-troubleshooting)（英語）。

## 開示事項

- **プラグイン自身もプログラムもネットワークを使わない。ただしようこそガイドの図だけは例外。** プラグインが通信するのは、同じマシン上の自分のデーモンとだけ（Unix ソケット。パーミッションは 0600。Windows では `127.0.0.1` のループバック TCP でポートは毎回ランダム、クライアントは最初に秘密のトークンを送る必要があり、違えば接続は閉じられる）。唯一の例外として、ようこそガイドを開いているあいだだけ、プラグインのバージョンに固定した図を GitHub（`raw.githubusercontent.com`）から読み込みます。取得するのは画像だけで、あなたのデータは送りません。GitHub には IP アドレスと、どの図を取得したかが見えます（リファラは送りません）。**設定 → ガイドの図を GitHub から読み込む** をオフにすると止まり、ガイドは図の代わりに説明文を出します。プラグインが起動する Claude Code・Codex・OpenCode は、利用者自身のアカウントでそれぞれのサービスに接続する。
- **Windows では、さらにいくつかのプログラムを起動する。** Python とエージェントのほかに、`reg.exe`（レジストリから `PATH` を読む。Obsidian の起動中に入れたプログラムを再起動なしで見つけるため）と `py.exe`（Python を探す）を、いずれもコンソール窓を出さずに起動し、`winget.exe` は、インストール画面で Python や Claude Code のインストールボタンを押したときだけ起動する。待ち受けるのは `127.0.0.1` だけ。
- **ローカルのプログラムを起動する。** `agent-sessions` を利用者の Python で動かす（プラグインに読めるソースとして同梱され、インストールを押したときにだけ書き出す）。インストール済みの Claude Code・Codex・OpenCode の CLI（または `ollama launch opencode`）を起動し、ターミナルと同じ `PATH` で動くよう、ログインシェルの環境変数を読む。コードをダウンロードすることは無い。
- **vault の外のファイルを読み書きする。** エージェントと `agent-sessions` が状態をそこに置くため：
  - セッション一覧と使用量のために、Claude Code の `~/.claude/projects/`・`~/.claude/sessions/`・`~/.claude/settings.json` 、Codex の `~/.codex/`（または `$CODEX_HOME`）、OpenCode のデータベース `~/.local/share/opencode/opencode.db`（`$XDG_DATA_HOME` 配下の場合もある。読み取り専用で開く）を読む。
  - `~/.agents/sessions/`（デーモンのソケット——Windows ではループバックのポートとトークンを書いたエンドポイントファイル——・ログ・状態のスナップショット・キャッシュ）に書く。
  - プログラムのインストールで、ホームフォルダ内のフォルダに書き出す（[インストールの詳細](docs/installation.md)を参照）。インストールと `install.sh` は `~/.claude/settings.json` にフックと `statusLine` を足す（先にバックアップを残す）。送信キーまたはエディタキーの設定を変えると `~/.claude/keybindings.json` に書く。
  - Codex を有効にしている場合、`~/.codex/config.toml` に送信キーのキーマップ、エディタキーの行（Ctrl+G 以外のときだけ `open_external_editor`）、既定の `[tui].status_line` を足す（先にバックアップを残す。足した行には印が付き、`agent-sessions setup --remove` はその行だけを取り除く）。
  - OpenCode を有効にしている場合、ステータス用プラグイン `~/.config/opencode/plugins/agent-sessions.js`（`$XDG_CONFIG_HOME` 配下の場合もある）を書き、そのプラグインがセッションごとの状態ファイルを `~/.agents/sessions/opencode/` に書く。プラグインファイルの先頭には印の行があり、印のあるファイルだけを上書きする。「設定 → agent-sessions プログラム → 削除」または `agent-sessions setup --remove` で取り除かれ、設定で OpenCode を無効にしたときにも取り除かれる。OpenCode を有効にしているとき、インストールのダイアログにこのファイルが並び、プログラムの通常の更新は、すでにあるプラグインファイルを更新するだけで新しく作ることはない。これと並べて、OpenCode のステータスライン `~/.config/opencode/agent-sessions-tui.jsx`（印の行も、インストール・更新・削除も同じ）を書く。JSX の小さなファイルで、`opencode` が読み込むときに自分でコンパイルする。OpenCode の画面上の状態（動作中か待機か、許可待ちか）から、セッション画面の最下行を 1 行描き、プラグインが起動したセッションでは `~/.agents/sessions/ui.json` の送信キーの記号も出す。ほかは何も読み書きしない。
  - OpenCode を有効にしているとき、OpenCode の `~/.config/opencode/tui.json`（`$XDG_CONFIG_HOME` 配下の場合もある）の `keybinds.editor_open`（エディタキー。OpenCode 本来のキーは Ctrl+X, E）を設定し、送信キーが Enter 以外なら `keybinds.input_submit` と `keybinds.input_newline` も設定して Return が改行になるようにする。ステータスライン `"./agent-sessions-tui.jsx"` も `plugin` の一覧に足す（OpenCode はこの一覧からしかこの種のプラグインを読み込まない）。ほかのキーは触らず、通常の JSON でないファイルは書き換えない。元の値は `~/.agents/sessions/opencode-tui-backup.json` に控え、OpenCode を無効にしたとき・削除したときに元へ戻す（送信キーの分は Enter に戻したときにも戻す。`agent-sessions setup --remove` も同じ）。
  - プログラムをインストール・更新するたびに、ホームディレクトリではなく Vault 自身のスキルフォルダに `agent-sessions` と `agent-sessions-help` の 2 つのスキル（それぞれ `SKILL.md` のフォルダで、後者は隣に `reference.md` も置く）を書く（プログラムが無いあいだは Vault に何も書かない）（以前の版が入れた 3 つのスキルは、印があれば取り除く）：Claude Code は `<vault>/.claude/skills/`、Codex は `<vault>/.agents/skills/`、OpenCode は他の 2 つが要らないとき（OpenCode だけが有効なとき）に限り `<vault>/.opencode/skills/`（OpenCode は前の 2 つも読む）。各ファイルには `agent-sessions:managed` の印があり、印のないファイルは上書きも削除もしない。本文には有効なエージェントだけが載り、プラグインの更新、ランチャーや有効なエージェントの変更のあとに、すべてのコピーが書き直され、エージェントを無効にする・「削除」を押すと取り除かれ、インストーラのダイアログにも書き込み先のフォルダが出る。Vault 以外のフォルダで起動したエージェントには見えない；
  - 内蔵エディタは、エージェントが `$VISUAL` に渡す一時ファイルを編集する。
- **「セッション名とカテゴリを整理」はセッションの抜粋をエージェントの CLI に送る。** このダイアログで**提案する**（または**チェックを外した行だけ再提案**）を押すと、インストール済みのエージェントを 1 回ヘッドレスで実行する（実行場所は `~/.agents/sessions/organize/`）。Claude Code が有効ならそれを使い（`claude -p --model haiku`。ツール・MCP サーバー・フック・スキルは使わず、トランスクリプトも残さない）、無効なら Codex（`codex exec`。読み取り専用のサンドボックスで、セッションファイルは残さない）か OpenCode（`opencode run`。保存されたセッションは直後に削除する）を使う。どのエージェントかは、ボタンを押す前にダイアログに表示される。プロンプトには、最大 30 件のセッションについてフォルダ名・最初の指示・最新の指示と応答の短い抜粋と、既存のカテゴリ名が入る（再提案では、前の提案と利用者のコメントも入る）。送信先は利用者自身のアカウントで、そのエージェントの利用枠を消費する。ボタンを押すまで何も送らず、適用を押すまで名前は変わらない。
- **一覧に出さないセッション。** OpenCode のサブエージェントのセッションと、`opencode run` で始めたセッションは一覧に出さない。
- **vault のファイル一覧を読む**のは、内蔵エディタで `@` のファイルパスを補完するときだけ。
- **クリップボードを使う**のは、操作したときだけ：セッション ID や解析表のコピーと、ターミナルタブでの Ctrl+Shift+C／Ctrl+Shift+V（Linux のキー割当）。
- **独自のアカウント・支払い・広告・テレメトリは無い。** すべて MIT ライセンスのオープンソース。


## アンインストール

先に **設定 → agent-sessions プログラム → 削除** でプログラムを取り除く。デーモンを止め（動いているセッションは終わる）、エージェントの設定に足したフック・ステータスライン・キー割当・行を取り除き、vault のエージェント用スキルを消し、フォルダを削除する。そのあと Obsidian のコミュニティプラグインで **Agent Sessions** を無効にして削除する。clone から入れた場合は [`docs/installation.md`](docs/installation.md#uninstall)（英語）を参照。

## 仕組み

小さなデーモン（プラグインが必要に応じて起動する）が各セッションの PTY をローカルのソケットで保持するので、タブが無くてもセッションは動き続ける。プラグインは端末の入出力ではデーモンと直接やり取りし、それ以外（transcript の走査・利用量とコスト・セッションの木）は `agent-sessions json …` に任せるので、プラグインと CLI は同じデータを見る。Claude Code 自身のファイルは読むだけで書かない。[`docs/principles.md`](docs/principles.md)・[`docs/design.md`](docs/design.md)・[`docs/architecture.md`](docs/architecture.md)（英語）を参照。

## 開発

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # プラグイン（vitest・tsc・esbuild）
cd .. && python3 -W error -m unittest discover -s tests -t .   # Python（標準ライブラリのみ）
```

ビルドとテストの詳細、スクリーンショットの撮り方、言語の追加、リリースの手順は [`docs/development.md`](docs/development.md)（英語）、テストは [`docs/testing.md`](docs/testing.md)（英語）にある。

## ライセンス

MIT。全文は [`LICENSE`](LICENSE)。`plugin/main.js` には xterm.js とそのアドオン（同じく MIT）が同梱されており、そのライセンス全文と著作権表示は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) にある。
