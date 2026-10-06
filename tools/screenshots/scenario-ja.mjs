// The Japanese version of the scenario's words, for the onboarding screenshots: session names,
// the last exchange shown in the detail pane, the prompts in Session analytics, the vault's notes,
// and the organize suggestions.
// Keyed by the session ids in scenario.mjs; everything else (models, costs, times) is shared.

export const SESSION_TEXT_JA = {
	"5f0c8a4e-3b1d-4f6a-9c2e-7d8b1a0e4c11": {
		name: "ストアフロント: チェックアウト合計のちらつき",
		last_user: "クーポンを適用すると、チェックアウト画面で一瞬だけ古い合計が表示されます。直して、回帰テストも足してください。",
		last_assistant: "合計の計算がクーポンを見ていないメモ化に頼っていました。依存配列を直してテストを足し、いまチェックアウト全体のテストを流しています。",
		prompts: [
			"src/checkout を読んで、注文の合計がどう計算されるか説明してください。",
			"チェックアウトのテストを実行して、失敗するものを挙げてください。",
			"カートのテストが CI でだけタイムアウトするのはなぜですか?",
			"そのテストでは、本物のタイマーの代わりに偽の時計を使ってください。",
			"クーポンのルールを別のモジュールに移してください。動きは変えないで。",
			"古い export は、しばらく別名として残してください。",
			"新しいモジュール構成に合わせて、スナップショットテストを更新してください。",
			"/compact",
			"注文の合計は、ほかにどこで整形していますか?",
			"ページ内の金額は、すべて1つの整形関数で表示してください。",
			"確認メールの注文概要も確かめてください。",
			"クーポンを確かめているあいだ、合計に読み込み中の表示を出してください。",
			"チェックアウトのテスト一式と型チェックを実行してください。",
			"クーポンを適用すると、チェックアウト画面で一瞬だけ古い合計が表示されます。直して、回帰テストも足してください。",
		],
		goal: {
			condition: "チェックアウトのテストがすべて通り、クーポン適用後に古い合計が一瞬も出ないこと。",
			reason: "修正は入りましたが、チェックアウトのテスト一式がまだ実行中です。",
		},
	},
	"0199a3c2-7e41-7b52-a3f0-5c9d2e81b604": {
		name: "API: レート制限のテスト",
		last_user: "トークンバケット方式のレート制限に、バースト時を含むテストを足してください。",
		last_assistant: "補充・バースト・同時アクセスの表形式テストを追加しました。レース検出を有効にして実行しますか?",
	},
	"8e2b6d17-4c90-4a3e-b5f1-2a7c9e0d3f58": {
		name: "ドキュメント: 移行ガイド",
		last_user: "変更履歴から v3 → v4 の移行ガイドを書いてください。1ページに収めて。",
		last_assistant: "できました。docs/migrate-to-v4.md に、3つの破壊的変更を変更前後のコード付きでまとめています。",
		goal: {
			condition: "破壊的変更をすべて扱った、1ページの v3 → v4 移行ガイド。",
			reason: "docs/migrate-to-v4.md が3つの破壊的変更すべてを、変更前後のコード付きで扱っています。",
		},
	},
	"c41d9f02-6a3b-4e8c-9d7f-1b5e2a8c0f93": {
		name: "インフラ: Terraform の整理",
		last_user: "使っていないステージング用バケットと IAM の紐づけを削除してください。",
		last_assistant: "計画では6つのリソースが削除されます。すべて modules/staging-legacy の下で、ほかに変更はありません。",
	},
	"0199a3b7-2d15-7c08-8e64-f3a1b9c47d20": {
		name: "モバイル: オフライン同期",
		last_user: "オフライン中の書き込みをためておき、接続が戻ったら順番どおりに再送してください。",
		last_assistant: "書き込みはアウトボックス表を通すようにしました。再送は連番順で、リクエスト ID ごとに重複しません。",
	},
	"3a7e5c90-1f2d-4b6a-8c3e-9d0f4a2b7e65": {
		name: "API: Webhook の再試行",
		last_user: "失敗した Webhook を、指数バックオフとデッドレターキュー付きで再試行してください。",
		last_assistant: "ローカルのキューに対して統合テストを実行しています…",
	},
	"b95f1e28-7d4c-4a0b-9e6f-3c2a8d5b1f07": {
		name: "調査: ベクトル検索の試作",
		last_user: "200万件のサンプルで pgvector とホスト型インデックスを比べてください。k=10 の遅延と再現率で。",
		last_assistant: "ベンチマーク用のコンテナを起動する許可が必要です(docker compose up bench)。",
	},
	"0199a2f4-9b63-7a1e-b0c8-4e7d2f5a9c31": {
		name: "ストアフロント: 画像パイプライン",
		last_user: "AVIF を配信し、WebP をフォールバックにしてください。リサイズ済みの画像はキャッシュして。",
		last_assistant: "最初のリクエストで各サイズを生成し、内容ハッシュ付きで /img/cache に保存します。",
	},
	"0199a1d0-4f82-7e39-a5b1-8c6e0d3f2a74": {
		name: "ドキュメント: API リファレンス",
		last_user: "OpenAPI の定義から、v4 のエンドポイントごとのリファレンスページを生成してください。",
		last_assistant: "42 個のエンドポイントのページを生成し、サイドバーではリソースごとにまとめました。",
	},
	"e6c2a0f9-5b8d-4d31-a7e4-0f9b3c6d2e18": {
		name: "モバイル: プッシュ通知",
		last_user: "Android で、プッシュ通知を会話ごとにまとめてください。",
		last_assistant: "通知は会話ごとのグループキーでまとめ、要約の通知を添えるようにしました。",
	},
	"7d4b1c83-2e6f-4a9d-8b05-6c3f9a1e0d42": {
		name: "インフラ: CI のキャッシュ",
		last_user: "ジョブ間で依存関係のインストールをキャッシュして、CI の時間を短くしてください。",
		last_assistant: "ロックファイルのハッシュをキーにキャッシュしました。パイプラインの中央値は14分から6分になりました。",
	},
	"0199a0b8-1c47-7f25-9d3a-2b8e6f0c4a59": {
		name: "ストアフロント: ダークモード",
		last_user: "システムの設定に従うダークテーマを追加してください。",
		last_assistant: "テーマの値をライトとダークに分け、prefers-color-scheme で切り替えます。",
	},
};

export const NOTES_JA = {
	"ようこそ.md": "# ようこそ\n\nストアフロント、請求 API、モバイルアプリのプロジェクトのメモです。\n",
	"プロジェクト/ストアフロント.md": "# ストアフロント\n\n- チェックアウト合計のちらつき\n- 画像パイプライン\n",
	"プロジェクト/請求 API.md": "# 請求 API\n\n- レート制限のテスト\n- Webhook の再試行\n",
};

export const ORGANIZE_SUGGESTIONS_JA = [
	{
		id: "5f0c8a4e-3b1d-4f6a-9c2e-7d8b1a0e4c11",
		category: "ストアフロント",
		name: "チェックアウトの古いクーポン合計",
		reason: "クーポンを見ていないメモ化を直し、チェックアウトの合計が一瞬古い金額に戻らないようにした。",
	},
	{
		id: "8e2b6d17-4c90-4a3e-b5f1-2a7c9e0d3f58",
		category: "ドキュメント",
		name: "v4 移行ガイド",
		reason: "3つの破壊的変更を変更前後のコード付きでまとめた、v3 から v4 への1ページの移行ガイド。",
	},
	{
		id: "3a7e5c90-1f2d-4b6a-8c3e-9d0f4a2b7e65",
		category: "信頼性",
		name: "バックオフ付きの Webhook 再試行",
		reason: "失敗した Webhook を指数バックオフとデッドレターキューで再試行する。",
	},
	{
		id: "c41d9f02-6a3b-4e8c-9d7f-1b5e2a8c0f93",
		category: "インフラ",
		name: "ステージング用バケットの削除",
		reason: "modules/staging-legacy にある未使用のリソース6件と IAM の紐づけを削除する。",
	},
	{
		id: "b95f1e28-7d4c-4a0b-9e6f-3c2a8d5b1f07",
		category: "調査",
		name: "ベクトルインデックスの比較",
		reason: "200万件のサンプルで pgvector とホスト型インデックスを比較する。k=10 の遅延と再現率。",
	},
];
export const ORGANIZE_COMMENT_JA = "比べる2つのシステムの名前を入れてください";
