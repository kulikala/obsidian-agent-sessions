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
	it("何も無ければ idle（attach 済み）", () => {
		expect(terminalStatus(input())).toBe("idle");
	});

	it("attach 前は detached", () => {
		expect(terminalStatus(input({ attached: false }))).toBe("detached");
	});

	it("busy→idle 後、前面にしていなければ waiting", () => {
		expect(terminalStatus(input({ waiting: true }))).toBe("waiting");
	});

	it("compact 直後・未入力なら compacted（T-77 追補）", () => {
		expect(terminalStatus(input({ compacted: true }))).toBe("compacted");
	});

	it("registry busy は working", () => {
		expect(terminalStatus(input({ registryStatus: "busy" }))).toBe("working");
	});

	it("registry waiting（claude 自身が AskUserQuestion・許可プロンプト等で書く値）は asking（T-77）", () => {
		expect(terminalStatus(input({ registryStatus: "waiting" }))).toBe("asking");
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

		it("exited は asking より優先する（T-77）", () => {
			expect(terminalStatus(input({ exited: true, registryStatus: "waiting" }))).toBe("exited");
		});

		it("asking は editing・connecting・waiting（bool）より優先する（T-77）", () => {
			expect(terminalStatus(input({ registryStatus: "waiting", editing: true, connecting: true, waiting: true }))).toBe(
				"asking"
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

		it("waiting は compacted より優先する（未読の入力待ちが先。T-77 追補）", () => {
			expect(terminalStatus(input({ waiting: true, compacted: true }))).toBe("waiting");
		});

		it("compacted は detached・idle より優先する（T-77 追補）", () => {
			expect(terminalStatus(input({ compacted: true, attached: false }))).toBe("compacted");
			expect(terminalStatus(input({ compacted: true, attached: true }))).toBe("compacted");
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

	it("registry waiting は asking（タブが無くても claude 自身の値で分かる。T-77）", () => {
		expect(rowTerminalStatus(row({ id: "a", status: "waiting", waitingFor: "input needed", daemon: true }))).toBe(
			"asking"
		);
	});

	it("exited は asking より優先する（T-77）", () => {
		expect(rowTerminalStatus(row({ id: "a", status: "waiting", exited: 1700000000, daemon: true }))).toBe("exited");
	});

	it("row.compacted があれば compacted（タブが無くても分かる。T-77 追補）", () => {
		expect(rowTerminalStatus(row({ id: "a", compacted: true, daemon: true }))).toBe("compacted");
	});

	it("compacted は detached より優先する（T-77 追補）", () => {
		expect(rowTerminalStatus(row({ id: "a", compacted: true, daemon: false }))).toBe("compacted");
	});

	it("exited・asking は compacted より優先する（T-77 追補）", () => {
		expect(rowTerminalStatus(row({ id: "a", compacted: true, exited: 1700000000, daemon: true }))).toBe("exited");
		expect(rowTerminalStatus(row({ id: "a", compacted: true, status: "waiting", daemon: true }))).toBe("asking");
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

describe("TERMINAL_STATUS_ICON（D-66・T-76：行の印もタブと同じアイコンを使う）", () => {
	it("全ての状態にアイコン名がある（空文字・重複を持たない）", () => {
		const names = ALL_TERMINAL_STATUSES.map((s) => TERMINAL_STATUS_ICON[s]);
		for (const name of names) {
			expect(name.length).toBeGreaterThan(0);
		}
		expect(new Set(names).size).toBe(names.length);
	});

	it("行の印（rowStatusMark・T-76）はこの表からアイコン名を引く——タブ見出しと同じ", () => {
		expect(TERMINAL_STATUS_ICON.idle).toBe("square-terminal");
		expect(TERMINAL_STATUS_ICON.working).toBe("loader-circle");
		expect(TERMINAL_STATUS_ICON.detached).toBe("square-dashed");
		expect(TERMINAL_STATUS_ICON.asking).toBe("message-circle-question");
		expect(TERMINAL_STATUS_ICON.compacted).toBe("archive-restore");
	});
});
