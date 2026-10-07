import { describe, expect, it, vi } from "vitest";
import { disposeTerminal } from "../../src/terminal/dispose";

function fake() {
	const calls: string[] = [];
	return {
		calls,
		reset: vi.fn(() => void calls.push("reset")),
		dispose: vi.fn(() => void calls.push("dispose")),
	};
}

describe("disposeTerminal", () => {
	it("resets (mouse tracking off) before disposing an opened terminal", () => {
		const term = fake();
		disposeTerminal(term, true);
		expect(term.calls).toEqual(["reset", "dispose"]);
	});

	it("only disposes a terminal that was never opened", () => {
		const term = fake();
		disposeTerminal(term, false);
		expect(term.calls).toEqual(["dispose"]);
	});

	it("still disposes when reset throws", () => {
		const term = fake();
		term.reset.mockImplementation(() => {
			throw new Error("boom");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		disposeTerminal(term, true);
		expect(term.dispose).toHaveBeenCalledOnce();
		warn.mockRestore();
	});
});
