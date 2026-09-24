import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactedTracker } from "../src/compacted";

function mark(dir: string, id: string): void {
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ compactedAt: 1700000000 }), "utf8");
}

describe("CompactedTracker (marking a session as just-compacted with no input yet)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-compacted-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("has is always false when the directory doesn't exist (the hook has never run yet)", () => {
		const tracker = new CompactedTracker(join(dir, "does-not-exist"));
		expect(tracker.has("a")).toBe(false);
	});

	it("has is true when <id>.json exists", () => {
		mark(dir, "a");
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(true);
		expect(tracker.has("b")).toBe(false);
	});

	it("ignores files other than .json", () => {
		writeFileSync(join(dir, "a.json.tmp"), "{}", "utf8");
		writeFileSync(join(dir, "README"), "x", "utf8");
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(false);
		expect(tracker.has("a.json")).toBe(false);
	});

	it("reloads on refresh and fires change", () => {
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(false);

		mark(dir, "a");
		let changes = 0;
		tracker.onChange(() => changes++);
		tracker.refresh();

		expect(tracker.has("a")).toBe(true);
		expect(changes).toBe(1);
	});

	it("has goes back to false after refresh once the mark is gone (equivalent to UserPromptSubmit/SessionEnd)", () => {
		mark(dir, "a");
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(true);

		rmSync(join(dir, "a.json"));
		tracker.refresh();

		expect(tracker.has("a")).toBe(false);
	});

	it("watch/stop does not throw (even if the directory is created later)", () => {
		const missing = join(dir, "later");
		const tracker = new CompactedTracker(missing);
		const stop = tracker.watch();
		mkdirSync(missing);
		stop();
	});
});
