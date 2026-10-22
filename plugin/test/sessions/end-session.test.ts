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

	it("offers no archive for a tab-only row", () => {
		const model = endSessionDialogModel(true, true);
		expect(model.options).toEqual([{ id: "closeTab", labelKey: "confirm.endSession.closeTab" }]);
	});

	it.each([false, true])("starts both options unchecked (openAsTab: %s)", (openAsTab) => {
		expect(endSessionDialogModel(openAsTab).choices).toEqual({ archive: false, closeTab: false });
	});
});

describe("runEndSessionOptions", () => {
	const actions = () => ({ end: vi.fn(async () => undefined), archive: vi.fn(), closeTab: vi.fn() });

	it("ends the session even when both are unchecked", async () => {
		const spies = actions();
		await runEndSessionOptions(true, { archive: false, closeTab: false }, spies);
		expect(spies.end).toHaveBeenCalledTimes(1);
		expect(spies.archive).not.toHaveBeenCalled();
		expect(spies.closeTab).not.toHaveBeenCalled();
	});

	it("archives only when archive is checked", async () => {
		const spies = actions();
		await runEndSessionOptions(true, { archive: true, closeTab: false }, spies);
		expect(spies.archive).toHaveBeenCalledTimes(1);
		expect(spies.closeTab).not.toHaveBeenCalled();
	});

	it("closes the tab only when close tab is checked", async () => {
		const spies = actions();
		await runEndSessionOptions(true, { archive: false, closeTab: true }, spies);
		expect(spies.archive).not.toHaveBeenCalled();
		expect(spies.closeTab).toHaveBeenCalledTimes(1);
	});

	it("ends, then archives, then closes the tab", async () => {
		const calls: string[] = [];
		await runEndSessionOptions(true, { archive: true, closeTab: true }, {
			end: async () => {
				calls.push("end");
			},
			archive: () => calls.push("archive"),
			closeTab: () => calls.push("closeTab"),
		});
		expect(calls).toEqual(["end", "archive", "closeTab"]);
	});

	it("skips archive and close tab when ending fails", async () => {
		const spies = actions();
		spies.end.mockRejectedValueOnce(new Error("kill failed"));
		await expect(runEndSessionOptions(true, { archive: true, closeTab: true }, spies)).rejects.toThrow("kill failed");
		expect(spies.archive).not.toHaveBeenCalled();
		expect(spies.closeTab).not.toHaveBeenCalled();
	});

	it("never closes a tab when the dialog offered no close option", async () => {
		const spies = actions();
		await runEndSessionOptions(false, { archive: false, closeTab: true }, spies);
		expect(spies.closeTab).not.toHaveBeenCalled();
	});
});
