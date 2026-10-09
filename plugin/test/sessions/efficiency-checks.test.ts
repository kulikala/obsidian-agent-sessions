import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import { ReplyShapeError, type Digest, type DigestTask, type EffHit, type Finding } from "../../src/sessions/efficiency";
import {
	CHECKS,
	MAX_FOUND,
	MAX_REQUEST_CHARS,
	MAX_REQUESTS,
	UnreadableReplyError,
	analysisPrompt,
	mergeOutcomes,
	notApplicable,
	parseReply,
	planRequests,
	readContext,
	readReply,
	requestSetup,
	runPart,
	type CheckId,
	type PartOutcome,
} from "../../src/sessions/efficiency-checks";

afterEach(() => setLang("en"));

const ALL_CHECKS: CheckId[] = [
	"rework",
	"firstRequest",
	"mixedTasks",
	"longContext",
	"largeOutput",
	"cacheRebuild",
	"repeatedLookups",
	"startupSize",
	"found",
];

/** Each check's saving for a task: `n` times the check's position (1-9). */
function saving(n: number): Record<string, number> {
	return Object.fromEntries(ALL_CHECKS.map((c, i) => [c, n * (i + 1)]));
}

function task(id: string, session: string, ts: number, over: Partial<DigestTask> = {}): DigestTask {
	return {
		id,
		session,
		at: "2026-10-01T10:00",
		ts,
		w: 10_000,
		calls: 12,
		start_ctx: 30_000,
		end_ctx: 60_000,
		turn_count: 2,
		turns: [
			{
				ref: `${id}.p1`,
				prompt: `Fix the parser in ${id}, then run the tests`,
				reply: "Fixed the parser; 4 tests pass.",
				reply_ref: `${id}.r1`,
				w: 6_000,
				calls: 7,
				tools: { read: 2, edit: 1 },
			},
			{ ref: `${id}.p2`, prompt: "Still wrong: the header is dropped", reply: "Kept the header.", reply_ref: `${id}.r2`, w: 4_000, calls: 5, rework: [1] },
		],
		saving: saving(100),
		...over,
	};
}

function digest(tasks: DigestTask[], over: Partial<Digest> = {}): Digest {
	const sessions = [...new Set(tasks.map((t) => t.session))].map((id) => ({ id, name: `Docs: ${id}`, folder: "notes", preamble: 20_000, tasks: 1 }));
	return {
		agent: "claude",
		context: { range: { start: 0, end: 1 }, totals: { w: 1_234_567 } },
		sessions,
		tasks,
		hints: [],
		...over,
	};
}

function hit(over: Partial<EffHit> & { id: string; detector: string }): EffHit {
	return {
		session: "s1",
		task: "t-a",
		ts: 1,
		metrics: {},
		impact_w: 1000,
		impact_usd: null,
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

const TOTALS = { cache_read: 1000, cache_write: 1000 };

function setupOf(d: Digest, hits: EffHit[] = []) {
	const setup = requestSetup(d, TOTALS, hits, "en");
	return { setup, ctx: readContext(setup, hits), plan: planRequests(setup) };
}

function ok(): Record<string, unknown> {
	return Object.fromEntries(ALL_CHECKS.filter((c) => c !== "found").map((c) => [c, { verdict: "ok" }]));
}

function issue(evidence: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		verdict: "issue",
		title: "The same fix was asked for twice",
		observed: "The header was fixed again after the first fix dropped it.",
		cause: "agent_behavior",
		fix: "Name the expected output in the first request.",
		evidence,
		quotes: [],
		action: { kind: "none" },
		...over,
	};
}

function reply(checks: Record<string, unknown>): string {
	return JSON.stringify({ checks });
}

describe("the nine checks", () => {
	it("lists the eight areas, then the agent's own", () => {
		expect(CHECKS.map((c) => c.id)).toEqual(ALL_CHECKS);
		expect(CHECKS.filter((c) => c.template).map((c) => c.id)).toEqual(["rework", "firstRequest"]);
		expect(CHECKS.find((c) => c.id === "cacheRebuild")?.detectors).toEqual(["E04", "E05"]);
	});

	it("is not applicable only where the range lacks what a check is about", () => {
		const d = digest([task("t-a", "s1", 0), task("t-b", "s2", 10)]);
		expect([...notApplicable(d, TOTALS)]).toEqual([]);
		expect([...notApplicable(d, { cache_read: 0, cache_write: 0 })]).toEqual(["cacheRebuild"]);
		const single = digest([task("t-a", "s1", 0, { turn_count: 1, turns: [{ ref: "t-a.p1", prompt: "go", w: 1, calls: 1 }] })]);
		expect([...notApplicable(single, TOTALS)].sort()).toEqual(["largeOutput", "mixedTasks", "repeatedLookups", "rework"]);
		expect(notApplicable(digest([]), TOTALS).size).toBe(9);
		expect(notApplicable(undefined, TOTALS).size).toBe(9);
	});
});

describe("requests", () => {
	it("sends the whole digest in one request when it fits, without the plugin's own numbers", () => {
		const { plan } = setupOf(digest([task("t-a", "s1", 0), task("t-b", "s2", 10)]));
		expect(plan.parts).toHaveLength(1);
		expect(plan.omitted).toBe(0);
		const [part] = plan.parts;
		expect(part.prompt.length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
		expect(part.prompt).toContain("<<<DATA\n" + part.data + "\nDATA>>>");
		expect(part.prompt).not.toContain("This is part");
		const data = JSON.parse(part.data);
		expect(data.tasks.map((t: DigestTask) => t.id)).toEqual(["t-a", "t-b"]);
		expect(data.tasks[0]).not.toHaveProperty("saving");
		expect(data.tasks[0]).not.toHaveProperty("ts");
		expect(data).not.toHaveProperty("part");
		for (const check of ALL_CHECKS) {
			expect(part.prompt).toContain(`- ${check}: `);
		}
		expect(part.prompt).toContain('"found": [up to 3 issues');
		expect(plan.chars).toBe(part.prompt.length);
		expect(plan.sessions).toBe(2);
	});

	it("leaves the not-applicable checks out of the request", () => {
		const { setup, plan } = setupOf(digest([task("t-a", "s1", 0)]));
		expect(setup.na.has("repeatedLookups")).toBe(true);
		expect(plan.parts[0].prompt).not.toContain('"repeatedLookups"');
		expect(plan.parts[0].prompt).toContain('"rework"');
	});

	it("writes in the UI language", () => {
		const ja = requestSetup(digest([task("t-a", "s1", 0)]), TOTALS, [], "ja");
		expect(analysisPrompt(ja, { index: 0, count: 1 }, "{}")).toContain("in Japanese");
	});

	it("splits a large digest by period, every request within the limit, every task once", () => {
		const long = "x ".repeat(280);
		const tasks = Array.from({ length: 60 }, (_, i) =>
			task(`t-${String(i).padStart(3, "0")}`, `s${i % 7}`, i, {
				turns: Array.from({ length: 4 }, (_, j) => ({
					ref: `t-${i}.p${j + 1}`,
					prompt: long,
					reply: long.slice(0, 200),
					reply_ref: `t-${i}.r${j + 1}`,
					w: 100,
					calls: 3,
				})),
			})
		);
		const hints = [{ id: "h-1", detector: "E16", session: "s0", task: "t-000", metrics: {}, targets: [] }];
		const { plan } = setupOf(digest(tasks, { hints }));
		expect(plan.parts.length).toBeGreaterThan(1);
		expect(plan.parts.every((p) => p.prompt.length <= MAX_REQUEST_CHARS)).toBe(true);
		expect(plan.parts.flatMap((p) => p.tasks.map((t) => t.id))).toEqual(tasks.map((t) => t.id));
		expect(plan.parts.map((p) => [p.index, p.count])).toEqual(plan.parts.map((_, i) => [i, plan.parts.length]));
		expect(plan.parts[1].prompt).toContain(`This is part 2 of ${plan.parts.length}`);
		const first = JSON.parse(plan.parts[0].data);
		expect(first.part).toMatchObject({ index: 1, of: plan.parts.length });
		expect(first.hints.map((h: { id: string }) => h.id)).toEqual(["h-1"]);
		expect(JSON.parse(plan.parts[1].data).hints).toEqual([]);
		expect(plan.chars).toBe(plan.parts.reduce((n, p) => n + p.prompt.length, 0));
	});

	it("keeps to the most requests by shortening, then by leaving out the oldest tasks", () => {
		const long = "y ".repeat(300);
		const tasks = Array.from({ length: 400 }, (_, i) =>
			task(`t-${i}`, "s1", i, {
				turns: Array.from({ length: 6 }, (_, j) => ({ ref: `t-${i}.p${j + 1}`, prompt: long, w: 1, calls: 1 })),
			})
		);
		const { plan } = setupOf(digest(tasks));
		expect(plan.parts).toHaveLength(MAX_REQUESTS);
		expect(plan.omitted).toBeGreaterThan(0);
		expect(plan.parts.flatMap((p) => p.tasks.map((t) => t.id))).toEqual(tasks.slice(plan.omitted).map((t) => t.id));
		expect(plan.parts[0].tasks[0].turns[0].prompt?.length).toBeLessThanOrEqual(300);
	});

	it("cuts a task too large for one request down, keeping its first and last turns", () => {
		const huge = "z ".repeat(300);
		const big = task("t-big", "s1", 0, {
			turns: Array.from({ length: 200 }, (_, j) => ({ ref: `t-big.p${j + 1}`, prompt: huge, w: 1, calls: 1 })),
		});
		const { plan } = setupOf(digest([big]));
		expect(plan.parts).toHaveLength(1);
		const turns = plan.parts[0].tasks[0].turns;
		expect(turns.length).toBeLessThan(200);
		expect(turns[0].ref).toBe("t-big.p1");
		expect(turns[turns.length - 1].ref).toBe("t-big.p200");
		expect(plan.parts[0].prompt.length).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
	});
});

describe("reading a reply", () => {
	const d = digest([task("t-a", "s1", 0), task("t-b", "s2", 10)]);
	const fixHit = hit({ id: "h-e01", detector: "E01", task: "t-a", remedy_kind: "fix", change: "add", targets: ["/v/CLAUDE.md"] });
	const { setup, ctx, plan } = setupOf(d, [fixHit, hit({ id: "h-e16", detector: "E16", task: "t-b", session: "s2" })]);
	const part = plan.parts[0];

	it("needs a verdict for every check judged", () => {
		expect(() => parseReply("no json here", setup.na)).toThrow(ReplyShapeError);
		const missing = ok();
		delete missing.cacheRebuild;
		expect(() => parseReply(reply(missing), setup.na)).toThrow(/cacheRebuild/);
		expect(() => parseReply("Here it is:\n```json\n" + reply(ok()) + "\n```", setup.na)).not.toThrow();
	});

	it("all ok: no issues", () => {
		const out = readReply(reply(ok()), part, setup, ctx);
		expect(out.issues).toEqual({});
		expect(out.found).toEqual([]);
	});

	it("an issue keeps only the tasks that were sent, and its saving comes from them", () => {
		const out = readReply(reply({ ...ok(), rework: issue(["t-b", "t-zzz", "t-b"]) }), part, setup, ctx);
		const f = out.issues.rework;
		expect(f?.tasks).toEqual(["t-b"]);
		expect(f?.hits).toEqual(["h-e16"]);
		expect(f?.savingW).toBe(100);
		expect(f?.impactW).toBe(10_000);
		expect(out.notes.some((n) => n.includes("t-zzz"))).toBe(true);
	});

	it("an issue with no known task is dropped", () => {
		const out = readReply(reply({ ...ok(), rework: issue(["t-zzz"]), longContext: issue([]) }), part, setup, ctx);
		expect(out.issues).toEqual({});
	});

	it("ignores any saving the model writes", () => {
		const out = readReply(reply({ ...ok(), largeOutput: issue(["t-a"], { savingTokens: 9_999_999 }) }), part, setup, ctx);
		expect(out.issues.largeOutput?.savingW).toBe(500);
	});

	it("checks quotes, numbers, /clear, the cause and the action", () => {
		const out = readReply(
			reply({
				...ok(),
				largeOutput: issue(["t-a"], {
					observed: "Each call read 10,000 tokens again. It cost 777,777 tokens.",
					fix: "Run /clear after tests.",
					cause: "laziness",
					quotes: [
						{ ref: "t-a.p1", text: "Fix the parser in t-a" },
						{ ref: "t-a.p1", text: "words never said" },
						{ ref: "t-b.p1", text: "Fix the parser in t-b" },
					],
					action: { kind: "agent", draft: "- Show only failing lines." },
				}),
				rework: issue(["t-b"], { action: { kind: "agent" } }),
			}),
			part,
			setup,
			ctx
		);
		const f = out.issues.largeOutput;
		expect(f?.observed).toBe("Each call read 10,000 tokens again.");
		expect(f?.fix).toBe("");
		expect(f?.cause).toBe("agent_behavior");
		expect(f?.quotes).toEqual([{ ref: "t-a.p1", text: "Fix the parser in t-a" }]);
		expect([f?.action, f?.change, f?.targets, f?.draft]).toEqual(["agent", "add", ["/v/CLAUDE.md"], "- Show only failing lines."]);
		expect(out.issues.rework?.action).toBe("none");
	});

	it("drops an issue left with nothing to say", () => {
		const out = readReply(reply({ ...ok(), rework: issue(["t-b"], { observed: "It cost 777,777 tokens.", fix: "/clear" }) }), part, setup, ctx);
		expect(out.issues.rework).toBeUndefined();
	});

	it("keeps up to three issues the agent found on its own", () => {
		const found = [1, 2, 3, 4].map((n) => issue(["t-a"], { title: `Waste ${n}` }));
		const out = readReply(reply({ ...ok(), found }), part, setup, ctx);
		expect(out.found.map((f) => f.title)).toEqual(["Waste 1", "Waste 2", "Waste 3"]);
		expect(out.found[0].savingW).toBe(900);
		expect(MAX_FOUND).toBe(3);
	});
});

describe("putting parts together", () => {
	const d = digest([
		task("t-a", "s1", 0, { saving: saving(100) }),
		task("t-b", "s2", 10, { saving: saving(300) }),
		task("t-c", "s3", 20, { saving: saving(50) }),
	]);
	const { ctx } = setupOf(d);
	const finding = (check: CheckId, tasks: string[], title: string): Finding => ({
		check,
		tasks,
		hits: [],
		title,
		observed: title,
		cause: "habit",
		fix: "f",
		quotes: [],
		action: "none",
		change: null,
		targets: [],
		draft: "",
		sources: [],
		impactW: 0,
		impactUsd: null,
		savingW: tasks.reduce((n, id) => n + (ctx.tasks.get(id)?.saving[check] ?? 0), 0),
	});
	const outcome = (issues: PartOutcome["issues"], found: Finding[] = []): PartOutcome => ({ issues, found, notes: [] });

	it("an issue in any part is an issue: the text that saves most, every part's evidence, the saving again", () => {
		const merged = mergeOutcomes(
			[outcome({ rework: finding("rework", ["t-a"], "from part 1") }), outcome({ rework: finding("rework", ["t-b"], "from part 2") }), outcome({})],
			ctx
		);
		expect(merged.rework).toHaveLength(1);
		expect(merged.rework[0].title).toBe("from part 2");
		expect(merged.rework[0].tasks).toEqual(["t-b", "t-a"]);
		expect(merged.rework[0].savingW).toBe(400);
		expect(merged.longContext).toEqual([]);
	});

	it("on a tie, the earlier part's text", () => {
		const merged = mergeOutcomes([outcome({ mixedTasks: finding("mixedTasks", ["t-a"], "first") }), outcome({ mixedTasks: finding("mixedTasks", ["t-a"], "second") })], ctx);
		expect(merged.mixedTasks[0].title).toBe("first");
		expect(merged.mixedTasks[0].tasks).toEqual(["t-a"]);
	});

	it("keeps the three found issues that save the most", () => {
		const merged = mergeOutcomes(
			[outcome({}, [finding("found", ["t-a"], "a1"), finding("found", ["t-c"], "c1")]), outcome({}, [finding("found", ["t-b"], "b1"), finding("found", ["t-a"], "a2")])],
			ctx
		);
		expect(merged.found.map((f) => f.title)).toEqual(["b1", "a1", "a2"]);
	});
});

describe("one part, with its retry", () => {
	const { setup, ctx, plan } = setupOf(digest([task("t-a", "s1", 0)]));
	const part = plan.parts[0];

	it("asks again once with the error, adding up the usage", async () => {
		const prompts: string[] = [];
		const answers = ["not json", reply(ok())];
		const run = await runPart(part, setup, ctx, async (p) => {
			prompts.push(p);
			return { text: answers[prompts.length - 1], usage: { usd: 0.25, input: 10, output: 5 } as never };
		});
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Your previous reply could not be used");
		expect(run.retried).not.toBeNull();
		expect(run.issues).toEqual({});
	});

	it("stops the analysis when the second reply can't be read either", async () => {
		await expect(runPart(part, setup, ctx, async () => ({ text: "still not json", usage: null }))).rejects.toBeInstanceOf(UnreadableReplyError);
	});

	it("passes on a failure of the run itself", async () => {
		await expect(
			runPart(part, setup, ctx, async () => {
				throw new Error("timed out");
			})
		).rejects.toThrow("timed out");
	});
});
