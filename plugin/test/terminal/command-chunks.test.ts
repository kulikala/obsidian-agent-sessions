import { describe, expect, it } from "vitest";
import { commandChunks, oneLineName, PASTE_BEGIN, PASTE_END, pasteSafe, renameCommand, STASH } from "../../src/terminal/command-chunks";

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

describe("control characters cannot leave the paste", () => {
	// A name that ends the paste, clears the line (Ctrl+U) and types its own prompt.
	const hostile = "x\x1b[201~\x15say hi\r\x1b[200~\x7f\x9b201~";
	const count = (text: string, part: string): number => text.split(part).length - 1;

	it("a /rename keeps one paste and no control characters", () => {
		const command = renameCommand(hostile);
		expect(command).toBe("/rename x[201~say hi [200~201~");
		for (const agent of ["claude", "codex", "opencode"] as const) {
			const sent = commandChunks(command, agent, false, "\r", "darwin").join("");
			expect(count(sent, PASTE_BEGIN)).toBe(1);
			expect(count(sent, PASTE_END)).toBe(1);
			expect(sent.indexOf(PASTE_END)).toBeGreaterThan(sent.indexOf("say hi"));
			// eslint-disable-next-line no-control-regex -- the test deliberately matches the line-kill, DEL and CSI control characters
			expect(sent).not.toMatch(/[\x15\x7f\x9b]/);
		}
	});

	it("any command text is pasted without control characters but tabs and line breaks", () => {
		const sent = commandChunks(`line one\n\tline two${hostile}`, "claude", false, "\r", "darwin")[0];
		expect(count(sent, PASTE_END)).toBe(1);
		expect(sent).toContain("line one\n\tline two");
		expect(pasteSafe("a\x00b\x1bc\x7fd\x85e\r\n")).toBe("abcde\r\n");
	});

	it("a name is one line", () => {
		expect(oneLineName("a\nb\tc\x1b[0m")).toBe("a b c[0m");
		expect(oneLineName("Work: 修正")).toBe("Work: 修正");
	});
});
