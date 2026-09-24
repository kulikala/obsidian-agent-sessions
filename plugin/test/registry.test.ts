import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry } from "../src/registry";

const DEAD_PID = 999999;

function writeSession(dir: string, name: string, data: Record<string, unknown>): void {
	writeFileSync(join(dir, name), JSON.stringify(data), "utf8");
}

describe("Registry", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-registry-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("only keeps records for a live pid", () => {
		writeSession(dir, "alive.json", { pid: process.pid, sessionId: "alive-id", status: "idle" });
		writeSession(dir, "dead.json", { pid: DEAD_PID, sessionId: "dead-id", status: "idle" });

		const registry = new Registry(dir);

		expect(registry.get("alive-id")).not.toBeNull();
		expect(registry.get("dead-id")).toBeNull();
	});

	it("derives rc from whether bridgeSessionId is present", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy", bridgeSessionId: "b-1" });
		writeSession(dir, "b.json", { pid: process.pid, sessionId: "b", status: "busy" });

		const registry = new Registry(dir);

		expect(registry.get("a")?.rc).toBe(true);
		expect(registry.get("b")?.rc).toBe(false);
	});

	it("passes waitingFor through unchanged (claude itself writes it when status is 'waiting')", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "waiting", waitingFor: "input needed" });
		writeSession(dir, "b.json", { pid: process.pid, sessionId: "b", status: "idle" });

		const registry = new Registry(dir);

		expect(registry.get("a")?.status).toBe("waiting");
		expect(registry.get("a")?.waitingFor).toBe("input needed");
		expect(registry.get("b")?.waitingFor).toBeUndefined();
	});

	it("waiting is distinct from busy/shell, so it doesn't fire onIdle/onBusy", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		const registry = new Registry(dir);

		const idled: string[] = [];
		const busied: string[] = [];
		registry.onIdle((id) => idled.push(id));
		registry.onBusy((id) => busied.push(id));

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "waiting", waitingFor: "permission prompt" });
		registry.refresh();

		expect(idled).toEqual([]);
		expect(busied).toEqual([]);
		expect(registry.get("a")?.status).toBe("waiting");
	});

	it("ignores a file with broken JSON and still reads the rest", () => {
		writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
		writeSession(dir, "ok.json", { pid: process.pid, sessionId: "ok", status: "idle" });

		const registry = new Registry(dir);

		expect(registry.get("ok")).not.toBeNull();
	});

	it("re-reads on refresh and reports busy/shell → idle via onIdle", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		const registry = new Registry(dir);

		const idled: string[] = [];
		registry.onIdle((id) => idled.push(id));

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "idle" });
		registry.refresh();

		expect(idled).toEqual(["a"]);
		expect(registry.get("a")?.status).toBe("idle");
	});

	it("re-reads on refresh and reports idle → busy/shell via onBusy", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "idle" });
		const registry = new Registry(dir);

		const busied: string[] = [];
		registry.onBusy((id) => busied.push(id));

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		registry.refresh();

		expect(busied).toEqual(["a"]);
		expect(registry.get("a")?.status).toBe("busy");
	});

	it("reports onBusy on the same refresh when an id observed for the first time is busy/shell", () => {
		const registry = new Registry(dir);
		const busied: string[] = [];
		registry.onBusy((id) => busied.push(id));

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		writeSession(dir, "b.json", { pid: process.pid, sessionId: "b", status: "idle" });
		writeSession(dir, "c.json", { pid: process.pid, sessionId: "c", status: "shell" });
		registry.refresh();

		expect(busied.sort()).toEqual(["a", "c"]);
	});

	it("waitFor resolves true immediately if already in that state", async () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "idle" });
		const registry = new Registry(dir);

		await expect(registry.waitFor("a", "idle", 1000)).resolves.toBe(true);
	});

	it("waitFor resolves true once refresh changes the state (even for an id seen for the first time)", async () => {
		const registry = new Registry(dir);
		const waiting = registry.waitFor("a", "idle", 5000);

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		registry.refresh();
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "idle" });
		registry.refresh();

		await expect(waiting).resolves.toBe(true);
	});

	it("waitFor's busy also matches shell", async () => {
		const registry = new Registry(dir);
		const waiting = registry.waitFor("a", "busy", 5000);
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "shell" });
		registry.refresh();
		await expect(waiting).resolves.toBe(true);
	});

	it("waitFor returns false on timeoutMs and stops listening for further change events", async () => {
		const registry = new Registry(dir);
		const before = registry.listenerCount("change");
		await expect(registry.waitFor("a", "idle", 20)).resolves.toBe(false);
		expect(registry.listenerCount("change")).toBe(before);
	});

	it("calls onChange on every refresh", () => {
		const registry = new Registry(dir);
		let calls = 0;
		const unsubscribe = registry.onChange(() => calls++);

		registry.refresh();
		registry.refresh();
		unsubscribe();
		registry.refresh();

		expect(calls).toBe(2);
	});
});
