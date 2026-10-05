import { describe, expect, it } from "vitest";
import { isUnnamedChild, listedInManager } from "../../src/sessions/listing";

const row = (over: Partial<{ name: string | null; child: boolean; archived: boolean }> = {}) => ({
	name: "Some name" as string | null,
	child: false,
	archived: false,
	...over,
});

describe("listedInManager", () => {
	it("lists an ordinary named or unnamed session", () => {
		expect(listedInManager(row())).toBe(true);
		expect(listedInManager(row({ name: null }))).toBe(true);
	});

	it("never lists an unnamed child session (a sub-agent, `claude -p`, a Codex companion task)", () => {
		expect(listedInManager(row({ name: null, child: true }))).toBe(false);
		expect(listedInManager(row({ name: null, child: true }), { showArchived: true })).toBe(false);
		expect(isUnnamedChild(row({ name: null, child: true }))).toBe(true);
	});

	it("lists a child session once the user has named it", () => {
		expect(listedInManager(row({ name: "Mine", child: true }))).toBe(true);
		expect(isUnnamedChild(row({ name: "Mine", child: true }))).toBe(false);
	});

	it("lists an archived session only with Show archived", () => {
		expect(listedInManager(row({ archived: true }))).toBe(false);
		expect(listedInManager(row({ archived: true }), { showArchived: false })).toBe(false);
		expect(listedInManager(row({ archived: true }), { showArchived: true })).toBe(true);
	});
});
