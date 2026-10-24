// The README's scene: three made-up sessions, the vault's notes, and the spec the agent edits.
// `sceneScenario(lang, kind)` gives the words in `lang`; `kind` is "hero" (the still image: the
// spec session is running) or "gif" (the recording opens with the spec session asking a question).
// The numbers and states are shared by both languages.

const COMMON = { agent: "claude", model: "Opus 5.5", effort: "high", daemon: true };

const SPEC_PATH = "docs/spec/checkout-q4.md";

const SPEC_EN = `# Checkout design spec (Q4)

## Overview

The checkout takes a cart, a payment method and an address, and returns an order number. This spec covers the payment step only.

## Payment methods

| Method | Settles | Fee |
|---|---|---|
| Card | Immediately | 3.4% |
| Bank transfer | Next business day | Flat 150 |

Each method has its own confirmation screen and its own failure messages.

## Rounding

Amounts are rounded once per order, after tax, to the currency's smallest unit. Line items keep their unrounded values so that refunds add up.

## Errors

- A declined card keeps the cart and shows the bank's reason when it gives one.
- A timeout never creates a second order: the retry reuses the order number.
`;

const SPEC_JA = `# 決済フローの設計書(Q4)

## 概要

チェックアウトは、カート・決済手段・住所を受け取り、注文番号を返します。この設計書が扱うのは、決済のステップだけです。

## 決済手段

| 手段 | 入金 | 手数料 |
|---|---|---|
| カード | 即時 | 3.4% |
| 銀行振込 | 翌営業日 | 一律 150 円 |

決済手段ごとに、確認画面と失敗時のメッセージを持ちます。

## 端数処理

金額は、税を足したあとに、注文ごとに1回だけ通貨の最小単位へ丸めます。明細の行は丸める前の値を持ち、返金の合計が合うようにします。

## エラー表示

- カードが拒否されても、カートは残し、銀行が理由を返したときはそれを出します。
- タイムアウトで2つ目の注文は作りません。再試行は同じ注文番号を使います。
`;

/** The row the recording adds (the line after the table's last row). */
export const NEW_ROW = { en: "| Convenience store | 2 days | Flat 120 |", ja: "| コンビニ払い | 2営業日 | 一律 120 円 |" };
const TABLE_END = { en: "| Bank transfer | Next business day | Flat 150 |", ja: "| 銀行振込 | 翌営業日 | 一律 150 円 |" };

/** The spec with the new row added: what the agent's edit writes. */
export function specWithNewRow(lang) {
	const text = lang === "ja" ? SPEC_JA : SPEC_EN;
	return text.replace(TABLE_END[lang], `${TABLE_END[lang]}\n${NEW_ROW[lang]}`);
}

export const SPEC_FILE = SPEC_PATH;

const NOTES = {
	en: {
		[SPEC_PATH]: SPEC_EN,
		"docs/spec/requirements.md": `# Checkout requirements

- Payment methods: card and bank transfer for now
- Rounding: once per order, after tax
- Errors: say why a payment failed when the bank tells us
- Retries must not create a second order
- Receipts list every line item
- Refunds reuse the original payment method
- Amounts are shown in the shop's currency
- Every failure keeps the cart
`,
		"docs/spec/notes.md": "# Notes from the payments call\n\n- Convenience store payment is wanted before the holiday season\n- Keep the confirmation screens short\n",
		"contracts/nda-acme.md": "# NDA review: Acme\n\n- Term: 3 years\n- Governing law and venue to confirm\n",
	},
	ja: {
		[SPEC_PATH]: SPEC_JA,
		"docs/spec/requirements.md": `# チェックアウトの要件

- 決済手段:当面はカードと銀行振込
- 端数処理:税を足したあと、注文ごとに1回
- エラー:銀行が理由を返したときは、失敗の理由を伝える
- 再試行で2つ目の注文を作らない
- 領収書に全明細を載せる
- 返金は元の決済手段で行う
- 金額は店舗の通貨で表示する
- どの失敗でもカートを残す
`,
		"docs/spec/notes.md": "# 決済まわりの打ち合わせメモ\n\n- コンビニ払いを年末商戦の前に入れたい\n- 確認画面は短く保つ\n",
		"contracts/nda-acme.md": "# NDA 確認:Acme\n\n- 期間:3年\n- 準拠法と管轄は要確認\n",
	},
};

const TEXT = {
	en: {
		spec: "Docs: Checkout spec",
		cart: "Storefront: Cart flicker",
		nda: "Contracts: NDA review",
		specUser: "Draft the Q4 checkout design spec from the notes in docs/spec/.",
		specLast: "The spec has four sections: overview, payment methods, rounding and errors.",
		cartUser: "The cart count flickers when I add an item. Find out why.",
		cartLast: "Two components update the count. Which one should own it?",
		ndaUser: "Review the Acme NDA and list the clauses to negotiate.",
		ndaLast: "Done. Three clauses to negotiate: term, governing law and venue.",
	},
	ja: {
		spec: "設計書: 決済仕様",
		cart: "Storefront: カートのちらつき",
		nda: "契約: NDA 確認",
		specUser: "メモ(docs/spec/)から、Q4 の決済フローの設計書を書いて。",
		specLast: "概要・決済手段・端数処理・エラー表示の4つの節を書きました。",
		cartUser: "商品を足すと、カートの数が一瞬ちらつきます。原因を調べてください。",
		cartLast: "数を更新するコンポーネントが2つあります。どちらに任せますか?",
		ndaUser: "Acme との NDA を確認して、交渉すべき条項を挙げてください。",
		ndaLast: "できました。交渉すべきは、期間・準拠法・管轄の3条項です。",
	},
};

const ids = {
	spec: "d14e0a73-52b8-4c19-a6f0-3b7c9e2d8a41",
	cart: "e6b2c9f4-0d37-4a85-9c1e-8f5a2b7d3c60",
	nda: "f8a1d3e5-7b92-4c06-b4d8-1e9a5c3f7b82",
};

export function sceneScenario(lang, kind) {
	const t = TEXT[lang === "ja" ? "ja" : "en"];
	const common = { ...COMMON, project: "Sample" };
	const sessions = [
		{
			...common,
			id: ids.spec,
			name: t.spec,
			minutesAgo: 0,
			registry: kind === "gif" ? "waiting" : "busy",
			waitingFor: "permission prompt",
			tab: true,
			ctx: 34,
			transcript: kind === "gif" ? "scene-ask" : "scene-hero",
			detail: { last_user: t.specUser, last_assistant: t.specLast },
			usage: { input: 96_000, output: 44_000, cache_read: 3_100_000, cache_create: 260_000, cost: 2.38 },
			cost5h: 2.38,
			cost7d: 2.38,
		},
		{
			...common,
			id: ids.cart,
			name: t.cart,
			minutesAgo: 4,
			model: "Sonnet 5",
			effort: "medium",
			registry: "waiting",
			waitingFor: "permission prompt",
			ctx: 22,
			detail: { last_user: t.cartUser, last_assistant: t.cartLast },
			usage: { input: 64_000, output: 31_000, cache_read: 2_000_000, cache_create: 180_000, cost: 1.42 },
			cost5h: 1.42,
			cost7d: 1.42,
		},
		{
			...common,
			id: ids.nda,
			name: t.nda,
			minutesAgo: 9,
			model: "Sonnet 5",
			effort: "medium",
			registry: "idle",
			ctx: 41,
			detail: { last_user: t.ndaUser, last_assistant: t.ndaLast },
			usage: { input: 52_000, output: 27_000, cache_read: 1_700_000, cache_create: 140_000, cost: 1.08 },
			cost5h: 1.08,
			cost7d: 1.08,
		},
	];
	return {
		sessions,
		notes: { ...NOTES[lang === "ja" ? "ja" : "en"], "Welcome.md": "# Sample vault\n" },
		suggestions: [],
		comment: "",
		organizeCategory: "",
		newSessionName: "",
		editorDraft: "",
		specId: ids.spec,
		specPath: SPEC_PATH,
	};
}
