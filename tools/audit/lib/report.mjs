// Collects what the checks find. A failure makes the run exit non-zero; a warning is printed and
// left to the reader. Each finding names where it is ("path:line", "commit abc1234", or both) and
// how to fix it.

export class Report {
	constructor() {
		/** @type {{ level: "fail" | "warn", check: string, where: string, message: string, fix: string }[]} */
		this.items = [];
		/** @type {Map<string, { ran: boolean, note?: string }>} */
		this.checks = new Map();
	}

	ran(check, note) {
		this.checks.set(check, { ran: true, note });
	}

	skipped(check, note) {
		this.checks.set(check, { ran: false, note });
	}

	fail(check, where, message, fix = "") {
		this.items.push({ level: "fail", check, where, message, fix });
	}

	warn(check, where, message, fix = "") {
		this.items.push({ level: "warn", check, where, message, fix });
	}

	get failures() {
		return this.items.filter((i) => i.level === "fail");
	}

	get warnings() {
		return this.items.filter((i) => i.level === "warn");
	}

	/** The findings, failures first; then what ran, the counts per kind of finding, and a total. */
	format() {
		const out = [];
		for (const level of ["fail", "warn"]) {
			for (const item of this.items.filter((i) => i.level === level)) {
				out.push(`${level === "fail" ? "FAIL" : "WARN"} [${item.check}] ${item.where}: ${item.message}`);
				if (item.fix) out.push(`     fix: ${item.fix}`);
			}
		}
		if (out.length > 0) out.push("");
		for (const [check, state] of this.checks) {
			out.push(`  ${check.padEnd(9)} ${state.ran ? "ran" : "skipped"}${state.note ? ` (${state.note})` : ""}`);
		}
		const kinds = [...new Set(this.items.map((i) => i.check))];
		if (kinds.length > 0) {
			const count = (kind, level) => this.items.filter((i) => i.check === kind && i.level === level).length;
			out.push(`  findings: ${kinds.map((k) => `${k} ${count(k, "fail")} failed${count(k, "warn") ? `/${count(k, "warn")} warned` : ""}`).join(", ")}`);
		}
		out.push("");
		out.push(
			this.failures.length > 0
				? `audit: ${this.failures.length} failures, ${this.warnings.length} warnings`
				: `audit: passed, ${this.warnings.length} warnings`,
		);
		return out.join("\n");
	}
}
