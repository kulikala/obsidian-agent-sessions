import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyCodexConfig,
	defaultCodexConfigPath,
	hasAnyKey,
	looksMalformed,
	MANAGED_MARKER,
	removeManagedKey,
	upsertManagedKey,
} from "../../src/terminal/codex-config";
import { sendSequence } from "../../src/terminal/keys";

// A trimmed, anonymized shape of a real ~/.codex/config.toml (T-108's own research fixture) —
// personality/model/mcp_servers/projects/notice/plugins before [tui], [tui] itself already
// carrying a user-set status_line, no [tui.keymap.*] tables at all.
const REAL_CONFIG_FIXTURE = `personality = "pragmatic"
model = "gpt-5.6-luna"
model_reasoning_effort = "medium"

[mcp_servers.pencil]
command = "/path/to/mcp-server"
args = [ "--app", "visual_studio_code", "--agent", "codexCLI" ]

[projects."/Users/example/work/project-a"]
trust_level = "trusted"

[notice.model_migrations]
"gpt-5.3-codex" = "gpt-5.4"

[plugins."github@openai-curated"]
enabled = true

[tui]
screen_reader_detection_done = true
status_line = ["model-with-reasoning", "thread-name", "run-state", "context-used"]
status_line_use_colors = true
`;

describe("upsertManagedKey", () => {
	it("creates a brand-new table (header marked) when the table doesn't exist at all", () => {
		const { text, changed, conflict } = upsertManagedKey("", "tui.keymap.composer", "submit", `"alt-enter"`);
		expect(changed).toBe(true);
		expect(conflict).toBe(false);
		expect(text).toBe(`[tui.keymap.composer] ${MANAGED_MARKER}\nsubmit = "alt-enter" ${MANAGED_MARKER}\n`);
	});

	it("appends the new section after existing content, with a blank line separating it", () => {
		const { text } = upsertManagedKey('model = "x"\n', "tui.keymap.composer", "submit", `"alt-enter"`);
		expect(text).toBe(`model = "x"\n\n[tui.keymap.composer] ${MANAGED_MARKER}\nsubmit = "alt-enter" ${MANAGED_MARKER}\n`);
	});

	it("adds a marked key to an existing table without marking its header", () => {
		const before = "[tui]\nscreen_reader_detection_done = true\n";
		const { text, changed, conflict } = upsertManagedKey(before, "tui", "status_line", `["model-with-reasoning", "context-used"]`);
		expect(changed).toBe(true);
		expect(conflict).toBe(false);
		expect(text).toBe(`[tui]\nscreen_reader_detection_done = true\nstatus_line = ["model-with-reasoning", "context-used"] ${MANAGED_MARKER}\n`);
	});

	it("is a no-op when the exact marked line already exists", () => {
		const before = upsertManagedKey("", "tui.keymap.composer", "submit", `"alt-enter"`).text;
		const { text, changed } = upsertManagedKey(before, "tui.keymap.composer", "submit", `"alt-enter"`);
		expect(changed).toBe(false);
		expect(text).toBe(before);
	});

	it("replaces its own previous value in place when the desired value changes", () => {
		const before = upsertManagedKey("", "tui.keymap.editor", "insert_newline", `["enter", "shift-enter"]`).text;
		const { text, changed } = upsertManagedKey(before, "tui.keymap.editor", "insert_newline", `["enter", "alt-enter"]`);
		expect(changed).toBe(true);
		expect(text).toBe(`[tui.keymap.editor] ${MANAGED_MARKER}\ninsert_newline = ["enter", "alt-enter"] ${MANAGED_MARKER}\n`);
	});

	it("never overwrites a pre-existing, unmarked key — reports a conflict instead", () => {
		const before = `[tui.keymap.composer]\nsubmit = "ctrl-j"\n`;
		const { text, changed, conflict } = upsertManagedKey(before, "tui.keymap.composer", "submit", `"alt-enter"`);
		expect(changed).toBe(false);
		expect(conflict).toBe(true);
		expect(text).toBe(before);
	});

	it("doesn't confuse a differently-named key that merely starts with the same prefix (status_line vs status_line_use_colors)", () => {
		const before = "[tui]\nstatus_line_use_colors = true\n";
		const { text, changed } = upsertManagedKey(before, "tui", "status_line", `["model-with-reasoning", "context-used"]`);
		expect(changed).toBe(true);
		expect(text).toBe(`[tui]\nstatus_line_use_colors = true\nstatus_line = ["model-with-reasoning", "context-used"] ${MANAGED_MARKER}\n`);
	});

	it("stops a table's range at the next header, even a dotted sub-table of the same name", () => {
		const before = `[tui]\nscreen_reader_detection_done = true\n\n[tui.keymap.composer]\nsubmit = "ctrl-j"\n`;
		const { text } = upsertManagedKey(before, "tui", "status_line", `["model-with-reasoning", "context-used"]`);
		// Inserted right after [tui]'s own content, before [tui.keymap.composer] — not appended
		// at the very end of the file inside the unrelated table.
		expect(text).toBe(
			`[tui]\nscreen_reader_detection_done = true\nstatus_line = ["model-with-reasoning", "context-used"] ${MANAGED_MARKER}\n\n[tui.keymap.composer]\nsubmit = "ctrl-j"\n`
		);
	});

	it("against the real config.toml fixture: adds new tables at the end, leaving everything else byte-for-byte", () => {
		const step1 = upsertManagedKey(REAL_CONFIG_FIXTURE, "tui.keymap.composer", "submit", `"alt-enter"`);
		expect(step1.changed).toBe(true);
		const step2 = upsertManagedKey(step1.text, "tui.keymap.editor", "insert_newline", `["enter", "shift-enter"]`);
		expect(step2.changed).toBe(true);
		expect(step2.text.startsWith(REAL_CONFIG_FIXTURE)).toBe(true);
		expect(step2.text).toContain(`[tui.keymap.composer] ${MANAGED_MARKER}\nsubmit = "alt-enter" ${MANAGED_MARKER}\n`);
		expect(step2.text).toContain(`[tui.keymap.editor] ${MANAGED_MARKER}\ninsert_newline = ["enter", "shift-enter"] ${MANAGED_MARKER}\n`);
	});
});

describe("removeManagedKey", () => {
	it("removes a managed key's line, leaving the header (even if the table is now empty)", () => {
		const before = upsertManagedKey("", "tui.keymap.composer", "submit", `"alt-enter"`).text;
		const { text, changed } = removeManagedKey(before, "tui.keymap.composer", "submit");
		expect(changed).toBe(true);
		expect(text).toBe(`[tui.keymap.composer] ${MANAGED_MARKER}\n`);
	});

	it("is a no-op when the key doesn't exist", () => {
		const before = "[tui.keymap.composer]\n";
		const { text, changed } = removeManagedKey(before, "tui.keymap.composer", "submit");
		expect(changed).toBe(false);
		expect(text).toBe(before);
	});

	it("is a no-op when the key exists but isn't marked (the user's own)", () => {
		const before = `[tui.keymap.composer]\nsubmit = "ctrl-j"\n`;
		const { text, changed } = removeManagedKey(before, "tui.keymap.composer", "submit");
		expect(changed).toBe(false);
		expect(text).toBe(before);
	});

	it("is a no-op when the table doesn't exist at all", () => {
		expect(removeManagedKey("", "tui.keymap.composer", "submit")).toEqual({ text: "", changed: false });
	});
});

describe("hasAnyKey", () => {
	it("is true for the user's own unmarked status_line (the real fixture's case)", () => {
		expect(hasAnyKey(REAL_CONFIG_FIXTURE, "tui", "status_line")).toBe(true);
	});

	it("is true for this feature's own previously-written status_line too", () => {
		const written = upsertManagedKey("[tui]\n", "tui", "status_line", `["model-with-reasoning", "context-used"]`).text;
		expect(hasAnyKey(written, "tui", "status_line")).toBe(true);
	});

	it("is false when the table doesn't exist, or exists without that key", () => {
		expect(hasAnyKey("", "tui", "status_line")).toBe(false);
		expect(hasAnyKey("[tui]\nstatus_line_use_colors = true\n", "tui", "status_line")).toBe(false);
	});
});

describe("looksMalformed", () => {
	it("is false for well-formed content, including the real fixture", () => {
		expect(looksMalformed(REAL_CONFIG_FIXTURE)).toBe(false);
		expect(looksMalformed("")).toBe(false);
	});

	it("is true for an odd number of triple-quoted delimiters (an unclosed multi-line string)", () => {
		expect(looksMalformed('model = """unterminated\n')).toBe(true);
	});

	it("is true for unbalanced brackets", () => {
		expect(looksMalformed("sandbox_permissions = [\"a\", \"b\"\n")).toBe(true);
	});
});

describe("applyCodexConfig (end-to-end, temp files only)", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-codex-config-"));
		filePath = join(dir, "config.toml");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("still writes the status_line default on a fresh file even when submitKey is enter (independent feature — no keymap lines though)", () => {
		const result = applyCodexConfig(filePath, "enter");
		expect(result.status).toBe("written");
		const text = readFileSync(filePath, "utf8");
		expect(text).toContain(`status_line = ["model-with-reasoning", "context-used"] ${MANAGED_MARKER}`);
		expect(text).not.toContain("submit =");
		expect(text).not.toContain("insert_newline =");
	});

	it("does nothing at all once status_line has already been set (by this feature) and submitKey stays enter", () => {
		applyCodexConfig(filePath, "enter"); // first call: writes the status_line default
		const result = applyCodexConfig(filePath, "enter"); // second call: nothing left to do
		expect(result).toEqual({ status: "unchanged" });
	});

	it("writes both keymap tables and the status_line default on a fresh file when submitKey isn't enter", () => {
		const result = applyCodexConfig(filePath, "shift+enter");
		expect(result.status).toBe("written");
		const text = readFileSync(filePath, "utf8");
		expect(text).toContain(`submit = "alt-enter" ${MANAGED_MARKER}`);
		expect(text).toContain(`insert_newline = ["enter", "shift-enter"] ${MANAGED_MARKER}`);
		expect(text).toContain(`status_line = ["model-with-reasoning", "context-used"] ${MANAGED_MARKER}`);
		// No backup for a file that didn't exist before.
		expect(readdirSync(dir)).toEqual(["config.toml"]);
	});

	it("is idempotent: applying the same submitKey twice makes no further change the second time", () => {
		applyCodexConfig(filePath, "ctrl+enter");
		const afterFirst = readFileSync(filePath, "utf8");
		const second = applyCodexConfig(filePath, "ctrl+enter");
		expect(second.status).toBe("unchanged");
		expect(readFileSync(filePath, "utf8")).toBe(afterFirst);
	});

	it("removes the keymap lines (leaving status_line) when submitKey reverts to enter, and backs up first", () => {
		applyCodexConfig(filePath, "alt+enter");
		const result = applyCodexConfig(filePath, "enter");
		expect(result.status).toBe("written");
		const text = readFileSync(filePath, "utf8");
		expect(text).not.toContain("submit =");
		expect(text).not.toContain("insert_newline =");
		expect(text).toContain("status_line ="); // untouched — a separate, independent feature
		const backups = readdirSync(dir).filter((f) => f.includes(".bak-"));
		expect(backups.length).toBe(1);
	});

	it("never touches an already-set status_line, and reports the keymap conflict too, against the real fixture", () => {
		writeFileSync(filePath, REAL_CONFIG_FIXTURE);
		// Pre-seed a conflicting, unmarked composer.submit the way a user might have it.
		writeFileSync(filePath, REAL_CONFIG_FIXTURE + `\n[tui.keymap.composer]\nsubmit = "ctrl-j"\n`);
		const result = applyCodexConfig(filePath, "cmd+enter");
		expect(result.warning).toContain("tui.keymap.composer.submit");
		const text = readFileSync(filePath, "utf8");
		// The pre-existing status_line (a real, user-set value) is completely untouched.
		expect(text).toContain('status_line = ["model-with-reasoning", "thread-name", "run-state", "context-used"]');
		expect(text).not.toContain(MANAGED_MARKER + "\nstatus_line");
		// The unmarked composer.submit is left exactly as it was.
		expect(text).toContain('submit = "ctrl-j"\n');
		expect(text).not.toContain("alt-enter");
		// editor.insert_newline still gets written (no conflict there).
		expect(text).toContain(`insert_newline = ["enter", "shift-enter"] ${MANAGED_MARKER}`);
	});

	it("fails without writing anything when the file looks malformed", () => {
		writeFileSync(filePath, 'model = """unterminated\n');
		const result = applyCodexConfig(filePath, "shift+enter");
		expect(result.status).toBe("failed");
		expect(readFileSync(filePath, "utf8")).toBe('model = """unterminated\n');
		expect(readdirSync(dir)).toEqual(["config.toml"]); // no backup written either
	});
});

describe("defaultCodexConfigPath", () => {
	it("uses ~/.codex by default", () => {
		expect(defaultCodexConfigPath("/home/x")).toBe(join("/home/x", ".codex", "config.toml"));
	});

	it("respects CODEX_HOME when given", () => {
		expect(defaultCodexConfigPath("/home/x", "/custom/codex-home")).toBe(join("/custom/codex-home", "config.toml"));
	});
});

// T-98's combination table (test/terminal/key-role.test.ts) covers sendSequence()'s own
// submit/newline byte mapping — that function has no agent concept at all (it never did, even
// before Codex), so there's nothing per-agent to add a "Codex column" to there. What's new for
// T-108 is that the *bytes it already sent* now have to agree with what applyCodexConfig() writes
// into Codex's own config.toml, exactly the same way they've always had to agree with Claude's
// keybindings.json (terminal/keybindings.ts's ENTER_KEYS). This cross-checks that agreement
// directly, against the same fixed values applyCodexConfig() uses.
describe("sendSequence × applyCodexConfig (T-108: the bytes sent must match what Codex's own config expects)", () => {
	it("submitKey=enter: submit is plain Enter (\\r) — matches Codex's own built-in default (composer.submit = Enter), which applyCodexConfig writes nothing to override", () => {
		expect(sendSequence("submit", "enter")).toBe("\r");
	});

	it("submitKey != enter (any of the 4): submit is always alt-enter (\\x1b\\r) — matches the one fixed binding applyCodexConfig always writes to composer.submit, regardless of which of the 4 is actually configured", () => {
		for (const key of ["shift+enter", "ctrl+enter", "alt+enter", "cmd+enter"] as const) {
			expect(sendSequence("submit", key)).toBe("\x1b\r");
		}
	});

	it("submitKey != enter: newline is plain Enter (\\r) — matches editor.insert_newline's written value, which still includes \"enter\"", () => {
		for (const key of ["shift+enter", "ctrl+enter", "alt+enter", "cmd+enter"] as const) {
			expect(sendSequence("newline", key)).toBe("\r");
		}
	});
});
