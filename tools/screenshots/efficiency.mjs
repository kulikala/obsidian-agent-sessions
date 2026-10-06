// The made-up token efficiency data the screenshots show: what the stand-in CLI answers to
// `json efficiency` (statistics, hits, masked excerpts) and what the stand-in `claude` answers
// to the analysis prompt (findings that pass the plugin's checks: known hit ids, quotes copied
// from the excerpts, numbers taken from the statistics). Nothing here comes from a real
// conversation.

import { cwdOf } from "./scenario.mjs";

const CHECKOUT = "5f0c8a4e-3b1d-4f6a-9c2e-7d8b1a0e4c11";
const MIGRATION = "8e2b6d17-4c90-4a3e-b5f1-2a7c9e0d3f58";
const TERRAFORM = "c41d9f02-6a3b-4e8c-9d7f-1b5e2a8c0f93";
const WEBHOOKS = "3a7e5c90-1f2d-4b6a-8c3e-9d0f4a2b7e65";

const TEXT = {
	en: {
		checkout: ["Run the checkout tests and list the ones that fail.", "Run the full checkout suite and the type check."],
		checkoutReply: "Ran the suite: 3 failures, all in the coupon tests. Full output above.",
		migration: [
			"Write the v3 to v4 migration guide from the changelog. Keep it to one page.",
			"no, not like that",
			"That's still wrong, use the format from the v3 guide.",
		],
		migrationReply: "Rewrote the guide in the v3 format, one section per breaking change.",
		terraform: ["Remove the unused staging buckets and their IAM bindings."],
		reply: {
			e01Title: "Full test output stays in the conversation",
			e01Cause:
				"The checkout suite printed about 21,000 tokens of output, and every one of the next 200 calls read it again. The same command did this in several sessions.",
			e01Summary: "Have the agent print only failing tests and the end of the output.",
			e01Steps: ["Add the rule below to the project's CLAUDE.md.", "Run the suite through it the next time."],
			e01Draft: "- When running tests, print only the failing tests and the last 30 lines of output.\n- Read large files by line range, not whole.",
			e16Title: "The guide was corrected several times",
			e16Cause:
				"The first request named the content but not the format; the format came in the third message, after a full draft had been written and rewritten.",
			e16Summary: "Say the format and how to check it in the first message.",
			e16Steps: ["Name the target, the expected result, how to check it and what not to touch.", "If a second correction misses again, write down what you learned and start a new tab."],
			e02Title: "One conversation carried a very large context",
			e02Cause: "The checkout work went on in one conversation after the fix was done, re-reading its whole context on every call.",
			e02Summary: "Start the next piece of work in a new tab and pass on only the key points.",
			e03Reason: "The infrastructure tasks reused the same plan and files; this was one piece of work.",
		},
	},
	ja: {
		checkout: ["チェックアウトのテストを実行して、失敗するものを挙げてください。", "チェックアウトのテスト一式と型チェックを実行してください。"],
		checkoutReply: "テスト一式を実行しました。失敗は3件で、すべてクーポンのテストです。全出力は上のとおりです。",
		migration: [
			"変更履歴から v3 → v4 の移行ガイドを書いてください。1ページに収めて。",
			"違う、そうじゃない",
			"まだ違います。v3 のガイドの形式にしてください。",
		],
		migrationReply: "v3 の形式で、破壊的変更ごとに1節ずつ書き直しました。",
		terraform: ["使っていないステージング用バケットと IAM の紐づけを削除してください。"],
		reply: {
			e01Title: "テストの全出力が会話に残り続けている",
			e01Cause:
				"チェックアウトのテスト一式が約 21,000 トークンを出力し、そのあとの 200 回の呼び出しが毎回それを読み直していました。同じコマンドで、複数のセッションに同じことが起きています。",
			e01Summary: "失敗したテストと出力の末尾だけを出すように、エージェントに伝えます。",
			e01Steps: ["下の決まりをプロジェクトの CLAUDE.md に足します。", "次にテストを実行するときから効きます。"],
			e01Draft: "- テストを実行したら、失敗したテストと出力の末尾 30 行だけを出す。\n- 大きなファイルは全体でなく行の範囲で読む。",
			e16Title: "ガイドの修正が何度も往復した",
			e16Cause: "最初の依頼は内容を挙げていましたが、形式は3つ目の入力で伝えられ、それまでに下書きの全体が2回書かれていました。",
			e16Summary: "形式と確かめ方を、最初の入力に書きます。",
			e16Steps: ["対象・期待する結果・確かめ方・触らない範囲を書きます。", "2回直しても違うときは、分かったことを書き出して新しいタブで始めます。"],
			e02Title: "1つの会話でとても大きな文脈を抱え続けた",
			e02Cause: "修正が終わったあとも同じ会話でチェックアウトの作業を続け、呼び出しのたびに文脈の全体を読み直していました。",
			e02Summary: "次の作業は新しいタブで始め、要点だけを渡します。",
			e03Reason: "インフラの作業は同じ計画とファイルを使い続けており、1つの作業でした。",
		},
	},
};

const HOUR = 3600;

function hit(over) {
	return {
		agent: "claude",
		chain: "main",
		saving_rate: 0.5,
		confidence: "high",
		needs_llm: false,
		remedy_kind: "habit",
		change: null,
		targets: [],
		shown_targets: [],
		impact_usd: null,
		...over,
	};
}

/** `json efficiency`'s answer for the sandbox's sessions, `now` and `lang`. */
export function efficiencyOutput(now, sessions, lang) {
	const text = TEXT[lang] ?? TEXT.en;
	const byId = (id) => sessions.find((s) => s.id === id);
	const storefront = cwdOf(byId(CHECKOUT));
	const billing = cwdOf(byId(WEBHOOKS));
	const claudeSessions = sessions.filter((s) => s.agent === "claude");
	const hits = [
		hit({
			id: "h-4e01c2a9b1", detector: "E01", session: CHECKOUT, task: "t-chk0000001", ts: now - 3 * HOUR,
			metrics: { est_tokens: 21_000, reads_after: 200, results: 1, repeats: 4 },
			impact_w: 420_000, impact_usd: 2.1, saving_rate: 0.8, remedy_kind: "fix", change: "add",
			targets: [`${storefront}/CLAUDE.md`], shown_targets: ["…/storefront/CLAUDE.md"],
		}),
		hit({
			id: "h-4e01c2a9b2", detector: "E01", session: CHECKOUT, task: "t-chk0000001", ts: now - 2 * HOUR,
			metrics: { est_tokens: 19_400, reads_after: 160, results: 1, repeats: 4 },
			impact_w: 310_400, impact_usd: 1.55, saving_rate: 0.8, remedy_kind: "fix", change: "add",
			targets: [`${storefront}/CLAUDE.md`], shown_targets: ["…/storefront/CLAUDE.md"],
		}),
		hit({
			id: "h-7e16a0c3d4", detector: "E16", session: MIGRATION, task: "t-mig0000001", ts: now - 9 * HOUR,
			metrics: { corrections: 2, reverts: 1, interrupts: 0, calls: 140, turns: 3, calls_ratio: 5.2, max_rewrites: 6 },
			impact_w: 1_250_000, impact_usd: 4.4, needs_llm: true, confidence: "medium",
		}),
		hit({
			id: "h-2e02b9f0e1", detector: "E02", session: CHECKOUT, task: "t-chk0000001", ts: now - 1 * HOUR,
			metrics: { calls_over: 14, max_ctx: 812_000, threshold: 600_000, max_rewrites: 1 },
			impact_w: 640_000, impact_usd: 3.2, confidence: "medium",
		}),
		hit({
			id: "h-8e08d1f2a3", detector: "E08", session: WEBHOOKS, task: null, ts: now - 5 * HOUR,
			metrics: { sessions: 5, est_tokens: 6_400, kind: "read", outside_cwd: false, shown_path: "…/docs/webhooks.md" },
			impact_w: 210_000, impact_usd: 0.9, saving_rate: 0.6, remedy_kind: "fix", change: "add",
			targets: [`${billing}/CLAUDE.md`], shown_targets: ["…/billing-api/CLAUDE.md"],
			read_path: `${billing}/docs/webhooks.md`,
		}),
		hit({
			id: "h-3e04a7b8c9", detector: "E04", session: TERRAFORM, task: "t-inf0000001", ts: now - 20 * HOUR,
			metrics: { gap: 7_400, ttl: 3_600, cache_write: 410_000 },
			impact_w: 779_000, impact_usd: 3.9, saving_rate: 0.9,
		}),
		hit({
			id: "h-9e03c4d5e6", detector: "E03", session: TERRAFORM, task: "t-inf0000002", ts: now - 18 * HOUR,
			metrics: { tasks: 3, carry: 240_000, calls: 30, position: 2 },
			impact_w: 720_000, impact_usd: 3.6, needs_llm: true, saving_rate: 0.9, confidence: "medium",
		}),
	];
	const range = {
		rule: "budget", basis: "budget", start: now - 30 * HOUR, end: now, used_percentage: null, exhausted: false,
		budget: 10_000_000,
		windows: { five_hour: { used_percentage: 38, end: now + 2.4 * HOUR, exhausted: false }, seven_day: { used_percentage: 61, end: now + 2.6 * 86400, exhausted: false } },
	};
	const totals = {
		calls: 1_842, uncached_in: 21_400, cache_read: 81_200_000, cache_write: 1_960_000, cache_write_1h: 1_310_000,
		output: 412_000, reasoning: 96_000, w: 13_480_000, usd: 52.31, unpriced_calls: 0, cache_hit: 0.974, preamble_median: 56_000,
	};
	const breakdown = [
		{ cause: "other", w: 8_020_000 }, { cause: "team", w: 2_310_000 }, { cause: "E04", w: 1_190_000 },
		{ cause: "E01", w: 1_080_000 }, { cause: "E02", w: 650_000 }, { cause: "E08", w: 230_000 },
	];
	const excerpts = [
		{
			task: "t-mig0000001", session: MIGRATION, provider: "anthropic", w: 1_410_000, calls: 140, impact_w: 1_250_000,
			prompts: text.migration.map((t, i) => ({ ref: `t-mig0000001.p${i + 1}`, text: t, rework: i === 0 ? [] : [1] })),
			replies: [{ ref: "t-mig0000001.r3", text: text.migrationReply }],
			tools: [{ tool: "Read", kind: "read", chain: "main", path: "…/docs-site/CHANGELOG.md", result_tokens: 3_100, error: false },
				{ tool: "Write", kind: "edit", chain: "main", path: "…/docs/migrate-to-v4.md", result_tokens: 20, error: false }],
		},
		{
			task: "t-inf0000002", session: TERRAFORM, provider: "anthropic", w: 820_000, calls: 30, impact_w: 720_000,
			prompts: text.terraform.map((t, i) => ({ ref: `t-inf0000002.p${i + 1}`, text: t, rework: [] })),
			replies: [], tools: [{ tool: "Bash", kind: "exec", chain: "main", path: null, cmd: "terraform plan", result_tokens: 2_400, error: false }],
		},
		{
			task: "t-chk0000001", session: CHECKOUT, provider: "anthropic", w: 2_870_000, calls: 410, impact_w: 1_370_400,
			prompts: text.checkout.map((t, i) => ({ ref: `t-chk0000001.p${i + 1}`, text: t, rework: [] })),
			replies: [{ ref: "t-chk0000001.r2", text: text.checkoutReply }],
			tools: [{ tool: "Bash", kind: "exec", chain: "main", path: null, cmd: "npm test -- checkout", result_tokens: 21_000, error: false }],
		},
	];
	const sessionsOut = claudeSessions.map((s, i) => ({
		id: s.id, name: s.name, cwd: cwdOf(s), folder: s.project, version: "2.1.280", child: false, team: i === 0,
		calls: 120 + 40 * i, w: 2_000_000 - 150_000 * i, usd: Math.round((8 - i) * 100) / 100,
	}));
	return {
		version: 1,
		agents: {
			claude: {
				range, totals,
				providers: [{ provider: "anthropic", models: { "claude-opus-5": 1_520, "claude-sonnet-5": 322 }, local: false, w: totals.w }],
				sessions: sessionsOut,
				breakdown,
				tasks: [],
				hits,
				excerpts,
				baselines: { window_days: 14, inputs: 318, starts: 126, L_med: 40.9, L1_med: 35.9, C_med: 9, disabled: [] },
				limits: { truncated: false, reason: null, collisions: 0, disabled: [], sessions_read: claudeSessions.length },
				summary: {
					agent: "claude", range: { ...range, windows: undefined }, totals, breakdown,
					hits: hits.map((h) => ({ id: h.id, detector: h.detector, session: h.session, task: h.task, metrics: h.metrics, impact_w: h.impact_w,
						needs_llm: h.needs_llm, remedy_kind: h.remedy_kind, change: h.change, targets: h.shown_targets })),
					sessions: sessionsOut.map((s) => ({ id: s.id, name: s.name, folder: s.folder })),
					instructions: [{ file: "…/storefront/CLAUDE.md", type: "Project", bytes: 6_400, lines: 120 }],
					skills: 64,
				},
			},
		},
	};
}

/** What the stand-in `claude` answers to the analysis prompt (a JSON object, as asked). */
export function efficiencyReply(lang) {
	const r = (TEXT[lang] ?? TEXT.en).reply;
	const migration = (TEXT[lang] ?? TEXT.en).migration;
	return {
		findings: [
			{
				hits: ["h-7e16a0c3d4"], detector: "E16", origin: "user_prompt", title: r.e16Title, cause: r.e16Cause,
				quotes: [{ ref: "t-mig0000001.p3", text: migration[2] }],
				remedy: { kind: "habit", summary: r.e16Summary, steps: r.e16Steps }, confidence: "medium",
			},
			{
				hits: ["h-4e01c2a9b1", "h-4e01c2a9b2"], detector: "E01", origin: "config", title: r.e01Title, cause: r.e01Cause,
				quotes: [{ ref: "t-chk0000001.p1", text: (TEXT[lang] ?? TEXT.en).checkout[0] }],
				remedy: { kind: "fix", change: "add", summary: r.e01Summary, steps: r.e01Steps, targets: ["…/storefront/CLAUDE.md"], draft: r.e01Draft },
				confidence: "high",
			},
			{
				hits: ["h-2e02b9f0e1"], detector: "E02", origin: "habit", title: r.e02Title, cause: r.e02Cause, quotes: [],
				remedy: { kind: "habit", summary: r.e02Summary, steps: [] }, confidence: "medium",
			},
		],
		dismissed: [{ hits: ["h-9e03c4d5e6"], reason: r.e03Reason }],
	};
}
