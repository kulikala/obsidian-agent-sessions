import { describe, expect, it } from "vitest";
import { commandChunks, PASTE_BEGIN, PASTE_END, STASH } from "../../src/terminal/command-chunks";

const paste = (text: string): string => PASTE_BEGIN + text + PASTE_END;

describe("commandChunks", () => {
	it("Claude: stash over a draft, Tab after a bare command, the submit key last", () => {
		expect(commandChunks("/rename A: B", "claude", false, "\r", "darwin")).toEqual([paste("/rename A: B") + "\r"]);
		expect(commandChunks("/rename A: B", "claude", true, "\x1b\r", "darwin")).toEqual([STASH + paste("/rename A: B") + "\x1b\r"]);
		expect(commandChunks("/compact", "claude", false, "\r", "darwin")).toEqual([paste("/compact"), "\t", "\r"]);
	});

	it("Codex: one write with an argument, a trailing space and a second write for a bare command", () => {
		expect(commandChunks("/rename A: B", "codex", false, "\r", "darwin")).toEqual([paste("/rename A: B") + "\r"]);
		expect(commandChunks("/compact", "codex", true, "\x1b\r", "linux")).toEqual([paste("/compact "), "\x1b\r"]);
	});

	it("Codex on Windows: the submit key always in its own write, after the pasted keys", () => {
		expect(commandChunks("/rename A: B", "codex", false, "\r", "win32")).toEqual([paste("/rename A: B"), "\r"]);
		expect(commandChunks("/compact", "codex", false, "\r", "win32")).toEqual([paste("/compact "), "\r"]);
		expect(commandChunks("/rename A: B", "claude", false, "\r", "win32")).toEqual([paste("/rename A: B") + "\r"]);
	});

	it("OpenCode: always `\\r`, in its own write, and no stash", () => {
		expect(commandChunks("/compact", "opencode", true, "\x1b\r", "darwin")).toEqual([paste("/compact"), "\r"]);
	});
});
