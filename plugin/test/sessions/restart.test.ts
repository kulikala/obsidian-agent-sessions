import { describe, expect, it } from "vitest";
import { restartDecision } from "../../src/sessions/restart";

describe("restartDecision", () => {
	it("is disabled when the session isn't running", () => {
		expect(restartDecision({ running: false, resumable: true, status: "exited" })).toEqual({
			enabled: false,
			needsConfirm: false,
		});
	});

	it("is disabled without a resumable id, even when busy", () => {
		expect(restartDecision({ running: true, resumable: false, status: "working" })).toEqual({
			enabled: false,
			needsConfirm: false,
		});
	});

	it.each(["idle", "waiting", "asking", "detached", "compacted", "editing", "connecting"] as const)(
		"restarts a %s session without asking",
		(status) => {
			expect(restartDecision({ running: true, resumable: true, status })).toEqual({
				enabled: true,
				needsConfirm: false,
			});
		}
	);

	it.each(["working", "running-shell"] as const)("asks before restarting a %s session", (status) => {
		expect(restartDecision({ running: true, resumable: true, status })).toEqual({
			enabled: true,
			needsConfirm: true,
		});
	});
});
