import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastInstructionIsCompact, readTailLines } from "../src/last-instruction";

function user(content: unknown, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });
}

function assistant(text: string): string {
	return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

const COMPACT = "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>";
const SUMMARY = "This session is being continued from a previous conversation that ran out of context. Summary: …";

describe("lastInstructionIsCompact（D-42）", () => {
	it("末尾の指示が /compact なら true（要約行・応答が後に続いても）", () => {
		const lines = [user("最初の指示"), assistant("はい"), user(COMPACT), user(SUMMARY, { isCompactSummary: true }), assistant("続けます")];
		expect(lastInstructionIsCompact(lines)).toBe(true);
	});

	it("/compact の後に人の指示があれば false", () => {
		const lines = [user(COMPACT), user(SUMMARY, { isCompactSummary: true }), user("次をやって")];
		expect(lastInstructionIsCompact(lines)).toBe(false);
	});

	it("別のスラッシュコマンドは false", () => {
		expect(lastInstructionIsCompact([user("<command-name>/rename</command-name>\n<command-args>x</command-args>")])).toBe(false);
	});

	it("tool_result だけの user 行・isMeta・local-command-stdout は飛ばす", () => {
		const lines = [
			user(COMPACT),
			user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
			user("<local-command-stdout>done</local-command-stdout>"),
			user("メタ", { isMeta: true }),
			user("<system-reminder>注意</system-reminder>"),
		];
		expect(lastInstructionIsCompact(lines)).toBe(true);
	});

	it("壊れた行・user 以外だけなら false", () => {
		expect(lastInstructionIsCompact(["{not json", assistant("x")])).toBe(false);
		expect(lastInstructionIsCompact([])).toBe(false);
	});
});

describe("readTailLines", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-tail-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("末尾の行を返し、途中で切れた先頭行は捨てる", () => {
		const path = join(dir, "t.jsonl");
		writeFileSync(path, "aaaa\nbbbb\ncccc\n", "utf8");
		expect(readTailLines(path, 7)).toEqual(["cccc", ""]);
		expect(readTailLines(path, 1000)).toEqual(["aaaa", "bbbb", "cccc", ""]);
	});

	it("無いファイルは空", () => {
		expect(readTailLines(join(dir, "missing.jsonl"))).toEqual([]);
	});
});
