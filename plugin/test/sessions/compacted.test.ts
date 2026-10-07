import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactedTracker, isCompacted } from "../../src/sessions/compacted";

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
		mkdirSync(missing, { recursive: true });
		stop();
	});

	it("watch creates a missing folder, so a mark written later is seen", async () => {
		const missing = join(dir, "fresh");
		const tracker = new CompactedTracker(missing, 10);
		const stop = tracker.watch();
		mark(missing, "a");
		// fs.watch fires late on a busy machine: wait for the change rather than a fixed time.
		for (let i = 0; i < 60 && !tracker.has("a"); i++) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(tracker.has("a")).toBe(true);
		stop();
	});
});

describe("isCompacted (the last substantive input is the compaction)", () => {
	it("the marker alone is enough", () => {
		expect(isCompacted(true, undefined, null)).toBe(true);
	});

	it("only local commands since the compaction (after_compact: clean) — whatever the ctx reads", () => {
		expect(isCompacted(false, "clean", undefined)).toBe(true);
		expect(isCompacted(false, "clean", 12)).toBe(true);
	});

	it("a prompt with no reply yet counts only while ctx reads 0%", () => {
		expect(isCompacted(false, "input", 0)).toBe(true);
		expect(isCompacted(false, "input", 4)).toBe(false);
		expect(isCompacted(false, "input", null)).toBe(false);
		expect(isCompacted(false, "input", undefined)).toBe(false);
	});

	it("nothing pending: not compacted, even at ctx 0% (a resumed session before its first turn)", () => {
		expect(isCompacted(false, undefined, 0)).toBe(false);
	});
});
