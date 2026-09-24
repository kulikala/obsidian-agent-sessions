import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import type { Row } from "../../src/sessions/index";
import {
	ALL_TERMINAL_STATUSES,
	higherPriorityStatus,
	managerStatusFilterLabelKey,
	MANAGER_STATUS_FILTERS,
	resolveRowStatus,
	rowTerminalStatus,
	statusGroup,
	STATUS_GROUP_ICON,
	statusTooltip,
	terminalStatus,
	TERMINAL_STATUS_ICON,
	type TerminalStatus,
	type TerminalStatusInput,
} from "../../src/sessions/terminal-status";

afterEach(() => setLang("en"));

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
		// Matches Claude's own app's icon for the same meaning, where a status-filter bucket applies.
		expect(TERMINAL_STATUS_ICON.idle).toBe("circle-check");
		expect(TERMINAL_STATUS_ICON.working).toBe("loader-circle");
		expect(TERMINAL_STATUS_ICON.detached).toBe("circle-dashed");
		expect(TERMINAL_STATUS_ICON.asking).toBe("hand");
		expect(TERMINAL_STATUS_ICON.waiting).toBe("eye");
		expect(TERMINAL_STATUS_ICON.compacted).toBe("archive-restore");
	});
});

describe("statusGroup", () => {
	it("classifies each fine status into its group", () => {
		expect(statusGroup("asking", false)).toBe("needs-input");
		expect(statusGroup("waiting", false)).toBe("needs-review");
		expect(statusGroup("compacted", false)).toBe("needs-review");
		expect(statusGroup("connecting", false)).toBe("running");
		expect(statusGroup("working", false)).toBe("running");
		expect(statusGroup("running-shell", false)).toBe("running");
		expect(statusGroup("idle", false)).toBe("done");
		expect(statusGroup("editing", false)).toBe("done");
		expect(statusGroup("detached", false)).toBe("done");
		expect(statusGroup("exited", false)).toBe("done");
		expect(statusGroup("error", false)).toBe("error");
	});

	it("is archived regardless of the underlying status once a session is archived", () => {
		for (const status of ALL_TERMINAL_STATUSES) {
			expect(statusGroup(status, true)).toBe("archived");
		}
	});
});

describe("MANAGER_STATUS_FILTERS / STATUS_GROUP_ICON / managerStatusFilterLabelKey", () => {
	it("lists all and every group except error, in Claude's app's order", () => {
		expect(MANAGER_STATUS_FILTERS).toEqual(["all", "needs-input", "needs-review", "running", "done", "archived"]);
	});

	it("gives every filter (other than all) a non-empty icon, matching Claude's app", () => {
		expect(STATUS_GROUP_ICON["needs-input"]).toBe("hand");
		expect(STATUS_GROUP_ICON["needs-review"]).toBe("eye");
		expect(STATUS_GROUP_ICON.running).toBe("loader-circle");
		expect(STATUS_GROUP_ICON.done).toBe("circle-check");
		expect(STATUS_GROUP_ICON.archived).toBe("archive");
	});

	it("gives every filter option a message key", () => {
		for (const filter of MANAGER_STATUS_FILTERS) {
			const key = managerStatusFilterLabelKey(filter);
			expect(key.startsWith("status.group.")).toBe(true);
		}
	});
});

describe("statusTooltip", () => {
	it("combines the group label and the fine status name", () => {
		setLang("en");
		expect(statusTooltip("detached")).toBe("Done — Not connected");
		expect(statusTooltip("asking")).toBe("Needs input — Waiting for your answer");
		expect(statusTooltip("compacted")).toBe("Needs review — Compacted (context was reset)");
	});

	it("falls back to just the fine name for error (no group label of its own)", () => {
		setLang("en");
		expect(statusTooltip("error")).toBe("Error");
	});

	it("shows only the archived label, regardless of the underlying status", () => {
		setLang("en");
		expect(statusTooltip("idle", true)).toBe("Archived");
		expect(statusTooltip("working", true)).toBe("Archived");
	});

	it("translates through the current language", () => {
		setLang("ja");
		expect(statusTooltip("detached")).toBe("完了 — 未接続");
		setLang("en");
	});
});
