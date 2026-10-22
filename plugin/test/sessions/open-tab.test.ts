import { describe, expect, it } from "vitest";
import { planOpenTab } from "../../src/sessions/open-tab";

const enabled = () => true;
const noTab = () => false;

describe("planOpenTab", () => {
	it("opens a Claude session as itself, without a daemon id, and remembers its name", () => {
		const decision = planOpenTab(
			{ session: "s1", agent: "claude", cwd: "/v", name: "Web: Login" },
			{ enabled, tabExists: noTab }
		);
		expect(decision).toEqual({
			ok: true,
			plan: {
				session: "s1",
				agent: "claude",
				cwd: "/v",
				daemonId: undefined,
				name: "Web: Login",
				rememberName: true,
				trackNewAgent: false,
			},
		});
	});

	it("attaches a linked Codex session to its daemon id and does not resolve it again", () => {
		const decision = planOpenTab(
			{ session: "thread-1", agent: "codex", cwd: "/v", daemon: "daemon-1", name: "Docs" },
			{ enabled, tabExists: noTab }
		);
		expect(decision).toMatchObject({
			ok: true,
			plan: { agent: "codex", daemonId: "daemon-1", rememberName: true, trackNewAgent: false },
		});
	});

	it("resolves an unlinked Codex/OpenCode daemon id (daemon absent or equal to session)", () => {
		for (const daemon of [undefined, "daemon-1"]) {
			const decision = planOpenTab(
				{ session: "daemon-1", agent: "opencode", cwd: "/v", daemon },
				{ enabled, tabExists: noTab }
			);
			expect(decision).toMatchObject({ ok: true, plan: { trackNewAgent: true } });
		}
	});

	it("does not remember a name when a tab already owns the session or its daemon id", () => {
		const req = { session: "thread-1", agent: "codex", cwd: "/v", daemon: "daemon-1", name: "Docs" };
		expect(planOpenTab(req, { enabled, tabExists: (id) => id === "thread-1" })).toMatchObject({
			ok: true,
			plan: { rememberName: false },
		});
		expect(planOpenTab(req, { enabled, tabExists: (id) => id === "daemon-1" })).toMatchObject({
			ok: true,
			plan: { rememberName: false },
		});
	});

	it("rejects an unknown or disabled agent", () => {
		expect(planOpenTab({ session: "s1", agent: "other", cwd: "/v" }, { enabled, tabExists: noTab })).toEqual({
			ok: false,
			error: "bad-request",
		});
		expect(
			planOpenTab({ session: "s1", agent: "claude", cwd: "/v" }, { enabled: () => false, tabExists: noTab })
		).toEqual({ ok: false, error: "agent-disabled" });
	});
});
