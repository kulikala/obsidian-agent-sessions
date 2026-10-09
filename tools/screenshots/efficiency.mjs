// The made-up token efficiency data the screenshots show: what the stand-in CLI answers to
// `json efficiency` (statistics, hits and the masked digest of every task) and what the stand-in
// `claude` answers to the analysis requests (issues that pass the plugin's checks: task ids that
// were sent, quotes copied from the prompts, numbers taken from the digest). With `split`, the
// digest has enough other tasks to need several requests. Nothing here comes from a real
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
			e01Observed:
				"The checkout suite printed about 21,000 tokens of output, and every one of the next 200 calls read it again. The same command did this in several sessions.",
			e01Fix: "Add a rule to CLAUDE.md: print only the failing tests and the end of the output.",
			e01Draft: "- When running tests, print only the failing tests and the last 30 lines of output.\n- Read large files by line range, not whole.",
			e16Title: "The guide was corrected several times",
			e16Observed:
				"The first request named the content but not the format; the format came in the third message, after a full draft had been written and rewritten.",
			e16Fix: "Put the format and how to check it in the first request. If two corrections still miss, start again in a new tab.",
			e04Title: "The cache expired during a long break",
			e04Observed: "After a pause of about two hours the cache had expired, and about 410,000 tokens were written to it again.",
			e04Fix: "After a long break from a large conversation, start a new tab with the key points instead of continuing.",
			pollTitle: "A wait loop checked the deploy every 30 seconds",
			pollObserved: "The agent waited for the webhook deploy by checking its status again and again; each check read the whole conversation.",
			pollFix: "Ask the agent to run the deploy's own wait command once, or to come back when you say it is done.",
			lintTitle: "The linter ran on the whole repository",
			lintObserved: "Each run linted every package, though the change touched one, and the full report came back each time.",
			lintFix: "Name the package to lint in the request, or add the scoped lint command to CLAUDE.md.",
		},
		hooks: ["Retry failed webhook deliveries with backoff, then deploy to staging and tell me when it is live."],
		hooksReply: "Added retries with exponential backoff. Deployed to staging; waiting for the rollout to finish.",
		filler: "Tidy up the order history page: keep the columns as they are, fix the spacing, and check it in the browser.",
		fillerReply: "Fixed the spacing in the order history table and checked it in the browser.",
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
			e01Title: "テストの全出力が会話に残り続けた",
			e01Observed:
				"チェックアウトのテスト一式が約 21,000 トークンを出力し、そのあとの 200 回の呼び出しが毎回それを読み直していました。同じコマンドで、複数のセッションに同じことが起きています。",
			e01Fix: "失敗したテストと出力の末尾だけを出すよう、CLAUDE.md に決まりを足してください。",
			e01Draft: "- テストを実行したら、失敗したテストと出力の末尾 30 行だけを出す。\n- 大きなファイルは全体でなく行の範囲で読む。",
			e16Title: "形式の指定が後になり、ガイドを書き直した",
			e16Observed: "最初の依頼には内容だけがあり、形式は 3 つ目の入力で伝えていました。それまでに下書きの全体を 2 回書いています。",
			e16Fix: "形式と確認方法を、最初の依頼に書いてください。2 回直しても違うときは、新しいタブでやり直してください。",
			e04Title: "長い休憩のあと、キャッシュを作り直した",
			e04Observed: "約 2 時間の間が空いてキャッシュが切れ、約 41 万トークンを書き込み直しました。",
			e04Fix: "大きな会話から長く離れたあとは、続けるより、新しいタブで要点から始めてください。",
			pollTitle: "デプロイの完了を 30 秒ごとに確かめ続けた",
			pollObserved: "Webhook のデプロイが終わるまで、エージェントが状態を何度も確かめ、そのたびに会話の全体を読み直していました。",
			pollFix: "デプロイの完了を待つコマンドを 1 回だけ実行させるか、終わったら知らせると伝えてください。",
			lintTitle: "リポジトリ全体に lint をかけていた",
			lintObserved: "変更は 1 つのパッケージだけでしたが、毎回すべてのパッケージに lint をかけ、全体の結果が返っていました。",
			lintFix: "依頼に lint するパッケージを書くか、範囲を絞った lint のコマンドを CLAUDE.md に足してください。",
		},
		hooks: ["失敗した Webhook の配信をバックオフ付きで再送するようにして、ステージングにデプロイし、反映されたら教えてください。"],
		hooksReply: "指数バックオフの再送を足しました。ステージングにデプロイし、反映を待っています。",
		filler: "注文履歴のページを整えてください。列はそのままで、余白を直して、ブラウザで確かめてください。",
		fillerReply: "注文履歴の表の余白を直し、ブラウザで確かめました。",
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

const CHECKS = ["rework", "firstRequest", "mixedTasks", "longContext", "largeOutput", "cacheRebuild", "repeatedLookups", "startupSize", "found"];

/** A task's per-check savings: `of` names the checks with a saving; every other check is small. */
function saving(of = {}) {
	return Object.fromEntries(CHECKS.map((c) => [c, of[c] ?? 1_200]));
}

function iso(ts) {
	return new Date(ts * 1000).toISOString().slice(0, 16);
}

/** One task of the digest: its prompts (and the start of the last reply) as turns. */
function task(id, session, ts, prompts, reply, of, extra = {}) {
	const turns = prompts.map((prompt, i) => ({
		ref: `${id}.p${i + 1}`,
		at: iso(ts + i * 600),
		prompt,
		w: 40_000 + 9_000 * i,
		calls: 6 + 3 * i,
		tools: { read: 2 + i, edit: 1 },
		paths: ["src/orders/history.tsx"],
		elapsed_s: 140 + 30 * i,
		max_ctx: 61_000 + 8_000 * i,
		models: ["claude-opus-5"],
		...(i > 0 && extra.rework ? { rework: [1] } : {}),
		...(i === prompts.length - 1 && reply ? { reply, reply_ref: `${id}.r${i + 1}` } : {}),
	}));
	return {
		id, session, at: iso(ts), ts, w: turns.reduce((n, t) => n + t.w, 0), calls: turns.reduce((n, t) => n + t.calls, 0),
		start_ctx: 56_000, end_ctx: 61_000 + 8_000 * prompts.length, turn_count: prompts.length, turns, saving: saving(of),
	};
}

/** `json efficiency`'s answer for the sandbox's sessions, `now` and `lang`; `split`: with enough
 * other tasks that the analysis takes several requests. */
export function efficiencyOutput(now, sessions, lang, split = false) {
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
	const tasks = [
		task("t-inf0000001", TERRAFORM, now - 20 * HOUR, text.terraform, null, { cacheRebuild: 350_000 }),
		task("t-inf0000002", TERRAFORM, now - 18 * HOUR, text.terraform, null, {}),
		task("t-mig0000001", MIGRATION, now - 9 * HOUR, text.migration, text.migrationReply, { rework: 450_000 }, { rework: true }),
		task("t-hook000001", WEBHOOKS, now - 5 * HOUR, text.hooks, text.hooksReply, { found: 260_000 }),
		task("t-chk0000001", CHECKOUT, now - 3 * HOUR, text.checkout, text.checkoutReply, { largeOutput: 400_000, found: 120_000 }),
	];
	if (split) {
		const others = claudeSessions.filter((s) => ![CHECKOUT, MIGRATION, TERRAFORM, WEBHOOKS].includes(s.id));
		for (let i = 0; i < 90; i++) {
			const owner = others[i % others.length] ?? claudeSessions[0];
			const prompt = `${text.filler} `.repeat(5).trim().slice(0, 600);
			tasks.push(task(`t-f${String(i).padStart(9, "0")}`, owner.id, now - 29 * HOUR + i * 1_100, [prompt, prompt], text.fillerReply, {}));
		}
	}
	tasks.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
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
				baselines: { window_days: 14, inputs: 318, starts: 126, L_med: 40.9, L1_med: 35.9, C_med: 9, disabled: [] },
				limits: { truncated: false, reason: null, collisions: 0, disabled: [], sessions_read: claudeSessions.length },
				panes: [
					{
						key: "claude", agent: "claude", provider: "anthropic", model: null, models: [], local: false,
						sessions: sessionsOut.length, w: totals.w, totals, breakdown, hits: hits.map((h) => h.id),
						digest: {
							agent: "claude",
							context: {
								range: { ...range, windows: undefined }, totals,
								baselines: { L_med: 40.9, L1_med: 35.9, C_med: 9, disabled: [] },
								instructions: [{ file: "…/storefront/CLAUDE.md", type: "Project", bytes: 6_400, lines: 120 }],
								skills: 64, preamble_usual: 52_000,
							},
							sessions: sessionsOut.map((s) => ({ id: s.id, name: s.name, folder: s.folder, preamble: 56_000, tasks: tasks.filter((t) => t.session === s.id).length })),
							tasks: tasks.filter((t) => sessionsOut.some((s) => s.id === t.session)),
							hints: hits.map((h) => ({ id: h.id, detector: h.detector, session: h.session, task: h.task, metrics: h.metrics, targets: h.shown_targets })),
						},
					},
				],
			},
		},
	};
}

/** The issues the stand-in `claude` reports, by check (`found`: a list), each citing the tasks it
 * was found in. The stand-in keeps, for each request, the issues whose tasks that request sent. */
export function efficiencyReply(lang) {
	const text = TEXT[lang] ?? TEXT.en;
	const r = text.reply;
	const issue = (evidence, title, observed, cause, fix, quotes = [], action = { kind: "none" }) => ({
		verdict: "issue", title, observed, cause, fix, evidence, quotes, action,
	});
	return {
		rework: issue(["t-mig0000001"], r.e16Title, r.e16Observed, "user_prompt", r.e16Fix, [{ ref: "t-mig0000001.p3", text: text.migration[2] }], { kind: "template" }),
		largeOutput: issue(["t-chk0000001"], r.e01Title, r.e01Observed, "agent_behavior", r.e01Fix, [{ ref: "t-chk0000001.p1", text: text.checkout[0] }], {
			kind: "agent",
			draft: r.e01Draft,
		}),
		cacheRebuild: issue(["t-inf0000001"], r.e04Title, r.e04Observed, "habit", r.e04Fix),
		found: [
			issue(["t-hook000001"], r.pollTitle, r.pollObserved, "agent_behavior", r.pollFix, [{ ref: "t-hook000001.p1", text: text.hooks[0].slice(0, 120) }]),
			issue(["t-chk0000001"], r.lintTitle, r.lintObserved, "habit", r.lintFix),
		],
	};
}
