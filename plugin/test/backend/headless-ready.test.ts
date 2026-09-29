import { describe, expect, it } from "vitest";
import { waitUntilReady, type ReadyOptions } from "../../src/backend/headless-ready";

/** A fake clock: `sleep` advances it, and `script` may change state at given times. */
function harness(over: Partial<ReadyOptions> & { script?: (t: number) => void }) {
	let t = 0;
	const opts: ReadyOptions = {
		agent: "opencode",
		status: () => null,
		lastOutputAt: () => null,
		now: () => t,
		sleep: async (ms) => {
			t += ms;
			over.script?.(t);
		},
		timeoutMs: 10_000,
		quietMs: 1500,
		pollMs: 250,
		...over,
	};
	return { opts, time: () => t };
}

describe("waitUntilReady", () => {
	it("is ready at once on idle, for any agent", async () => {
		for (const agent of ["claude", "codex", "opencode"] as const) {
			const { opts } = harness({ agent, status: () => "idle" });
			await expect(waitUntilReady(opts)).resolves.toBe(true);
		}
	});

	it("OpenCode with no status is ready once the terminal has been quiet for quietMs", async () => {
		let lastOutput: number | null = null;
		const { opts, time } = harness({
			lastOutputAt: () => lastOutput,
			script: (t) => {
				if (t <= 2000) {
					lastOutput = t; // still drawing
				}
			},
		});
		await expect(waitUntilReady(opts)).resolves.toBe(true);
		expect(time()).toBeGreaterThanOrEqual(2000 + 1500);
	});

	it("does not treat silence before any output as ready", async () => {
		const { opts } = harness({ timeoutMs: 3000 });
		await expect(waitUntilReady(opts)).resolves.toBe(false);
	});

	it("busy or waiting is never ready, however quiet", async () => {
		for (const status of ["busy", "waiting"]) {
			const { opts } = harness({ status: () => status, lastOutputAt: () => 0, timeoutMs: 5000 });
			await expect(waitUntilReady(opts)).resolves.toBe(false);
		}
	});

	it("Claude and Codex keep waiting for idle: quiet is not enough", async () => {
		for (const agent of ["claude", "codex"] as const) {
			const { opts } = harness({ agent, lastOutputAt: () => 0, timeoutMs: 5000 });
			await expect(waitUntilReady(opts)).resolves.toBe(false);
		}
	});

	it("becomes ready when the status turns idle later", async () => {
		let status: string | null = "busy";
		const { opts } = harness({
			status: () => status,
			script: (t) => {
				if (t >= 3000) {
					status = "idle";
				}
			},
		});
		await expect(waitUntilReady(opts)).resolves.toBe(true);
	});
});
