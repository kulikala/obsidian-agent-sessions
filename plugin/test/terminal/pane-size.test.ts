import { describe, expect, it } from "vitest";
import { attachPlan, FALLBACK_SIZE, launchSize, paneHasRoom } from "../../src/terminal/pane-size";

const room = { width: 800, height: 600 };
const none = { width: 0, height: 0 };

describe("paneHasRoom", () => {
	it("needs both a width and a height", () => {
		expect(paneHasRoom(room)).toBe(true);
		expect(paneHasRoom({ width: 0, height: 600 })).toBe(false);
		expect(paneHasRoom({ width: 800, height: 0 })).toBe(false);
	});
});

describe("attachPlan", () => {
	it("attaches right away once the terminal is mounted in a pane with room", () => {
		expect(attachPlan({ hasId: true, opened: true, size: room, waitedForRoom: false })).toBe("attach");
	});

	it("waits for a pane that has no room yet", () => {
		expect(attachPlan({ hasId: true, opened: false, size: none, waitedForRoom: false })).toBe("wait");
		expect(attachPlan({ hasId: true, opened: false, size: room, waitedForRoom: false })).toBe("wait");
	});

	it("attaches anyway once the wait for room is over, so a zero-width pane still starts its session", () => {
		expect(attachPlan({ hasId: true, opened: false, size: none, waitedForRoom: true })).toBe("attach");
	});

	it("has nothing to connect without a session id", () => {
		expect(attachPlan({ hasId: false, opened: true, size: room, waitedForRoom: true })).toBe("idle");
	});
});

describe("launchSize", () => {
	it("passes a real size through", () => {
		expect(launchSize(120, 30)).toEqual({ cols: 120, rows: 30 });
	});

	it("falls back to 80x24 for a pane without width or height", () => {
		expect(launchSize(0, 0)).toEqual(FALLBACK_SIZE);
		expect(launchSize(0, 24)).toEqual(FALLBACK_SIZE);
		expect(launchSize(1, 24)).toEqual(FALLBACK_SIZE);
		expect(launchSize(80, 0)).toEqual(FALLBACK_SIZE);
	});
});
