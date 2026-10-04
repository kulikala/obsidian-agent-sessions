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

ソースからの導入は[インストールの詳細](#インストールの詳細)にある。

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

### セッションとタブ

- 1 セッション＝1 Obsidian タブ、実体は PTY（Windows では ConPTY。xterm.js）。タブを閉じても Obsidian を終了してもセッションは動き続け、開き直すと直前の画面が再生される。
- Claude Code・Codex・OpenCode のセッションを同じ一覧に混在させ、並べ替え・絞り込みも一緒に行う。初回起動時にエージェントを自動検出し、好きなものを有効化でき、エージェントごとにパスと環境変数を設定できる。複数を有効にしているときは「新規セッション」でどれを起動するか選べる。OpenCode は `ollama launch opencode` 経由でも起動でき、ローカルモデルを使える。
- 状態ごとにアイコン・色・動きを出す（[セッションの状態](#セッションの状態)を参照）。ターミナルタブ・サイドパネル・マネージャーで表示は揃う。別タブのセッションが終わったとき、または回答を待っているときは通知で知らせる。
- 出力中のファイルパスは vault 内に実在すればクリックできるリンクになる。タブのヘッダには、現在のノートを `@path` として挿入するボタンと、前の指示・次の指示・最後の応答へのジャンプボタンがある。
- `Cmd +`／`Cmd −`／`Cmd 0`（macOS）または `Ctrl+Shift+=`／`Ctrl+Shift+-`／`Ctrl+Shift+0`（それ以外）でそのタブのフォントサイズを変える。macOS 以外では `Ctrl+Shift+C`／`Ctrl+Shift+V` でコピー・貼り付け、`Ctrl+Shift+W` でタブを閉じ、`Ctrl+Shift+P` でコマンドパレットを開く。素の `Ctrl+<キー>` の組み合わせは、Obsidian ではなく常にエージェントへ届く。

### サイドパネルとセッションマネージャー

- **サイドパネル**（右サイドバー）は「開いているタブ」「起動中」（デーモンには居るがタブが無い）「最近」に分かれ、各行は状態の印・カテゴリのチップ・名前を出す。詳細欄にはモデル・エフォート・接続状況・コンテキスト使用率・合計トークンとコスト・最後の指示と応答が出る。レート制限の欄には、有効なエージェントごとに 5 時間／7 日のバーとリセットまでのカウントダウンが出る。
- **セッションマネージャー**は新しいタブの既定の画面。カテゴリでまとめたセッションの木（「その他」区分とアーカイブを含む）の下に、折畳・リサイズ可能な利用状況の分析パネルがある：5 時間／7 日のカード、7 日枠のペース判定（「順調」か「このままでは ‑‑ に使い切る」）、カテゴリ別のコストの帯。有効なエージェントが複数あれば、エージェントごとの節に分かれる。並べ替えられる表には、最終更新・モデル・エフォート・5h／7d のコスト・フォルダが並ぶ。開いてもセッションは始まらない。ツールバーには状態の絞り込み（すべて／入力待ち／レビュー待ち／実行中／完了／アーカイブ済み）がある。
- 行メニュー（⋯／右クリック）から、名前の変更とカテゴリへの移動・モデルの変更・圧縮（`/compact`）・再起動・セッション解析・ID のコピー・アーカイブ・セッションの終了ができる。

### 命名・カテゴリ・整理

`カテゴリ: 名前` の形で名付けると、カテゴリごとに固定の色が付き、マネージャーで専用のグループになる。名前の変更ダイアログは 1 つの入力欄で、既存カテゴリのドロップダウンと、新しいカテゴリの自由入力の両方に対応する。

**セッション名とカテゴリを整理**（サイドパネル・マネージャーの ⋯ メニュー）は、直近のアーカイブしていないセッション（最大 30 件。既定では名前かカテゴリが未設定のものだけ）について、最新の指示と応答から `カテゴリ: 名前` を提案する。既存のカテゴリは、合うものがあれば再利用される。使うのは手元のエージェント（Claude Code、なければ Codex、OpenCode の順。ダイアログに表示される）。気に入らない行はチェックを外してコメントを書き、**チェックを外した行だけ再提案**を押す。**選択した提案を適用**は行メニューと同じ経路で名前を変え、押すまで何も変わらない。セッションの抜粋がそのエージェントへ送られる——[開示事項](#開示事項)を参照。

![セッション名とカテゴリを整理するダイアログ。セッションごとに提案されたカテゴリと名前が並ぶ](docs/images/organize.png)

### 再起動・モデル・エフォート

- **セッションを再起動**（行メニュー。起動中のセッションのみで、処理中なら先に確認する）は、エージェントを終了し、同じ会話を同じタブで再開する。設定・フック・スキル・環境変数の変更を反映したいときに使う。
- **モデルを変更…**（行メニュー。起動中の Claude Code セッション）で、モデル（Opus・Sonnet・Haiku などの別名か、完全なモデル ID）とエフォートを選ぶと、変えたものについて `/model` と `/effort` を送る。`/model` は新しいセッションの Claude Code の既定にもなる。

### 内蔵エディタ

セッション中に Ctrl+G を押すと、ターミナルの下に分割された編集領域が開き、今のプロンプト（または `/memory`・`/keybindings` 等）を編集できる。`@` によるファイル補完・自動保存・ネイティブのペースト／IME／Undo に対応し、編集中もターミナルの出力は見えたまま。Claude Code のプロンプトでは、バーにモデルとエフォートのドロップダウン（現在の値が入る）があり、変えると**送信**が先に `/model`・`/effort` で反映してからプロンプトを送る。Esc で送らずに入力へ戻る。キーは**エディタキー**の設定（Ctrl+G・Ctrl+Q・Option／Alt+G）で、各エージェントがそのキーでエディタを開くよう設定される。

### 稼働カレンダー

1 週間（月〜日・ローカル時刻）の稼働を一望できる。日ごと・エージェントごとのレーンに、セッションが動いていた時間帯を色付きのブロックで描く（transcript の記録時刻から算出。30 分以上の空きで区切る）。重なるセッションは横に並ぶ。題名での絞り込みと、エージェントごとの稼働時間・セッション数・同時最大数のカードを備える。ブロックにホバーすると時間帯と名前、クリックするとそのセッションを開く。セッションマネージャーのツールバー、サイドパネルの ⋯ メニュー、コマンドパレットから開ける。

![稼働カレンダー。1 週間のセッションを色付きのブロックで描き、日ごとにエージェント別のレーンに分ける。エージェントごとの稼働時間と同時数も並ぶ](docs/images/calendar.png)

### 利用状況と枠

- エージェントごとのアカウント全体の 5 時間／7 日の利用枠を、リセットまでのカウントダウンと 7 日枠のペース判定つきで見せる。
- **セッション解析**（行メニュー）：コスト・トークン・ターン数・期間のカード、入力／出力／ツール使用のバー、ターン表。行をクリックして区間を選び、結果を Markdown としてコピーできる。
- どちらも各エージェント自身の transcript から算出する。

### エージェント用スキル

プログラムと一緒に、2 つのスキルが vault の中にだけ入る。

- `agent-sessions`：vault で起動した Claude Code・Codex・OpenCode のセッションから、5 時間／7 日の利用枠やセッションのトークン・コストの取得、他のセッションの状態と直近のやり取りの一覧、そして頼んだときだけ新しいセッションの開始（フォルダ・名前・有効なエージェントを指定でき、Claude Code は Remote Control も指定可）を行えるようにする。
- `agent-sessions-help`：プラグインの使い方（機能の場所、名前の変更・整理・再起動、内蔵エディタ、対応環境など）を、質問した言語で、プラグイン自身のメニューと設定の名前に合わせた資料から答える。

### Remote Control

Remote Control つきで始めた Claude Code セッションは、Agent Sessions で名前を変えると、起動中のセッションへ `/rename` を送るので、Remote Control のセッション（claude.ai と Claude アプリ）の名前も変わる。

### セッションの状態

ターミナルタブ・サイドパネルの行・マネージャーの行は、セッションの状態について同じアイコン・色・動きを共有する：接続中、処理中（応答を生成中）、シェルコマンド実行中、回答待ち（質問または許可プロンプト）、未読（応答が終わったがまだタブを前面にしていない）、編集中（内蔵エディタが開いている）、待機、未接続（タブはあるがまだ接続していない）、compact 済み（`/compact` の直後で文脈がリセットされている）、終了、エラー。動きのある状態は `prefers-reduced-motion` を尊重する。

これらはさらに、Claude 本体のアプリがセッションを絞り込む際と同じ区分にまとめられる——入力待ち・レビュー待ち・実行中・完了、それぞれ対応するアイコンと色を揃え、加えてアーカイブ済みの区分もある。セッションマネージャーのツールバーには、この同じ6区分（すべて／入力待ち／レビュー待ち／実行中／完了／アーカイブ済み）で絞り込むメニューがある。

状態マークの横の小さなアイコンで、そのセッションがどのエージェント（Claude Code／Codex／OpenCode）かが分かる——各エージェント自身のマーク（単色、他のアイコンと揃えた色）で、色付きのブランドロゴではない。

### ようこそガイド

初回インストール時に自動で開きます。アップデート後は、新しい版で見せるものがあるときだけ開きます。言語の選択に始まり、プログラムとエージェントの準備（エージェントが無いときは、公式の導入コマンドをコピーできるように示し、公式ドキュメントへのリンクと**検出し直す**ボタンを出します）、本物のセッションの開始、タブの切り替え、名前の変更、内蔵エディタからの送信までを、操作するたびに印を付けながら案内します（**飛ばす**で段を飛ばせます）。最後に再起動・整理・セッションマネージャーを紹介します。閉じても位置は保たれ、**ようこそガイドの続きから**（コマンドパレットか設定）で再開、**ようこそガイドを最初から始める**で最初からやり直せます。図はガイドを開いているあいだ GitHub から読み込みます（[開示事項](#開示事項)参照）。設定の**ガイドの図を GitHub から読み込む**でオフにでき、**アップデート後にようこそガイドを表示**で更新後の自動表示を止められます。

![ようこそガイド](docs/images/welcome.png)

### そのほか

- **OpenCode のステータスライン**：OpenCode のセッション画面の最下行に、OpenCode 自身の画面に無いもの——送信キーの記号と、動作中／待機／許可待ちの別——を出す。OpenCode を有効にすると入り、設定は不要。
- **日英 2 言語の UI**：「自動」（Obsidian の言語設定に合わせる）・日本語・English を選べる。

## 設定

フォント名とサイズ、余白（ゆったり／小さめ／なし）、送信キー、エディタキー、最近の件数、指示待ちの通知、エージェント（Claude Code／Codex／OpenCode——有効化・パス・環境変数。OpenCode はさらに、直接起動か `ollama launch opencode` 経由かと、使う Ollama のモデル（`ollama list` から選ぶか直接入力））、`agent-sessions` のパス、ターミナルのスクロールバック行数、内蔵エディタの高さ、表示言語（自動／日本語／English）、アップデート後にようこそガイドを表示するか、サイドパネルの詳細欄とマネージャーの分析パネルの保存された高さ。

## インストールの詳細

プラグインは、セッションを保持しエージェントの記録を読む小さな Python プログラム `agent-sessions` を使って動く。プログラムは読めるソースのままプラグインに同梱されており、ワンクリックで入る。Python 3.9 以降はあらかじめ入っている必要がある。

### プログラムの置き場所

置き場所は、`$XDG_DATA_HOME/agent-sessions`・`~/.local/share/agent-sessions`・`~/.agents/sessions/app` のうち最初に使えるもの。空白やシェルの特殊文字を含むパス（フックのコマンドと `$VISUAL` に入るため）、vault の中、書き込めない場所は飛ばす。Python は、ログインシェルが `python3` として見つけるもの、無ければ `/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin` の順に探す（macOS の `/usr/bin` は Command Line Tools が入っている場合だけ使い、仮の入口のインストール画面を出さない）。

Windows では、プログラムは `%LOCALAPPDATA%\agent-sessions`（無ければ `~\.agents\sessions\app`）に入る。ランチャーは `bin\agent-sessions.cmd`（`PYTHONUTF8=1` を設定し、インストール時に見つけた Python で動かす）、エディタ用の中継は `bin\agent-sessions-code.cmd`。プラグイン自身は `python <スクリプト>` を直接実行し、コンソール窓は出ない。パスに空白は含められるが、`"`・`%`・`!`・`^`・`&`・`|`・`<`・`>`・`` ` ``・`$`・`;` は含められない。Python は `py` ランチャー（`py -3`）、python.org のフォルダ（`%LOCALAPPDATA%\Programs\Python\Python3xx`・`%ProgramFiles%\Python3xx`）、`PATH` 上の `python.exe` の順に探す。`PATH` はレジストリ（ユーザーとマシン）から読み直し、WinGet の `Links` フォルダ・`~\.local\bin`・`%APPDATA%\npm` も足す。Python や Claude Code が見つからないときは、インストール画面に **WinGet で Python をインストール**／**WinGet で Claude Code をインストール** が出る（`winget install --exact --id Python.Python.3.13`、または `Anthropic.ClaudeCode`、`--scope user --silent`。ユーザー単位で管理者権限の確認は出ず、ボタンを押したときだけ実行する）。WinGet 自体が無いときは、Microsoft Store の「アプリ インストーラー」の更新を案内する。出力は一貫して UTF-8（日本語版 Windows の既定は cp932）。

プラグインを更新するとプログラムも更新される。入れ直し・削除は **設定 → agent-sessions プログラム** から。

### clone から入れる

自分のターミナルで `agent-sessions` コマンド（TUI・スクリプト）を使う場合や、チェックアウトからそのまま動かす場合は、このリポジトリから入れる——`~/bin/agent-sessions` があれば、プラグインは常にそちらを使う：

```sh
git clone https://github.com/kulikala/obsidian-agent-sessions.git
cd obsidian-agent-sessions
./scripts/install.sh
```

プラグイン本体もソースから入れる場合は、ビルドしてから `install.sh` に vault を渡す。この clone の `plugin/` も vault にリンクされる（その後、「コミュニティプラグイン」で **Agent Sessions** を有効にする）：

```sh
(cd plugin && npm install && npm run build)
./scripts/install.sh /path/to/your/vault   # または AGENT_SESSIONS_VAULT=/path/to/your/vault ./scripts/install.sh
```

`install.sh` が行うこと：

- `bin/agent-sessions`・`bin/agent-sessions-code` を `~/bin` に symlink する。
- vault を渡した場合、`plugin/` を `<vault>/.obsidian/plugins/agent-sessions` に symlink する。
- `agent-sessions setup` を実行する。これは **`~/.claude/settings.json` を書き換える**（先に `settings.json.bak-<時刻>` としてバックアップを残す）：`Stop`・`SessionEnd`・`SessionStart`（matcher `compact`）・`UserPromptSubmit` の各フックを `agent-sessions hook` に向けて追加・更新し、`statusLine` を `agent-sessions status` に設定する。自分が付けたと分かるエントリだけを触り、他のフックはそのまま残す。

**送信キー**の設定を既定（Enter）以外に変えると、Claude Code 自身のキー割当と揃えるため、プラグインは `~/.claude/keybindings.json`（`Chat` コンテキスト）にも書き込む——これは Obsidian の外で起動した Claude Code を含め、Claude Code 全体に効く（ただし、選んだキーが確実に働くのはこのプラグイン自身のターミナルタブだけで、他のターミナルアプリがそのキーを素の Enter と区別できるかはターミナル次第）。設定を元に戻すと、この設定のためにプラグインが管理しているキーが消える。

**エディタキー**（既定は Ctrl+G。ほかに Ctrl+Q、Option／Alt+G——Claude Code・Codex・OpenCode のどれでも使われていないキー）も同じ扱い。Claude Code と Codex は最初から Ctrl+G でエディタを開くので、既定のままなら何も書かない。別のキーにすると、`~/.claude/keybindings.json` でそのキーを `chat:externalEditor` に割り当て（Ctrl+G は空ける）、`~/.codex/config.toml` の `[tui.keymap.global]` に `open_external_editor` を設定する。Obsidian の外で使うこれらのエージェントにも効く。OpenCode 本来のキーは別（Ctrl+X, E）なので、OpenCode を有効にしていれば `tui.json` にはどの選択でもエディタキー（Ctrl+G を含む）を書く。

プラグインが一度でも起動していれば、Obsidian の外で `agent-sessions` CLI を使うときも vault のパスを重ねて指定する必要はない——`~/.agents/sessions/vault.json`（プラグインが最新に保つ）から vault の場所を読む。

## トラブルシューティング

- **「agent-sessions が見つからない」と出る** — プラグインは入っているが、`agent-sessions` プログラムが入っていない。サイドパネルの **agent-sessions をインストール** を押す（[インストール](#インストール)）。`~/bin` 以外に置く場合は、プラグインの設定でパスを指定する。
- **Claude Code のフック（他のプラグイン自身のフックスクリプトなど）が `node: not found` のようなエラーで失敗する** — node が mise／nvm／asdf／volta などのバージョンマネージャー経由で入っており、そのシェル統合が対話シェル（`.zshrc`／`.bashrc`）でしか読み込まれない環境である可能性が高い。通常、セッションの起動環境は login-but-non-interactive なシェルから組み立てている。プラグインは対話シェルの `PATH` も探ってこれに合流させている（`docs/design.md` §4.2）ので、次のセッションからは直るはず。直らない場合は、普通のターミナルで `$SHELL -i -c 'echo $PATH'` に node のディレクトリが実際に含まれているか確認してほしい。
- **Windows でプログラムをインストールできない（Python や Claude Code が見つからない）** — インストール画面の **WinGet で Python をインストール**／**WinGet で Claude Code をインストール** を押す。ユーザー単位で `winget install` を実行し、管理者権限の確認は出ず、押したときだけ動く。WinGet が無いと出たら、Microsoft Store の「アプリ インストーラー」を更新する。Microsoft Store の空の `python.exe` エイリアスしか無い場合は使われないので、WinGet か python.org から Python を入れる。
- **Windows 版 Obsidian で WSL 内の Claude Code を使いたい** — 非対応（[対応環境](#対応環境)の構成 ② と ③）。代わりに WSLg で Obsidian 自体を WSL の中で動かす（④）。

## 開示事項

- **プラグイン自身もプログラムもネットワークを使わない。ただしようこそガイドの図だけは例外。** プラグインが通信するのは、同じマシン上の自分のデーモンとだけ（Unix ソケット。パーミッションは 0600。Windows では `127.0.0.1` のループバック TCP でポートは毎回ランダム、クライアントは最初に秘密のトークンを送る必要があり、違えば接続は閉じられる）。唯一の例外として、ようこそガイドを開いているあいだだけ、プラグインのバージョンに固定した図を GitHub（`raw.githubusercontent.com`）から読み込みます。取得するのは画像だけで、あなたのデータは送りません。GitHub には IP アドレスと、どの図を取得したかが見えます（リファラは送りません）。**設定 → ガイドの図を GitHub から読み込む** をオフにすると止まり、ガイドは図の代わりに説明文を出します。プラグインが起動する Claude Code・Codex・OpenCode は、利用者自身のアカウントでそれぞれのサービスに接続する。
- **Windows では、さらにいくつかのプログラムを起動する。** Python とエージェントのほかに、`reg.exe`（レジストリから `PATH` を読む。Obsidian の起動中に入れたプログラムを再起動なしで見つけるため）と `py.exe`（Python を探す）を、いずれもコンソール窓を出さずに起動し、`winget.exe` は、インストール画面で Python や Claude Code のインストールボタンを押したときだけ起動する。待ち受けるのは `127.0.0.1` だけ。
- **ローカルのプログラムを起動する。** `agent-sessions` を利用者の Python で動かす（プラグインに読めるソースとして同梱され、インストールを押したときにだけ書き出す）。インストール済みの Claude Code・Codex・OpenCode の CLI（または `ollama launch opencode`）を起動し、ターミナルと同じ `PATH` で動くよう、ログインシェルの環境変数を読む。コードをダウンロードすることは無い。
- **vault の外のファイルを読み書きする。** エージェントと `agent-sessions` が状態をそこに置くため：
  - セッション一覧と使用量のために、Claude Code の `~/.claude/projects/`・`~/.claude/sessions/`・`~/.claude/settings.json` 、Codex の `~/.codex/`（または `$CODEX_HOME`）、OpenCode のデータベース `~/.local/share/opencode/opencode.db`（`$XDG_DATA_HOME` 配下の場合もある。読み取り専用で開く）を読む。
  - `~/.agents/sessions/`（デーモンのソケット——Windows ではループバックのポートとトークンを書いたエンドポイントファイル——・ログ・状態のスナップショット・キャッシュ）に書く。
  - プログラムのインストールで、ホームフォルダ内のフォルダに書き出す（[インストールの詳細](#インストールの詳細)を参照）。インストールと `install.sh` は `~/.claude/settings.json` にフックと `statusLine` を足す（先にバックアップを残す）。送信キーまたはエディタキーの設定を変えると `~/.claude/keybindings.json` に書く。
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

プラグインからプログラムを入れた場合は、先に **設定 → agent-sessions プログラム → 削除** を押す。デーモンを止め（動いているセッションは終了する）、`~/.claude/settings.json` のフックと `statusLine`、`~/.codex/config.toml` の管理行、`~/.config/opencode/tui.json` に入れた送信キー・エディタキーの設定とステータスラインの項目、`~/.config/opencode/plugins/` のステータス用プラグインと `~/.config/opencode/` のステータスラインのファイル、Vault のエージェント用スキルを取り除き、フォルダを消す。その後、「コミュニティプラグイン」で **Agent Sessions** を無効化・削除する。

clone から入れた場合：

```sh
"<このリポジトリのパス>/scripts/uninstall.sh"            # コミュニティプラグインから入れた場合
"<このリポジトリのパス>/scripts/uninstall.sh" "<vault>"  # ソースから入れた場合
```

`uninstall.sh` は、デーモンを止め（動いているセッションが残っていれば確認を求める——飛ばすには
`--force`）、`~/.claude/settings.json` から自分が足したフックと `statusLine` を取り除き
（`install.sh` と同じやり方で先に backup を残す）、送信キー・エディタキーを既定以外に変えていた場合は
`~/.claude/keybindings.json` の `Chat` に足した `enter`／`meta+enter`（送信キー）と `chat:externalEditor`・空けた `ctrl+g`（エディタキー）を取り除き、
`~/bin/agent-sessions`・`~/bin/agent-sessions-code` と、vault を渡した場合は
`<vault>/.obsidian/plugins/agent-sessions` の symlink を外す（symlink でなければ——手で置き換えている等——消さずに案内だけ出す）。他の
ツールのフック・`statusLine`・キーバインドには触れず、何度実行しても安全（冪等）。

`--purge` を付けると `~/.agents/sessions/`（デーモンの実行時状態）と、vault を渡した場合は
`<vault>/.agents/sessions/`（折畳・アーカイブ・カテゴリの色などのセッション管理情報）も消す。

## 仕組み

小さなデーモン（`agent-sessions daemon`。プラグインが必要なときに起動する）が各セッションの PTY（Windows では ConPTY）をローカルのソケット（Unix ドメインソケット。Windows ではトークン付きのループバック TCP）越しに保持するので、タブが attach していなくてもセッションは動き続ける。プラグインはターミナルの入出力についてデーモンと直接やり取りし、それ以外（transcript の走査、利用状況・コストの計算、セッションの木の構築）は `agent-sessions json …` を呼ぶ——このロジックはすべて Python 側にあり、プラグインと CLI／TUI が同じデータを見る。

セッションの管理情報（折畳・アーカイブ・カテゴリの色）は `<vault>/.agents/sessions/sessions.json` に、デーモンと実行時の状態（ソケット・ログ・status のスナップショット・キャッシュ）は `~/.agents/sessions/` 配下に置く。Claude Code 自身のファイル（`~/.claude/projects/*/*.jsonl`・`~/.claude/sessions/*.json`）は読むだけで、書き換えることはない。

設計の全体は [`docs/design.md`](docs/design.md)、その背後にある設計原則は [`docs/principles.md`](docs/principles.md)、本プラグインが拠って立つ要件は [`docs/requirements.md`](docs/requirements.md) を参照。

## CLI

```sh
agent-sessions                 # TUI：セッションを選んで attach／再開
agent-sessions attach ID       # 端末から attach（Ctrl+\ で detach）
agent-sessions daemon [--detach]
agent-sessions json scan|live|detail ID|usage ID [--from ISO --to ISO]|stats
agent-sessions setup [--dry-run]
agent-sessions setup --opencode   # OpenCode のステータス用プラグインとステータスラインだけを入れる（--remove-opencode でそのファイルを取り除き、tui.json の送信キー設定を元に戻す）
agent-sessions setup --skills     # エージェント用スキルを Vault に入れる（--remove-skills でそれだけ取り除く）
agent-sessions new [--agent A] [--cwd DIR] [--name N] [--remote-control] [--prompt TEXT]   # デーモンでセッションを開始（終了コード 0 確認済み・1 未確認・2 失敗）
agent-sessions sessions [--query TEXT] [--agent A] [--limit N] [--json]   # セッションを状態付きで一覧
agent-sessions show [ID|NAME] [--json]   # 1 つのセッションの利用状況と直近のやり取り（省略時はこのセッション）
agent-sessions stats [--json]     # エージェントごとの 5 時間／7 日の利用枠
```

`agent-sessions json` はプラグイン自身が使う機械可読の窓口（`scan`・`live`・`detail`・`usage`・`stats`）。`hook`・`status` は上記の Claude Code のフックと `statusLine` の受け口。`edit` は内蔵エディタの受け口。

Windows では、TUI（引数なしの `agent-sessions`）と `agent-sessions attach` は使えない（`curses` と `termios` が要るため）。それ以外のコマンドは、内蔵エディタを含めて動く。

## 開発

```sh
cd plugin && npm install
npm test && npm run typecheck && npm run build   # プラグイン（vitest・tsc・esbuild）
cd .. && python3 -W error -m unittest discover -s tests -t .   # Python（標準ライブラリのみ）
```

ビルドとテストの詳細、スクリーンショットの撮り方、言語の追加、リリースの手順は [`docs/development.md`](docs/development.md)（英語）にある。テストは [`docs/testing.md`](docs/testing.md)、設計判断の理由は [`docs/principles.md`](docs/principles.md) に書いてある。

## ライセンス

MIT。全文は [`LICENSE`](LICENSE)。`plugin/main.js` には xterm.js とそのアドオン（同じく MIT）が同梱されており、そのライセンス全文と著作権表示は [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) にある。
