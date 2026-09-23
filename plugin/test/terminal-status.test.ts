import { describe, expect, it } from "vitest";
import { terminalStatus, type TerminalStatusInput } from "../src/terminal-status";

function input(overrides: Partial<TerminalStatusInput> = {}): TerminalStatusInput {
	return {
		error: false,
		exited: false,
		editing: false,
		connecting: false,
		registryStatus: null,
		waiting: false,
		attached: true,
		...overrides,
	};
}

describe("terminalStatus", () => {
	it("何も無ければ idle（attach 済み）", () => {
		expect(terminalStatus(input())).toBe("idle");
	});

	it("attach 前は detached", () => {
		expect(terminalStatus(input({ attached: false }))).toBe("detached");
	});

	it("busy→idle 後、前面にしていなければ waiting", () => {
		expect(terminalStatus(input({ waiting: true }))).toBe("waiting");
	});

	it("registry busy は working", () => {
		expect(terminalStatus(input({ registryStatus: "busy" }))).toBe("working");
	});

	it("registry shell は running-shell", () => {
		expect(terminalStatus(input({ registryStatus: "shell" }))).toBe("running-shell");
	});

	it("attach／start の途中は connecting", () => {
		expect(terminalStatus(input({ connecting: true }))).toBe("connecting");
	});

	it("内蔵エディタが開いていれば editing", () => {
		expect(terminalStatus(input({ editing: true }))).toBe("editing");
	});

	it("claude が終了していれば exited", () => {
		expect(terminalStatus(input({ exited: true }))).toBe("exited");
	});

	it("デーモン不通などは error", () => {
		expect(terminalStatus(input({ error: true }))).toBe("error");
	});

	describe("優先順", () => {
		it("error はどれより優先する", () => {
			expect(
				terminalStatus(
					input({ error: true, exited: true, editing: true, connecting: true, registryStatus: "busy", waiting: true })
				)
			).toBe("error");
		});

		it("exited は editing より優先する", () => {
			expect(terminalStatus(input({ exited: true, editing: true, connecting: true, registryStatus: "busy" }))).toBe(
				"exited"
			);
		});

		it("editing は connecting より優先する", () => {
			expect(terminalStatus(input({ editing: true, connecting: true, registryStatus: "busy", waiting: true }))).toBe(
				"editing"
			);
		});

		it("connecting は running-shell・working より優先する", () => {
			expect(terminalStatus(input({ connecting: true, registryStatus: "shell" }))).toBe("connecting");
			expect(terminalStatus(input({ connecting: true, registryStatus: "busy" }))).toBe("connecting");
		});

		it("running-shell は working より優先する", () => {
			expect(terminalStatus(input({ registryStatus: "shell", waiting: true }))).toBe("running-shell");
		});

		it("working は waiting より優先する", () => {
			expect(terminalStatus(input({ registryStatus: "busy", waiting: true }))).toBe("working");
		});

		it("waiting は detached より優先する（前面にしていない＝attach 済みのまま）", () => {
			expect(terminalStatus(input({ waiting: true, attached: true }))).toBe("waiting");
		});

		it("detached は idle より優先する", () => {
			expect(terminalStatus(input({ attached: false }))).toBe("detached");
			expect(terminalStatus(input({ attached: true }))).toBe("idle");
		});
	});
});
