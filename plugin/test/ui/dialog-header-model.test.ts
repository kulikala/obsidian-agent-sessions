import { describe, expect, it } from "vitest";
import { buildSessionHeader } from "../../src/ui/dialog-header-model";

const base = { id: "s1", agent: "claude", name: null, label: null };

describe("buildSessionHeader", () => {
	it("splits the category from the name, as the row does", () => {
		const h = buildSessionHeader({ ...base, name: "Skills: Session management" });
		expect(h).toEqual({ agent: "claude", label: "Session management", category: "Skills", tooltip: "Session management" });
	});

	it("has no category for a plain name", () => {
		const h = buildSessionHeader({ ...base, agent: "codex", name: "Fix the build" });
		expect(h.category).toBeNull();
		expect(h.label).toBe("Fix the build");
		expect(h.agent).toBe("codex");
	});

	it("keeps colons after the first separator in the name", () => {
		const h = buildSessionHeader({ ...base, name: "Dev: Parse a: b" });
		expect(h.category).toBe("Dev");
		expect(h.label).toBe("Parse a: b");
	});

	it("falls back to the first-prompt label, then the agent's placeholder", () => {
		expect(buildSessionHeader({ ...base, label: "Look at the logs" }).label).toBe("Look at the logs");
		expect(buildSessionHeader({ ...base, label: "s1" }).label.length).toBeGreaterThan(0);
		expect(buildSessionHeader({ ...base, label: "s1" }).category).toBeNull();
	});
});
