import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../../src/i18n";
import type { EffAgent, EffExcerpt, EffHit } from "../../src/sessions/efficiency";
import {
	allowedActions,
	checkOf,
	checkPayload,
	checkPrompt,
	CHECKS,
	mergeCheckReply,
	planChecks,
	retryPrompt,
	runCheck,
	type CheckPlan,
} from "../../src/sessions/efficiency-checks";

afterEach(() => setLang("en"));

function hit(over: Partial<EffHit> & { id: string; detector: string }): EffHit {
	return {
		session: "s1",
		task: "t-aaaa",
		ts: 1_000,
		metrics: {},
		impact_w: 1000,
		impact_usd: 0.5,
		saving_rate: 0.5,
		confidence: "high",
		needs_llm: false,
		remedy_kind: "habit",
		change: null,
		targets: [],
		shown_targets: [],
		...over,
	};
}

const E01 = hit({
	id: "h-e01",
	detector: "E01",
	impact_w: 50_000,
	impact_usd: 2,
	saving_rate: 0.8,
	metrics: { est_tokens: 12_000, reads_after: 40 },
	remedy_kind: "fix",
	change: "add",
	targets: ["/home/pat/vault/CLAUDE.md"],
	shown_targets: ["CLAUDE.md"],
});
const E16 = hit({ id: "h-e16", detector: "E16", task: "t-bbbb", impact_w: 30_000, needs_llm: true, metrics: { corrections: 2, calls: 120, calls_ratio: 3.1 } });
const E16B = hit({ id: "h-e16b", detector: "E16", session: "s2", task: "t-dddd", impact_w: 8_000, needs_llm: true, metrics: { corrections: 3, calls: 60, calls_ratio: 2.4 } });
const E04 = hit({ id: "h-e04", detector: "E04", task: null, impact_w: 9_000, metrics: { gap: 7200, cache_write: 4_000 } });
const E05 = hit({ id: "h-e05", detector: "E05", task: null, impact_w: 3_000, metrics: { from: "opus", to: "sonnet", cache_write: 2_000 } });

function excerpt(task: string, session: string, prompts: [string, string][]): EffExcerpt {
	return {
		task,
		session,
		provider: "anthropic",
		w: 60_000,
		calls: 120,
		impact_w: 30_000,
		prompts: prompts.map(([ref, text]) => ({ ref, text })),
		replies: [],
		tools: [],
	};
}

const BLOCK = {
	hits: [E01, E16, E16B, E04, E05],
	excerpts: [
		excerpt("t-aaaa", "s1", [["t-aaaa.p1", "Run the whole test suite and show me everything."]]),
		excerpt("t-bbbb", "s1", [
			["t-bbbb.p1", "Fix the login redirect."],
			["t-bbbb.p2", "still wrong, same as before"],
		]),
		excerpt("t-dddd", "s2", [["t-dddd.p1", "Sort the settings list."]]),
	],
	summary: {
		totals: { w: 2_400_000, calls: 900 },
		tasks: [{ id: "t-aaaa" }, { id: "t-bbbb" }, { id: "t-dddd" }],
		sessions: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
		hits: [],
	},
	baselines: { disabled: [] as string[] },
	totals: { calls: 900 },
	sessions: [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }],
} as unknown as EffAgent;

function planOf(id: string, block: EffAgent = BLOCK): CheckPlan {
	return planChecks(block).find((p) => p.check.id === id) as CheckPlan;
}

function reply(value: unknown): string {
	return "```json\n" + JSON.stringify(value) + "\n```";
}

describe("the eight checks", () => {
	it("are the checks of the dialog, in its order, each backed by real detectors", () => {
		expect(CHECKS.map((c) => c.id)).toEqual([
			"rework",
			"firstRequest",
			"mixedTasks",
			"longContext",
			"largeOutput",
			"cacheRebuild",
			"repeatedLookups",
			"startupSize",
		]);
		expect(CHECKS.map((c) => c.detectors.join("+"))).toEqual(["E16", "E17", "E03", "E02", "E01", "E04+E05", "E08", "E14"]);
		expect(CHECKS.filter((c) => c.template).map((c) => c.id)).toEqual(["rework", "firstRequest"]);
	});

	it("settle without the model: no hit is no issues, a disabled detector or too little data is not applicable", () => {
		const outcomes = (block: EffAgent): string[] => planChecks(block).map((p) => p.outcome);
		expect(outcomes(BLOCK)).toEqual(["model", "ok", "ok", "ok", "model", "model", "ok", "ok"]);
		const disabled = { ...BLOCK, baselines: { disabled: ["rework_short", "E16", "E17"] } } as unknown as EffAgent;
		expect(outcomes(disabled).slice(0, 2)).toEqual(["na", "na"]);
		const few = { ...BLOCK, sessions: [{ id: "s1" }] } as unknown as EffAgent;
		expect(outcomes(few).slice(6)).toEqual(["na", "na"]);
		const none = { ...BLOCK, hits: [], totals: { calls: 0 } } as unknown as EffAgent;
		expect(outcomes(none)).toEqual(Array(8).fill("na"));
		expect(planOf("cacheRebuild").hits.map((h) => h.id)).toEqual(["h-e04", "h-e05"]);
	});

	it("offer an agent's change only when the statistics name one, and a template for how requests are written", () => {
		expect(allowedActions(planOf("largeOutput"))).toEqual(["agent", "none"]);
		expect(allowedActions(planOf("rework"))).toEqual(["template", "none"]);
		expect(allowedActions(planOf("cacheRebuild"))).toEqual(["none"]);
	});
});

describe("a check's request", () => {
	it("sends only the check's hits, the tasks and sessions behind them, and their excerpts", () => {
		const payload = checkPayload(BLOCK, planOf("rework"));
		const data = JSON.parse(payload.data);
		expect(data.statistics.check).toBe("rework");
		expect(data.statistics.hits.map((h: { id: string }) => h.id)).toEqual(["h-e16", "h-e16b"]);
		expect(data.statistics.hits[0].targets).toEqual([]);
		expect(data.statistics.tasks).toEqual([{ id: "t-bbbb" }, { id: "t-dddd" }]);
		expect(data.statistics.sessions).toEqual([{ id: "s1" }, { id: "s2" }]);
		expect(data.statistics.totals).toEqual({ w: 2_400_000, calls: 900 });
		expect(data.excerpts.map((e: EffExcerpt) => e.task)).toEqual(["t-bbbb", "t-dddd"]);
		expect(payload.sessions).toBe(2);
		expect(payload.sources.get("t-bbbb.p2")).toBe("still wrong, same as before");
		expect(payload.sources.has("t-aaaa.p1")).toBe(false);
	});

	it("names the check, the meaning checks, the data, the allowed actions and the language", () => {
		const plan = planOf("rework");
		const prompt = checkPrompt(checkPayload(BLOCK, plan), allowedActions(plan), "ja");
		expect(prompt).toContain(`This check: ${checkOf("rework")?.focus}.`);
		expect(prompt).toContain("whatever language they are in");
		expect(prompt).toContain("only scolds");
		expect(prompt).toContain("recommend /clear");
		expect(prompt).toContain("start a new conversation in a new tab");
		expect(prompt).toMatch(/<<<DATA\n\{"statistics":.*\}\nDATA>>>/);
		expect(prompt).toContain('"kind": "template | none"');
		expect(prompt).toContain('{"verdict": "ok"');
		expect(prompt).toContain("Write title, observed, fix, draft and reason in Japanese.");
		expect(retryPrompt("P", "bad JSON")).toContain("could not be used (bad JSON)");
	});
});

describe("a check's reply", () => {
	const rework = planOf("rework");
	const payload = checkPayload(BLOCK, rework);
	const actions = allowedActions(rework);
	const GOOD = {
		verdict: "issue",
		hits: ["h-e16"],
		title: "The redirect was corrected again and again",
		observed: "The same point was corrected over 120 calls.",
		cause: "user_prompt",
		fix: "Say the expected result and how to check it first.",
		savingTokens: 12_000,
		excerpts: [{ ref: "t-bbbb.p2", text: "still wrong" }],
		action: { kind: "template" },
	};

	it("ok is no issues", () => {
		expect(mergeCheckReply(reply({ verdict: "ok", reason: "follow-ups" }), payload, actions).finding).toBeNull();
	});

	it("keeps a well-formed issue, with the impact and saving from the statistics' side", () => {
		const { finding, notes } = mergeCheckReply(reply(GOOD), payload, actions);
		expect(notes).toEqual([]);
		expect(finding).toMatchObject({
			check: "rework",
			hits: ["h-e16"],
			title: GOOD.title,
			observed: GOOD.observed,
			cause: "user_prompt",
			fix: GOOD.fix,
			quotes: [{ ref: "t-bbbb.p2", text: "still wrong" }],
			action: "template",
			impactW: 30_000,
			savingW: 12_000,
			fromStats: false,
		});
	});

	it("covers every hit sent when it names none it may, and drops unknown ids", () => {
		const { finding, notes } = mergeCheckReply(reply({ ...GOOD, hits: ["h-nope"] }), payload, actions);
		expect(finding?.hits).toEqual(["h-e16", "h-e16b"]);
		expect(notes[0]).toContain("h-nope");
	});

	it("removes quotes that were not sent, are not in that prompt, or belong to another task", () => {
		const { finding, notes } = mergeCheckReply(
			reply({
				...GOOD,
				excerpts: [
					{ ref: "t-bbbb.p2", text: "still   wrong" },
					{ ref: "t-bbbb.p1", text: "not in the prompt" },
					{ ref: "t-aaaa.p1", text: "show me everything" },
					{ ref: "t-dddd.p1", text: "Sort the settings list." },
				],
			}),
			payload,
			actions
		);
		expect(finding?.quotes).toEqual([{ ref: "t-bbbb.p2", text: "still   wrong" }]);
		expect(notes).toHaveLength(3);
	});

	it("replaces sentences with numbers the statistics don't have, and text that mentions /clear", () => {
		const { finding } = mergeCheckReply(
			reply({ ...GOOD, observed: "It took 9,876 calls.", fix: "Run /clear and start again." }),
			payload,
			actions
		);
		expect(finding?.observed).toBe(t("efficiency.detector.E16.cause", { corrections: 2, calls: 120, ratio: "3.1" }));
		expect(finding?.fix).toBe(t("efficiency.detector.E16.remedy"));
	});

	it("keeps the cause to the four kinds, the action to the allowed ones, the saving to the impact", () => {
		const { finding, notes } = mergeCheckReply(reply({ ...GOOD, cause: "user", action: { kind: "agent", draft: "x" }, savingTokens: 10_000_000 }), payload, actions);
		expect(finding?.cause).toBe("user_prompt");
		expect(finding?.action).toBe("none");
		expect(finding?.draft).toBe("");
		expect(finding?.savingW).toBe(15_000);
		expect(notes).toContain("action agent is not allowed for this check");
	});

	it("an agent's change keeps the statistics' change kind and targets, whatever the reply says", () => {
		const plan = planOf("largeOutput");
		const { finding } = mergeCheckReply(
			reply({ verdict: "issue", hits: ["h-e01"], title: "Output stays", observed: "", cause: "config", fix: "Add a rule.", action: { kind: "agent", draft: "- Only failures." } }),
			checkPayload(BLOCK, plan),
			allowedActions(plan)
		);
		expect(finding).toMatchObject({ action: "agent", change: "add", targets: ["/home/pat/vault/CLAUDE.md"], draft: "- Only failures." });
		expect(finding?.observed).toBe(t("efficiency.detector.E01.cause", { tokens: "12.0k", reads: 40 }));
	});

	it("throws a shape error for a reply without a verdict", () => {
		expect(() => mergeCheckReply("I think it is fine.", payload, actions)).toThrow(/verdict/);
		expect(() => mergeCheckReply(reply({ findings: [] }), payload, actions)).toThrow(/verdict/);
	});
});

describe("runCheck", () => {
	const plan = planOf("rework");
	const payload = checkPayload(BLOCK, plan);
	const actions = allowedActions(plan);
	const usage = { input: 100, output: 10, usd: 0.01 };

	it("asks once more after an unreadable reply and adds both usages", async () => {
		const prompts: string[] = [];
		const replies = ["nope", reply({ verdict: "ok" })];
		const run = await runCheck("P", payload, actions, async (p) => {
			prompts.push(p);
			return { text: replies[prompts.length - 1], usage };
		});
		expect(run.finding).toBeNull();
		expect(run.retried).toMatch(/verdict/);
		expect(prompts[1]).toContain("could not be used");
		expect(run.usage).toMatchObject({ input: 200, output: 20 });
	});

	it("falls back to the statistics' own issue after the second unreadable reply", async () => {
		const run = await runCheck("P", payload, actions, async () => ({ text: "nope", usage: null }));
		expect(run.finding).toMatchObject({ check: "rework", fromStats: true, action: "template", hits: ["h-e16", "h-e16b"] });
	});

	it("lets the asker's own errors through", async () => {
		await expect(runCheck("P", payload, actions, async () => Promise.reject(new Error("timed out")))).rejects.toThrow("timed out");
	});
});
