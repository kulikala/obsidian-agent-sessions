import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactedTracker } from "../src/compacted";

function mark(dir: string, id: string): void {
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ compactedAt: 1700000000 }), "utf8");
}

describe("CompactedTracker（T-77 追補：compact 直後・未入力の印）", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-compacted-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("ディレクトリが無ければ has は常に false（フックがまだ一度も走っていない）", () => {
		const tracker = new CompactedTracker(join(dir, "does-not-exist"));
		expect(tracker.has("a")).toBe(false);
	});

	it("<id>.json があれば has が true", () => {
		mark(dir, "a");
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(true);
		expect(tracker.has("b")).toBe(false);
	});

	it(".json 以外のファイルは無視する", () => {
		writeFileSync(join(dir, "a.json.tmp"), "{}", "utf8");
		writeFileSync(join(dir, "README"), "x", "utf8");
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(false);
		expect(tracker.has("a.json")).toBe(false);
	});

	it("refresh で読み直し、change を発火する", () => {
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(false);

		mark(dir, "a");
		let changes = 0;
		tracker.onChange(() => changes++);
		tracker.refresh();

		expect(tracker.has("a")).toBe(true);
		expect(changes).toBe(1);
	});

	it("マークが消えれば refresh の後 has が false に戻る（UserPromptSubmit・SessionEnd 相当）", () => {
		mark(dir, "a");
		const tracker = new CompactedTracker(dir);
		expect(tracker.has("a")).toBe(true);

		rmSync(join(dir, "a.json"));
		tracker.refresh();

		expect(tracker.has("a")).toBe(false);
	});

	it("watch/stop は例外を投げない（ディレクトリが後から出来ても）", () => {
		const missing = join(dir, "later");
		const tracker = new CompactedTracker(missing);
		const stop = tracker.watch();
		mkdirSync(missing);
		stop();
	});
});
