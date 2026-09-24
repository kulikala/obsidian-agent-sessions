import { describe, expect, it } from "vitest";
import type { Row } from "../src/index";
import {
	ALL_TERMINAL_STATUSES,
	higherPriorityStatus,
	resolveRowStatus,
	rowTerminalStatus,
	terminalStatus,
	TERMINAL_STATUS_ICON,
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
		waitingFor: null,
		compacted: false,
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
		compacted: false,
		attached: true,
		...overrides,
	};
}

describe("terminalStatus", () => {
	it("is idle when nothing else applies and the terminal is attached", () => {
		expect(terminalStatus(input())).toBe("idle");
	});

	it("is detached before attach", () => {
		expect(terminalStatus(input({ attached: false }))).toBe("detached");
	});

	it("is waiting after busy->idle if the terminal hasn't been brought to the front", () => {
		expect(terminalStatus(input({ waiting: true }))).toBe("waiting");
	});

	it("is compacted right after a compaction, before any new input", () => {
		expect(terminalStatus(input({ compacted: true }))).toBe("compacted");
	});

	it("is working when the registry reports busy", () => {
		expect(terminalStatus(input({ registryStatus: "busy" }))).toBe("working");
	});

	it("is asking when the registry reports waiting (written by claude itself for AskUserQuestion, permission prompts, etc.)", () => {
		expect(terminalStatus(input({ registryStatus: "waiting" }))).toBe("asking");
	});

	it("is running-shell when the registry reports shell", () => {
		expect(terminalStatus(input({ registryStatus: "shell" }))).toBe("running-shell");
	});

	it("is connecting while attach/start is in progress", () => {
		expect(terminalStatus(input({ connecting: true }))).toBe("connecting");
	});

	it("is editing while the built-in editor is open", () => {
		expect(terminalStatus(input({ editing: true }))).toBe("editing");
	});

	it("is exited once claude has exited", () => {
		expect(terminalStatus(input({ exited: true }))).toBe("exited");
	});

	it("is error when, e.g., the daemon is unreachable", () => {
		expect(terminalStatus(input({ error: true }))).toBe("error");
	});

	describe("priority order", () => {
		it("error outranks everything else", () => {
			expect(
				terminalStatus(
					input({ error: true, exited: true, editing: true, connecting: true, registryStatus: "busy", waiting: true })
				)
			).toBe("error");
		});

		it("exited outranks editing", () => {
			expect(terminalStatus(input({ exited: true, editing: true, connecting: true, registryStatus: "busy" }))).toBe(
				"exited"
			);
		});

		it("exited outranks asking", () => {
			expect(terminalStatus(input({ exited: true, registryStatus: "waiting" }))).toBe("exited");
		});

		it("asking outranks editing, connecting, and the boolean waiting flag", () => {
			expect(terminalStatus(input({ registryStatus: "waiting", editing: true, connecting: true, waiting: true }))).toBe(
				"asking"
			);
		});

		it("editing outranks connecting", () => {
			expect(terminalStatus(input({ editing: true, connecting: true, registryStatus: "busy", waiting: true }))).toBe(
				"editing"
			);
		});

		it("connecting outranks running-shell and working", () => {
			expect(terminalStatus(input({ connecting: true, registryStatus: "shell" }))).toBe("connecting");
			expect(terminalStatus(input({ connecting: true, registryStatus: "busy" }))).toBe("connecting");
		});

		it("running-shell outranks working", () => {
			expect(terminalStatus(input({ registryStatus: "shell", waiting: true }))).toBe("running-shell");
		});

		it("working outranks waiting", () => {
			expect(terminalStatus(input({ registryStatus: "busy", waiting: true }))).toBe("working");
		});

		it("waiting outranks detached (not brought to front still means it stayed attached)", () => {
			expect(terminalStatus(input({ waiting: true, attached: true }))).toBe("waiting");
		});

		it("waiting outranks compacted (an unread pending input comes first)", () => {
			expect(terminalStatus(input({ waiting: true, compacted: true }))).toBe("waiting");
		});

		it("compacted outranks detached and idle", () => {
			expect(terminalStatus(input({ compacted: true, attached: false }))).toBe("compacted");
			expect(terminalStatus(input({ compacted: true, attached: true }))).toBe("compacted");
		});

		it("detached outranks idle", () => {
			expect(terminalStatus(input({ attached: false }))).toBe("detached");
			expect(terminalStatus(input({ attached: true }))).toBe("idle");
		});
	});
});

describe("higherPriorityStatus", () => {
	it("returns whichever status ranks higher, regardless of argument order", () => {
		expect(higherPriorityStatus("idle", "working")).toBe("working");
		expect(higherPriorityStatus("working", "idle")).toBe("working");
		expect(higherPriorityStatus("error", "exited")).toBe("error");
	});

	it("returns the same status when both arguments match", () => {
		expect(higherPriorityStatus("waiting", "waiting")).toBe("waiting");
	});
});

describe("rowTerminalStatus (a row with no open tab)", () => {
	it("is exited when `exited` is set", () => {
		expect(rowTerminalStatus(row({ id: "a", exited: 1700000000 }))).toBe("exited");
	});

	it("maps registry busy/shell to working/running-shell", () => {
		expect(rowTerminalStatus(row({ id: "a", status: "busy", daemon: true }))).toBe("working");
		expect(rowTerminalStatus(row({ id: "a", status: "shell", daemon: true }))).toBe("running-shell");
	});

	it("is asking when the registry reports waiting, even with no open tab (claude's own reported value is enough)", () => {
		expect(rowTerminalStatus(row({ id: "a", status: "waiting", waitingFor: "input needed", daemon: true }))).toBe(
			"asking"
		);
	});

	it("exited outranks asking", () => {
		expect(rowTerminalStatus(row({ id: "a", status: "waiting", exited: 1700000000, daemon: true }))).toBe("exited");
	});

	it("is compacted when row.compacted is set, even with no open tab", () => {
		expect(rowTerminalStatus(row({ id: "a", compacted: true, daemon: true }))).toBe("compacted");
	});

	it("compacted outranks detached", () => {
		expect(rowTerminalStatus(row({ id: "a", compacted: true, daemon: false }))).toBe("compacted");
	});

	it("exited and asking outrank compacted", () => {
		expect(rowTerminalStatus(row({ id: "a", compacted: true, exited: 1700000000, daemon: true }))).toBe("exited");
		expect(rowTerminalStatus(row({ id: "a", compacted: true, status: "waiting", daemon: true }))).toBe("asking");
	});

	it("is detached when there's no daemon (≈not attached)", () => {
		expect(rowTerminalStatus(row({ id: "a", daemon: false }))).toBe("detached");
	});

	it("is idle when there's a daemon but it's neither busy nor shell", () => {
		expect(rowTerminalStatus(row({ id: "a", daemon: true, status: "idle" }))).toBe("idle");
	});

	it("never resolves to waiting, editing, connecting, or error (the Row alone can't tell)", () => {
		const statuses: TerminalStatus[] = ["waiting", "editing", "connecting", "error"];
		const r = row({ id: "a", daemon: true, status: "busy" });
		expect(statuses).not.toContain(rowTerminalStatus(r));
	});
});

describe("resolveRowStatus (with and without an open tab)", () => {
	it("uses the terminalStatuses value as-is when a tab is open", () => {
		const source = { terminalStatuses: new Map<string, TerminalStatus>([["a", "editing"]]) };
		expect(resolveRowStatus(source, row({ id: "a", daemon: true, status: "idle" }))).toBe("editing");
	});

	it("falls back to rowTerminalStatus when no tab is open", () => {
		const source = { terminalStatuses: new Map<string, TerminalStatus>() };
		expect(resolveRowStatus(source, row({ id: "a", daemon: true, status: "busy" }))).toBe("working");
	});
});

describe("TERMINAL_STATUS_ICON (a row's status mark uses the same icon set as its tab)", () => {
	it("gives every status a non-empty, unique icon name", () => {
		const names = ALL_TERMINAL_STATUSES.map((s) => TERMINAL_STATUS_ICON[s]);
		for (const name of names) {
			expect(name.length).toBeGreaterThan(0);
		}
		expect(new Set(names).size).toBe(names.length);
	});

	it("looks up a row's status mark from this same table, matching the tab header", () => {
		expect(TERMINAL_STATUS_ICON.idle).toBe("square-terminal");
		expect(TERMINAL_STATUS_ICON.working).toBe("loader-circle");
		expect(TERMINAL_STATUS_ICON.detached).toBe("square-dashed");
		expect(TERMINAL_STATUS_ICON.asking).toBe("message-circle-question");
		expect(TERMINAL_STATUS_ICON.compacted).toBe("archive-restore");
	});
});
