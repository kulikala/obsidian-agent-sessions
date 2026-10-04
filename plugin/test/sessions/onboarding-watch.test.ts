import { describe, expect, it } from "vitest";
import {
	activeTabSession,
	categoryOf,
	hintDue,
	nameEvents,
	restartedAs,
	TERMINAL_HINT_MS,
	unansweredSince,
} from "../../src/sessions/onboarding-watch";

describe("activeTabSession", () => {
	it("is null for a leaf that isn't a terminal", () => {
		expect(activeTabSession(null, "g")).toBeNull();
	});

	it("reports the tab's own id", () => {
		expect(activeTabSession({ sessionId: "x", daemonId: "x" }, "g")).toBe("x");
	});

	it("reports the guide's id for its tab even after the tab was linked to a real id", () => {
		expect(activeTabSession({ sessionId: "real", daemonId: "g" }, "g")).toBe("g");
		expect(activeTabSession({ sessionId: "g", daemonId: "g" }, "g")).toBe("g");
	});
});

describe("nameEvents", () => {
	it("a new name is a rename", () => {
		expect(nameEvents("s", null, "Notes")).toEqual([{ kind: "renamed", sessionId: "s", name: "Notes" }]);
	});

	it("a name with a new category is a rename and a category change", () => {
		expect(nameEvents("s", "Notes", "Team: Notes")).toEqual([
			{ kind: "renamed", sessionId: "s", name: "Team: Notes" },
			{ kind: "category-changed", sessionId: "s", category: "Team" },
		]);
	});

	it("nothing for the same name or a cleared one", () => {
		expect(nameEvents("s", "A", "A")).toEqual([]);
		expect(nameEvents("s", "A", null)).toEqual([]);
		expect(nameEvents("s", "A", "")).toEqual([]);
	});

	it("moving within the same category is only a rename", () => {
		expect(nameEvents("s", "Team: A", "Team: B").map((e) => e.kind)).toEqual(["renamed"]);
	});

	it("categoryOf", () => {
		expect(categoryOf("Team: A")).toBe("Team");
		expect(categoryOf("A")).toBeNull();
		expect(categoryOf(null)).toBeNull();
	});
});

describe("terminal hint timing", () => {
	it("starts the clock when unanswered and keeps its first time", () => {
		expect(unansweredSince(null, undefined, 100)).toBe(100);
		expect(unansweredSince(100, "waiting", 500)).toBe(100);
	});

	it("stops when the agent is getting on by itself", () => {
		for (const status of ["idle", "busy", "shell"]) {
			expect(unansweredSince(100, status, 500)).toBeNull();
		}
	});

	it("is due after a minute and not before", () => {
		expect(hintDue(null, 1e9)).toBe(false);
		expect(hintDue(1000, 1000 + TERMINAL_HINT_MS - 1)).toBe(false);
		expect(hintDue(1000, 1000 + TERMINAL_HINT_MS)).toBe(true);
	});
});

describe("restartedAs", () => {
	const tabs = [
		{ sessionId: "guide", daemonId: "guide", agent: "claude" },
		{ sessionId: "real", daemonId: "tab", agent: "claude" },
		{ sessionId: "thread", daemonId: "placeholder", agent: "codex" },
	];

	it("names the id a Claude tab continues under once it was linked", () => {
		expect(restartedAs(tabs, "tab")).toBe("real");
	});

	it("is null while the tab still has the id it started with", () => {
		expect(restartedAs(tabs, "guide")).toBeNull();
	});

	it("is null for an id no tab has, and for another agent's placeholder", () => {
		expect(restartedAs(tabs, "nobody")).toBeNull();
		expect(restartedAs(tabs, "placeholder")).toBeNull();
	});
});
