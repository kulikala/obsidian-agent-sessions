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

	it("生きている pid の台帳だけを持つ", () => {
		writeSession(dir, "alive.json", { pid: process.pid, sessionId: "alive-id", status: "idle" });
		writeSession(dir, "dead.json", { pid: DEAD_PID, sessionId: "dead-id", status: "idle" });

		const registry = new Registry(dir);

		expect(registry.get("alive-id")).not.toBeNull();
		expect(registry.get("dead-id")).toBeNull();
	});

	it("bridgeSessionId の有無から rc を出す", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy", bridgeSessionId: "b-1" });
		writeSession(dir, "b.json", { pid: process.pid, sessionId: "b", status: "busy" });

		const registry = new Registry(dir);

		expect(registry.get("a")?.rc).toBe(true);
		expect(registry.get("b")?.rc).toBe(false);
	});

	it("壊れた JSON のファイルは無視して他は読む", () => {
		writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
		writeSession(dir, "ok.json", { pid: process.pid, sessionId: "ok", status: "idle" });

		const registry = new Registry(dir);

		expect(registry.get("ok")).not.toBeNull();
	});

	it("refresh で読み直し、busy/shell → idle を onIdle で通知する", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		const registry = new Registry(dir);

		const idled: string[] = [];
		registry.onIdle((id) => idled.push(id));

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "idle" });
		registry.refresh();

		expect(idled).toEqual(["a"]);
		expect(registry.get("a")?.status).toBe("idle");
	});

	it("refresh で読み直し、idle → busy/shell を onBusy で通知する", () => {
		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "idle" });
		const registry = new Registry(dir);

		const busied: string[] = [];
		registry.onBusy((id) => busied.push(id));

		writeSession(dir, "a.json", { pid: process.pid, sessionId: "a", status: "busy" });
		registry.refresh();

		expect(busied).toEqual(["a"]);
		expect(registry.get("a")?.status).toBe("busy");
	});

	it("refresh のたびに onChange が呼ばれる", () => {
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
