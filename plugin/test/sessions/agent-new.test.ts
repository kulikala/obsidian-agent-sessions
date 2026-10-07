import { describe, expect, it } from "vitest";
import {
	AGENT_NEW_RECHECK_MS,
	AGENT_NEW_SLACK_MS,
	newSince,
	tabsToAsk,
	unknownOpencode,
	type AgentNewTab,
} from "../../src/sessions/agent-new";

const T0 = 1_700_000_000_000;
const tab = (id: string, extra: Partial<AgentNewTab> = {}): AgentNewTab => ({ id, agent: "codex", pid: 100, startedAt: T0, ...extra });

describe("newSince", () => {
	it("starts from the process start, or from when the tab took its id if that is later", () => {
		expect(newSince(tab("a"))).toBe((T0 - AGENT_NEW_SLACK_MS) / 1000);
		expect(newSince(tab("a", { linkedAt: T0 + 60_000 }))).toBe((T0 + 60_000 - AGENT_NEW_SLACK_MS) / 1000);
		expect(newSince(tab("a", { linkedAt: T0 - 60_000 }))).toBe((T0 - AGENT_NEW_SLACK_MS) / 1000);
	});
});

describe("tabsToAsk", () => {
	const now = T0 + 10 * AGENT_NEW_RECHECK_MS;
	const recent = (ids: string[]) => new Map(ids.map((id) => [id, now - 1_000]));

	it("asks about a tab whose turn just ended, and none else that was asked recently", () => {
		const tabs = [tab("c1"), tab("c2"), tab("o1", { agent: "opencode" })];
		const got = tabsToAsk(tabs, { due: new Set(["c2"]), newOpencode: false, askedAt: recent(["c1", "c2", "o1"]), now });
		expect(got.map((t) => t.id)).toEqual(["c2"]);
	});

	it("asks about every OpenCode tab when an unknown OpenCode session shows up", () => {
		const tabs = [tab("c1"), tab("o1", { agent: "opencode" }), tab("o2", { agent: "opencode" })];
		const got = tabsToAsk(tabs, { due: new Set(), newOpencode: true, askedAt: recent(["c1", "o1", "o2"]), now });
		expect(got.map((t) => t.id)).toEqual(["o1", "o2"]);
	});

	it("asks again about a tab after a while, and at once about one never asked", () => {
		const tabs = [tab("old"), tab("never")];
		const askedAt = new Map([["old", now - AGENT_NEW_RECHECK_MS]]);
		const got = tabsToAsk(tabs, { due: new Set(), newOpencode: false, askedAt, now });
		expect(got.map((t) => t.id)).toEqual(["old", "never"]);
	});
});

describe("unknownOpencode", () => {
	it("lists OpenCode ids nobody knows, and never a Claude one", () => {
		const ids = ["ses_known", "ses_new", "0c0ffee0-claude-id"];
		expect(unknownOpencode(ids, (id) => id === "ses_known")).toEqual(["ses_new"]);
	});
});
