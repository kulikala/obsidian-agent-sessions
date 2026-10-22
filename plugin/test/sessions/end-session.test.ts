import { describe, expect, it, vi } from "vitest";
import { endSessionDialogModel, runEndSessionOptions } from "../../src/sessions/end-session";

describe("endSessionDialogModel", () => {
	it("offers archive alone when no tab owns the session", () => {
		const model = endSessionDialogModel(false);
		expect(model.options).toEqual([{ id: "archive", labelKey: "confirm.endSession.archive" }]);
	});

	it("adds close tab when the session is open as a tab", () => {
		const model = endSessionDialogModel(true);
		expect(model.options).toEqual([
			{ id: "archive", labelKey: "confirm.endSession.archive" },
			{ id: "closeTab", labelKey: "confirm.endSession.closeTab" },
		]);
	});

	it.each([false, true])("starts both options unchecked (openAsTab: %s)", (openAsTab) => {
		expect(endSessionDialogModel(openAsTab).choices).toEqual({ archive: false, closeTab: false });
	});
});

describe("runEndSessionOptions", () => {
	const actions = () => ({ archive: vi.fn(), closeTab: vi.fn() });

	it("does nothing when both are unchecked", () => {
		const spies = actions();
		runEndSessionOptions(true, { archive: false, closeTab: false }, spies);
		expect(spies.archive).not.toHaveBeenCalled();
		expect(spies.closeTab).not.toHaveBeenCalled();
	});

	it("archives only when archive is checked", () => {
		const spies = actions();
		runEndSessionOptions(true, { archive: true, closeTab: false }, spies);
		expect(spies.archive).toHaveBeenCalledTimes(1);
		expect(spies.closeTab).not.toHaveBeenCalled();
	});

	it("closes the tab only when close tab is checked", () => {
		const spies = actions();
		runEndSessionOptions(true, { archive: false, closeTab: true }, spies);
		expect(spies.archive).not.toHaveBeenCalled();
		expect(spies.closeTab).toHaveBeenCalledTimes(1);
	});

	it("does both when both are checked", () => {
		const spies = actions();
		runEndSessionOptions(true, { archive: true, closeTab: true }, spies);
		expect(spies.archive).toHaveBeenCalledTimes(1);
		expect(spies.closeTab).toHaveBeenCalledTimes(1);
	});

	it("never closes a tab when the dialog offered no close option", () => {
		const spies = actions();
		runEndSessionOptions(false, { archive: false, closeTab: true }, spies);
		expect(spies.closeTab).not.toHaveBeenCalled();
	});
});
