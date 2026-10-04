import { describe, expect, it } from "vitest";
import {
	normalizeFolder,
	planSuccessors,
	possibleSuccessors,
	SUCCESSOR_WINDOW_MS,
	type SuccessorCandidate,
	type SuccessorTab,
} from "../../src/sessions/successor";

const T0 = 1_700_000_000_000;
const tab = (id: string, extra: Partial<SuccessorTab> = {}): SuccessorTab => ({ id, cwd: "/v", startedAt: T0, daemonPid: 100, ...extra });
const cand = (id: string, extra: Partial<SuccessorCandidate> = {}): SuccessorCandidate => ({ id, pid: 200, cwd: "/v", startedAt: T0 + 5_000, ...extra });
const none = () => false;

describe("normalizeFolder", () => {
	it("ignores separators and a trailing one, and the case of a drive path", () => {
		expect(normalizeFolder("C:\\Users\\Me\\Vault\\")).toBe(normalizeFolder("c:/users/me/vault"));
		expect(normalizeFolder("/a/b/")).toBe("/a/b");
		expect(normalizeFolder("/A")).not.toBe(normalizeFolder("/a"));
		expect(normalizeFolder("/")).toBe("/");
	});
});

describe("possibleSuccessors", () => {
	it("keeps unowned entries started in the tab's folder within two minutes after it began", () => {
		const edge = cand("edge", { startedAt: T0 + SUCCESSOR_WINDOW_MS });
		const late = cand("late", { startedAt: T0 + SUCCESSOR_WINDOW_MS + 1 });
		expect(possibleSuccessors([tab("t")], [edge, late], none).map((c) => c.id)).toEqual(["edge"]);
	});

	it("ignores other folders, earlier starts, entries without a start or folder, and owned ids", () => {
		const candidates = [
			cand("other", { cwd: "/x" }),
			cand("old", { startedAt: T0 - 60_000 }),
			cand("nostart", { startedAt: undefined }),
			cand("nocwd", { cwd: undefined }),
			cand("mine"),
		];
		expect(possibleSuccessors([tab("t")], candidates, (id) => id === "mine")).toEqual([]);
	});

	it("matches a folder written with the other separator", () => {
		expect(possibleSuccessors([tab("t", { cwd: "C:\\v" })], [cand("c", { cwd: "c:/v/" })], none)).toHaveLength(1);
	});
});

describe("planSuccessors", () => {
	it("links the entry whose parent is the tab's daemon child", () => {
		const plan = planSuccessors({ tabs: [tab("t")], candidates: [cand("real")], owned: none, parents: { "200": 100 } });
		expect(plan).toEqual([{ tabId: "t", successorId: "real" }]);
	});

	it("does not link an entry whose parent is something else (a claude typed into a shell)", () => {
		const plan = planSuccessors({ tabs: [tab("t")], candidates: [cand("manual")], owned: none, parents: { "200": 999 } });
		expect(plan).toEqual([]);
	});

	it("tells two tabs in the same folder apart by parent pid", () => {
		const tabs = [tab("a", { daemonPid: 100 }), tab("b", { daemonPid: 101 })];
		const candidates = [cand("ra", { pid: 201 }), cand("rb", { pid: 202, startedAt: T0 + 6_000 })];
		const plan = planSuccessors({ tabs, candidates, owned: none, parents: { "201": 101, "202": 100 } });
		expect(plan).toEqual([
			{ tabId: "b", successorId: "ra" },
			{ tabId: "a", successorId: "rb" },
		]);
	});

	it("falls back on folder and time when the parents could not be read", () => {
		expect(planSuccessors({ tabs: [tab("t")], candidates: [cand("real")], owned: none, parents: null })).toEqual([
			{ tabId: "t", successorId: "real" },
		]);
	});

	it("falls back too for an entry whose parent is not in the map", () => {
		expect(planSuccessors({ tabs: [tab("t")], candidates: [cand("real")], owned: none, parents: {} })).toEqual([
			{ tabId: "t", successorId: "real" },
		]);
	});

	it("does not guess between several waiting tabs without parent pids", () => {
		const tabs = [tab("a"), tab("b")];
		expect(planSuccessors({ tabs, candidates: [cand("real")], owned: none, parents: null })).toEqual([]);
	});

	it("takes the parent as no evidence when the tab's own pid is unknown", () => {
		const plan = planSuccessors({ tabs: [tab("t", { daemonPid: null })], candidates: [cand("real")], owned: none, parents: { "200": 100 } });
		expect(plan).toEqual([{ tabId: "t", successorId: "real" }]);
	});

	it("pairs consecutive restarts in the order they began and uses each tab once", () => {
		const tabs = [tab("a", { daemonPid: null }), tab("b", { startedAt: T0 + 1_000, daemonPid: null })];
		const candidates = [cand("second", { pid: 202, startedAt: T0 + 9_000 }), cand("first", { pid: 201 })];
		// Two waiting tabs and no pids: nothing is guessed.
		expect(planSuccessors({ tabs, candidates, owned: none, parents: null })).toEqual([]);
		// One of them is already linked: the remaining tab takes the next entry.
		expect(planSuccessors({ tabs: [tabs[1]], candidates, owned: (id) => id === "first", parents: null })).toEqual([
			{ tabId: "b", successorId: "second" },
		]);
	});
});
