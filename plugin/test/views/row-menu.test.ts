import { describe, expect, it } from "vitest";
import { rowMenuGroups } from "../../src/views/row-menu";

const state = { categorizable: true, justCompacted: false, canRestart: true };
const ids = (row: { agent: string; daemon: boolean }, s = state) => rowMenuGroups(row as never, s).map((g) => g.map((e) => e.id));

describe("rowMenuGroups", () => {
	it("orders a running Claude session into groups, destructive last", () => {
		expect(ids({ agent: "claude", daemon: true })).toEqual([
			["rename", "moveToCategory", "suggestName"],
			["changeModel", "compact", "restartSession"],
			["usage", "copyId"],
			["endSession", "archive"],
		]);
	});

	it("leaves out restart, end session and change model for a Claude session not in the daemon", () => {
		expect(ids({ agent: "claude", daemon: false })).toEqual([
			["rename", "moveToCategory", "suggestName"],
			["compact"],
			["usage", "copyId"],
			["archive"],
		]);
	});

	it("shows change model disabled for other agents", () => {
		const groups = rowMenuGroups({ agent: "codex", daemon: true } as never, state);
		expect(groups[1][0]).toEqual({ id: "changeModel", enabled: false });
	});

	it("keeps the disabled states", () => {
		const groups = rowMenuGroups({ agent: "claude", daemon: true } as never, { categorizable: false, justCompacted: true, canRestart: false });
		const flat = Object.fromEntries(groups.flat().map((e) => [e.id, e.enabled]));
		expect(flat).toMatchObject({ moveToCategory: false, suggestName: true, compact: false, restartSession: false, changeModel: true });
	});
});
