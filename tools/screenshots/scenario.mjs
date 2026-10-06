// The made-up workspace the screenshots show: sessions, their states, and usage numbers.
// Every time is relative to the moment of the run, so "just now" / "12 min ago" and the
// rate-limit countdowns always read naturally. Edit this file to change what the images show.

export const HOME_DISPLAY = "/Users/demo";

/**
 * `registry` is Claude Code's own status (`busy`, `shell`, `waiting`, `idle`) as it would appear
 * in `~/.claude/sessions/<pid>.json`; Codex has no such ledger, so a Codex tab's state comes from
 * its terminal title instead (`title` below). `daemon`: the session is running in the daemon.
 * `tab`: opened as a terminal tab, in this order. `flipToIdle`: starts `busy` and turns `idle`
 * while in the background, which is what makes a tab "Needs review" and raises the idle notice.
 * `goal`: the session's `/goal` as `json scan` reports it (`sinceMinutesAgo` instead of `since`).
 */
export const SESSIONS = [
	{
		id: "5f0c8a4e-3b1d-4f6a-9c2e-7d8b1a0e4c11",
		agent: "claude",
		name: "Storefront: Checkout total flicker",
		project: "storefront",
		minutesAgo: 0,
		model: "Opus 5.5",
		effort: "high",
		registry: "busy",
		daemon: true,
		tab: true,
		rc: true,
		ctx: 46,
		goal: {
			condition: "Every checkout test passes and the coupon total never flashes a stale value.",
			met: false,
			reason: "The fix is in, but the full checkout suite is still running.",
			sinceMinutesAgo: 40,
		},
		transcript: "claude-checkout",
		detail: {
			last_user: "The checkout page flashes the old total after a coupon is applied. Fix it and add a regression test.",
			last_assistant: "The total came from a memo that ignored the coupon. I fixed the dependency list and added a test; running the full checkout suite now.",
		},
		usage: { input: 182_000, output: 96_000, cache_read: 7_400_000, cache_create: 610_000, cost: 6.42 },
		// The turns "Session analytics" lists: minutes after the first prompt, how long the turn ran,
		// its share of the session's tokens and cost, and its tool calls. The last prompt is the
		// session's latest one.
		turns: [
			{ at: 0, minutes: 5, share: 0.03, tools: { Read: 11, Grep: 5, Glob: 3 }, prompt: "Read src/checkout and explain how the order total is computed." },
			{ at: 9, minutes: 6, share: 0.045, tools: { Bash: 4, Read: 2 }, prompt: "Run the checkout tests and list the ones that fail." },
			{ at: 18, minutes: 4, share: 0.02, tools: { Read: 3 }, prompt: "Why does the cart test time out only in CI?" },
			{ at: 25, minutes: 9, share: 0.055, tools: { Edit: 3, Bash: 3, Read: 2 }, prompt: "Give that test a fake clock instead of a real timer." },
			{ at: 38, minutes: 24, share: 0.15, tools: { Read: 8, Edit: 14, Write: 2, Bash: 3, TodoWrite: 2 }, prompt: "Move the coupon rules into their own module, keeping the same behavior." },
			{ at: 65, minutes: 3, share: 0.012, tools: {}, prompt: "Keep the old export as an alias for now." },
			{ at: 70, minutes: 11, share: 0.07, tools: { Bash: 3, Edit: 5, Read: 3 }, prompt: "Update the snapshot tests for the new module layout." },
			{ at: 84, minutes: 2, share: 0.008, tools: {}, prompt: "/compact" },
			{ at: 88, minutes: 7, share: 0.038, tools: { Grep: 4, Read: 5 }, prompt: "Where else is the order total formatted?" },
			{ at: 97, minutes: 8, share: 0.05, tools: { Edit: 4, Bash: 2 }, prompt: "Use one formatter for every currency amount on the page." },
			{ at: 109, minutes: 5, share: 0.028, tools: { Read: 4, Bash: 1 }, prompt: "Check the order summary in the confirmation email too." },
			{ at: 118, minutes: 13, share: 0.08, tools: { Read: 4, Edit: 6, Bash: 3 }, prompt: "Add a loading state to the total while the coupon is checked." },
			{ at: 134, minutes: 6, share: 0.034, tools: { Bash: 4 }, prompt: "Run the full checkout suite and the type check." },
			{ at: 143, minutes: 35, share: 0.38, tools: { Read: 6, Edit: 4, Grep: 2, Bash: 5, Write: 1, TodoWrite: 1 }, prompt: "The checkout page flashes the old total after a coupon is applied. Fix it and add a regression test." },
		],
		cost5h: 4.1,
		cost7d: 6.42,
	},
	{
		id: "0199a3c2-7e41-7b52-a3f0-5c9d2e81b604",
		agent: "codex",
		name: "API: Rate limiter tests",
		project: "billing-api",
		minutesAgo: 1,
		model: "gpt-5.5",
		effort: "high",
		daemon: true,
		tab: true,
		title: "[ ! ] Action Required · billing-api",
		transcript: "codex-limiter",
		detail: {
			last_user: "Add tests for the token-bucket rate limiter, including the burst case.",
			last_assistant: "I added table-driven tests for refill, burst and concurrent access. Want me to run them with the race detector?",
		},
		usage: { input: 1_240_000, output: 58_000, cache_read: 3_100_000, cache_create: 0, cost: 2.87 },
		cost5h: 2.1,
		cost7d: 2.87,
	},
	{
		id: "8e2b6d17-4c90-4a3e-b5f1-2a7c9e0d3f58",
		agent: "claude",
		name: "Docs: Migration guide",
		project: "docs-site",
		minutesAgo: 3,
		model: "Sonnet 5",
		effort: "medium",
		registry: "busy",
		flipToIdle: true,
		daemon: true,
		tab: true,
		ctx: 31,
		goal: {
			condition: "A one-page v3 → v4 migration guide covering every breaking change.",
			met: true,
			reason: "docs/migrate-to-v4.md covers all three breaking changes with before/after snippets.",
			sinceMinutesAgo: 25,
		},
		transcript: "claude-docs",
		detail: {
			last_user: "Draft the v3 → v4 migration guide from the changelog. Keep it to one page.",
			last_assistant: "Done: docs/migrate-to-v4.md covers the three breaking changes with before/after snippets.",
		},
		usage: { input: 64_000, output: 41_000, cache_read: 2_200_000, cache_create: 240_000, cost: 1.36 },
		cost5h: 1.36,
		cost7d: 1.36,
	},
	{
		id: "c41d9f02-6a3b-4e8c-9d7f-1b5e2a8c0f93",
		agent: "claude",
		name: "Infra: Terraform cleanup",
		project: "infra",
		minutesAgo: 9,
		model: "Opus 5.5",
		effort: "medium",
		registry: "idle",
		daemon: true,
		tab: true,
		compacted: true,
		ctx: 8,
		transcript: "claude-infra",
		detail: {
			last_command: "/compact",
			last_user: "Remove the unused staging buckets and their IAM bindings.",
			last_assistant: "Plan shows 6 resources to destroy, all under modules/staging-legacy. Nothing else changes.",
		},
		usage: { input: 410_000, output: 122_000, cache_read: 11_800_000, cache_create: 930_000, cost: 9.75 },
		cost5h: 3.2,
		cost7d: 9.75,
	},
	{
		id: "0199a3b7-2d15-7c08-8e64-f3a1b9c47d20",
		agent: "codex",
		name: "Mobile: Offline sync",
		project: "mobile-app",
		minutesAgo: 16,
		model: "gpt-5.5",
		effort: "medium",
		daemon: true,
		tab: true,
		title: "mobile-app",
		transcript: "codex-sync",
		detail: {
			last_user: "Queue writes while offline and replay them in order when the connection comes back.",
			last_assistant: "Writes now go through an outbox table; replay is ordered by sequence and idempotent per request id.",
		},
		usage: { input: 2_050_000, output: 97_000, cache_read: 5_600_000, cache_create: 0, cost: 4.52 },
		cost5h: 1.9,
		cost7d: 4.52,
	},
	{
		id: "3a7e5c90-1f2d-4b6a-8c3e-9d0f4a2b7e65",
		agent: "claude",
		name: "API: Webhook retries",
		project: "billing-api",
		minutesAgo: 0,
		model: "Sonnet 5",
		effort: "high",
		registry: "shell",
		daemon: true,
		rc: true,
		ctx: 57,
		detail: {
			last_user: "Retry failed webhooks with exponential backoff and a dead-letter queue.",
			last_assistant: "Running the integration suite against the local queue…",
		},
		usage: { input: 150_000, output: 88_000, cache_read: 5_900_000, cache_create: 420_000, cost: 3.94 },
		cost5h: 3.94,
		cost7d: 3.94,
	},
	{
		id: "b95f1e28-7d4c-4a0b-9e6f-3c2a8d5b1f07",
		agent: "claude",
		name: "Research: Vector search spike",
		project: "search",
		minutesAgo: 4,
		model: "Opus 5.5",
		effort: "high",
		registry: "waiting",
		waitingFor: "permission prompt",
		daemon: true,
		ctx: 22,
		detail: {
			last_user: "Compare pgvector and a hosted index on our 2M-document sample. Latency and recall at k=10.",
			last_assistant: "I need permission to start the benchmark container (docker compose up bench).",
		},
		usage: { input: 96_000, output: 52_000, cache_read: 3_300_000, cache_create: 280_000, cost: 2.61 },
		cost5h: 2.61,
		cost7d: 2.61,
	},
	{
		id: "0199a2f4-9b63-7a1e-b0c8-4e7d2f5a9c31",
		agent: "codex",
		name: "Storefront: Image pipeline",
		project: "storefront",
		minutesAgo: 38,
		model: "gpt-5.5",
		effort: "medium",
		daemon: true,
		detail: {
			last_user: "Serve AVIF with a WebP fallback and cache the resized variants.",
			last_assistant: "Variants are generated on first request and cached under /img/cache with a content hash.",
		},
		usage: { input: 880_000, output: 41_000, cache_read: 2_400_000, cache_create: 0, cost: 1.98 },
		cost5h: 0.6,
		cost7d: 1.98,
	},
	{
		id: "0199a1d0-4f82-7e39-a5b1-8c6e0d3f2a74",
		agent: "codex",
		name: "Docs: API reference",
		project: "docs-site",
		minutesAgo: 60 * 5,
		model: "gpt-5.5",
		effort: "low",
		detail: {
			last_user: "Generate reference pages for the v4 endpoints from the OpenAPI spec.",
			last_assistant: "42 endpoint pages generated; the sidebar groups them by resource.",
		},
		usage: { input: 640_000, output: 36_000, cache_read: 1_900_000, cache_create: 0, cost: 1.44 },
		cost7d: 1.44,
	},
	{
		id: "e6c2a0f9-5b8d-4d31-a7e4-0f9b3c6d2e18",
		agent: "claude",
		name: "Mobile: Push notifications",
		project: "mobile-app",
		minutesAgo: 60 * 26,
		model: "Sonnet 5",
		effort: "medium",
		detail: {
			last_user: "Group push notifications per conversation on Android.",
			last_assistant: "Notifications now use a per-conversation group key with a summary notification.",
		},
		usage: { input: 120_000, output: 70_000, cache_read: 4_100_000, cache_create: 350_000, cost: 3.05 },
		cost7d: 3.05,
	},
	{
		id: "7d4b1c83-2e6f-4a9d-8b05-6c3f9a1e0d42",
		agent: "claude",
		name: "Infra: CI cache",
		project: "infra",
		minutesAgo: 60 * 3,
		model: "Opus 5.5",
		effort: "medium",
		daemon: true,
		exited: 0,
		detail: {
			last_user: "Cut CI time by caching the dependency install between jobs.",
			last_assistant: "Cache keyed on the lockfile hash; median pipeline time went from 14m to 6m.",
		},
		usage: { input: 210_000, output: 64_000, cache_read: 6_700_000, cache_create: 510_000, cost: 4.87 },
		cost7d: 4.87,
	},
	{
		id: "0199a0b8-1c47-7f25-9d3a-2b8e6f0c4a59",
		agent: "codex",
		name: "Storefront: Dark mode",
		project: "storefront",
		minutesAgo: 60 * 50,
		model: "gpt-5.5",
		effort: "medium",
		archived: true,
		detail: {
			last_user: "Add a dark theme that follows the system setting.",
			last_assistant: "Theme tokens are split into light/dark sets and switched with prefers-color-scheme.",
		},
		usage: { input: 520_000, output: 30_000, cache_read: 1_500_000, cache_create: 0, cost: 1.12 },
		cost7d: 1.12,
	},
];

/** Account-wide rate-limit usage (percent) and where each window stands. */
export const LIMITS = {
	claude: { fiveHour: { used: 38, elapsedHours: 2.6 }, sevenDay: { used: 61, elapsedDays: 4.4 } },
	codex: { fiveHour: { used: 24, elapsedHours: 1.9 }, sevenDay: { used: 47, elapsedDays: 3.1 } },
};

/** A few ordinary notes so the vault isn't empty. */
export const NOTES = {
	"Welcome.md": "# Welcome\n\nNotes for the storefront, billing API, and mobile app projects.\n",
	"Projects/Storefront.md": "# Storefront\n\n- Checkout total flicker\n- Image pipeline\n",
	"Projects/Billing API.md": "# Billing API\n\n- Rate limiter tests\n- Webhook retries\n",
};

export function cwdOf(session) {
	return `${HOME_DISPLAY}/code/${session.project}`;
}

/**
 * What the stand-in `claude` answers when "Organize names and categories" asks for suggestions.
 * Ids are the sessions above; "Reliability" is a category no session has yet. `ORGANIZE_COMMENT`
 * is typed into the row that gets unticked.
 */
export const ORGANIZE_SUGGESTIONS = [
	{
		id: "5f0c8a4e-3b1d-4f6a-9c2e-7d8b1a0e4c11",
		category: "Storefront",
		name: "Stale coupon total in checkout",
		reason: "Fixed a memo that ignored the coupon, so the checkout total no longer flashes the old amount.",
	},
	{
		id: "8e2b6d17-4c90-4a3e-b5f1-2a7c9e0d3f58",
		category: "Docs",
		name: "v4 migration guide",
		reason: "One-page v3 to v4 guide covering the three breaking changes with before/after snippets.",
	},
	{
		id: "3a7e5c90-1f2d-4b6a-8c3e-9d0f4a2b7e65",
		category: "Reliability",
		name: "Webhook retries with backoff",
		reason: "Retries failed webhooks with exponential backoff and a dead-letter queue.",
	},
	{
		id: "c41d9f02-6a3b-4e8c-9d7f-1b5e2a8c0f93",
		category: "Infra",
		name: "Remove staging buckets",
		reason: "Destroys six unused staging resources and their IAM bindings under modules/staging-legacy.",
	},
	{
		id: "b95f1e28-7d4c-4a0b-9e6f-3c2a8d5b1f07",
		category: "Research",
		name: "Vector index benchmark",
		reason: "Comparing pgvector and a hosted index on a 2M-document sample: latency and recall at k=10.",
	},
];
export const ORGANIZE_COMMENT = "Name it after the two systems being compared";

/**
 * The scenario in `lang`: English is the one above; Japanese swaps the words (names, last
 * exchange, notes, organize suggestions) and keeps every number and state.
 */
export async function scenarioFor(lang) {
	if (lang !== "ja") {
		return {
			sessions: SESSIONS,
			notes: NOTES,
			suggestions: ORGANIZE_SUGGESTIONS,
			comment: ORGANIZE_COMMENT,
			organizeCategory: "Vector search",
			newSessionName: "Docs: Release notes",
			editorDraft: "Please write the v4.2 release notes from the merged pull requests.\n\n- Group them as features, fixes and breaking changes\n- Keep each line to one sentence\n- Link the pull request after each line\n",
		};
	}
	const ja = await import("./scenario-ja.mjs");
	return {
		sessions: SESSIONS.map((s) => {
			const text = ja.SESSION_TEXT_JA[s.id];
			return {
				...s,
				name: text.name,
				detail: { ...s.detail, last_user: text.last_user, last_assistant: text.last_assistant },
				...(s.goal ? { goal: { ...s.goal, ...text.goal } } : {}),
				...(s.turns ? { turns: s.turns.map((turn, i) => ({ ...turn, prompt: text.prompts[i] })) } : {}),
			};
		}),
		notes: ja.NOTES_JA,
		suggestions: ja.ORGANIZE_SUGGESTIONS_JA,
		comment: ja.ORGANIZE_COMMENT_JA,
		organizeCategory: "ベクトル",
		newSessionName: "ドキュメント: リリースノート",
		editorDraft: "マージ済みのプルリクエストから、v4.2 のリリースノートを書いてください。\n\n- 新機能・修正・破壊的変更に分ける\n- 各行は1文にする\n- 行の最後にプルリクエストへのリンクを付ける\n",
	};
}
