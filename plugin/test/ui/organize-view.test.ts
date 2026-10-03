import { describe, expect, it } from "vitest";
import { viewAfterRun } from "../../src/ui/organize-view";

describe("viewAfterRun", () => {
	it("goes to the result when the run produced suggestions", () => {
		expect(viewAfterRun("start", true)).toBe("result");
		expect(viewAfterRun("result", true)).toBe("result");
	});

	it("returns to the view the run came from when it produced nothing", () => {
		expect(viewAfterRun("start", false)).toBe("start");
		expect(viewAfterRun("result", false)).toBe("result");
	});

	it("never stays on the working view", () => {
		expect(viewAfterRun("working", false)).toBe("start");
	});
});
