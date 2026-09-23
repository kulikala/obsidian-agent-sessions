import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import {
	higherPriorityStatus,
	resolveRowStatus,
	rowTerminalStatus,
	terminalStatus,
	type TerminalStatus,
	type TerminalStatusInput,
} from "../src/terminal-status";

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
	return {
		agent: "claude",
		name: null,
		group: null,
		label: null,
		cwd: "/v",
		folder: "v",
		last_activity: 0,
		child: false,
		transcript: null,
		status: null,
		pid: null,
		rc: false,
		daemon: false,
		exited: null,
		hasTab: false,
		archived: false,
		...overrides,
	};
}

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

describe("higherPriorityStatus", () => {
	it("優先順の高い方を返す（順序を問わない）", () => {
		expect(higherPriorityStatus("idle", "working")).toBe("working");
		expect(higherPriorityStatus("working", "idle")).toBe("working");
		expect(higherPriorityStatus("error", "exited")).toBe("error");
	});

	it("同じ状態ならそのまま", () => {
		expect(higherPriorityStatus("waiting", "waiting")).toBe("waiting");
	});
});

describe("rowTerminalStatus（タブが無い行。D-66 追補）", () => {
	it("`exited` があれば exited", () => {
		expect(rowTerminalStatus(row({ id: "a", exited: 1700000000 }))).toBe("exited");
	});

	it("registry busy／shell は working／running-shell", () => {
		expect(rowTerminalStatus(row({ id: "a", status: "busy", daemon: true }))).toBe("working");
		expect(rowTerminalStatus(row({ id: "a", status: "shell", daemon: true }))).toBe("running-shell");
	});

	it("daemon（≈attached）が無ければ detached", () => {
		expect(rowTerminalStatus(row({ id: "a", daemon: false }))).toBe("detached");
	});

	it("daemon があって busy／shell でなければ idle", () => {
		expect(rowTerminalStatus(row({ id: "a", daemon: true, status: "idle" }))).toBe("idle");
	});

	it("waiting・editing・connecting・error にはならない（Row だけでは分からない）", () => {
		const statuses: TerminalStatus[] = ["waiting", "editing", "connecting", "error"];
		const r = row({ id: "a", daemon: true, status: "busy" });
		expect(statuses).not.toContain(rowTerminalStatus(r));
	});
});

describe("resolveRowStatus（タブあり／なし。D-66 追補）", () => {
	it("タブがあれば terminalStatuses の値をそのまま使う", () => {
		const source = { terminalStatuses: new Map<string, TerminalStatus>([["a", "editing"]]) };
		expect(resolveRowStatus(source, row({ id: "a", daemon: true, status: "idle" }))).toBe("editing");
	});

	it("タブが無ければ rowTerminalStatus に落ちる", () => {
		const source = { terminalStatuses: new Map<string, TerminalStatus>() };
		expect(resolveRowStatus(source, row({ id: "a", daemon: true, status: "busy" }))).toBe("working");
	});
});
