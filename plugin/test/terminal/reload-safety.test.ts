import { beforeEach, describe, expect, it } from "vitest";
import { msSinceKey, noteKey, resetKeyClock, summarizeReloadSafety } from "../../src/terminal/reload-safety";

beforeEach(() => resetKeyClock());

describe("key clock", () => {
	it("is null until a key is noted, then counts milliseconds since it", () => {
		expect(msSinceKey(1000)).toBeNull();
		noteKey(1000);
		expect(msSinceKey(1500)).toBe(500);
		noteKey(2000);
		expect(msSinceKey(2000)).toBe(0);
	});

	it("never goes negative", () => {
		noteKey(5000);
		expect(msSinceKey(4000)).toBe(0);
	});
});

describe("summarizeReloadSafety", () => {
	it("reports an open editor, the key age, and the sessions with an unsent draft", () => {
		const out = summarizeReloadSafety(
			[
				{ name: "A", editorOpen: false, hasDraft: true },
				{ name: "B", editorOpen: true, hasDraft: false },
				{ name: "C", editorOpen: false, hasDraft: null },
				{ name: "D", editorOpen: false, hasDraft: true },
			],
			1200
		);
		expect(out).toEqual({ editorOpen: true, recentKeyMs: 1200, drafts: ["A", "D"] });
	});

	it("is all clear with no tabs", () => {
		expect(summarizeReloadSafety([], null)).toEqual({ editorOpen: false, recentKeyMs: null, drafts: [] });
	});
});
