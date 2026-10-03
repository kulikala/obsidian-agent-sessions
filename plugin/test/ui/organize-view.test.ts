import { describe, expect, it } from "vitest";
import { reviewState, viewAfterRun } from "../../src/ui/organize-view";

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

describe("reviewState", () => {
	it("counts ticked and unticked rows", () => {
		expect(reviewState([true, false, false])).toEqual({
			checked: 1,
			unchecked: 2,
			canApply: true,
			showResuggest: true,
		});
	});

	it("hides the re-suggest controls when every row is ticked", () => {
		const state = reviewState([true, true]);
		expect(state.showResuggest).toBe(false);
		expect(state.canApply).toBe(true);
	});

	it("disables Apply when nothing is ticked", () => {
		const state = reviewState([false, false]);
		expect(state.canApply).toBe(false);
		expect(state.unchecked).toBe(2);
		expect(reviewState([]).canApply).toBe(false);
	});
});
