import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyOpencodeTui,
	defaultOpencodeTuiPath,
	managedKeybinds,
	restoreOpencodeTui,
	syncOpencodeTui,
} from "../../src/terminal/opencode-tui";

let dir: string;
let tui: string;
let backup: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oc-tui-"));
	tui = join(dir, "opencode", "tui.json");
	backup = join(dir, "backup.json");
	mkdirSync(join(dir, "opencode"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const read = (): unknown => JSON.parse(readFileSync(tui, "utf8"));

describe("managedKeybinds", () => {
	it("submits on linefeed and drops the submit key's own name from the newline list", () => {
		expect(managedKeybinds("alt+enter")).toEqual({
			input_submit: "linefeed,ctrl+j",
			input_newline: "return,shift+return,ctrl+return",
		});
		expect(managedKeybinds("shift+enter").input_newline).toBe("return,ctrl+return,alt+return");
		expect(managedKeybinds("ctrl+enter").input_newline).toBe("return,shift+return,alt+return");
		expect(managedKeybinds("cmd+enter").input_newline).toBe("return,shift+return,ctrl+return,alt+return");
	});
});

describe("defaultOpencodeTuiPath", () => {
	it("honours XDG_CONFIG_HOME", () => {
		expect(defaultOpencodeTuiPath("/h", "/x")).toBe("/x/opencode/tui.json");
		expect(defaultOpencodeTuiPath("/h")).toBe("/h/.config/opencode/tui.json");
	});
});

describe("applyOpencodeTui", () => {
	it("creates the file, and restoring removes it again", () => {
		expect(applyOpencodeTui(tui, backup, "alt+enter").status).toBe("written");
		expect(read()).toEqual({ keybinds: managedKeybinds("alt+enter") });
		expect(restoreOpencodeTui(backup).status).toBe("restored");
		expect(existsSync(tui)).toBe(false);
		expect(existsSync(backup)).toBe(false);
	});

	it("keeps other keys and the indent, and restores the user's own values", () => {
		writeFileSync(
			tui,
			'{\n\t"theme": "x",\n\t"keybinds": {\n\t\t"leader": "ctrl+x",\n\t\t"input_newline": "ctrl+j"\n\t}\n}\n'
		);
		expect(applyOpencodeTui(tui, backup, "shift+enter").status).toBe("written");
		const text = readFileSync(tui, "utf8");
		expect(text).toContain('\n\t"theme": "x"');
		expect(text.endsWith("}\n")).toBe(true);
		expect(read()).toEqual({
			theme: "x",
			keybinds: { leader: "ctrl+x", ...managedKeybinds("shift+enter") },
		});
		expect(restoreOpencodeTui(backup).status).toBe("restored");
		expect(read()).toEqual({ theme: "x", keybinds: { leader: "ctrl+x", input_newline: "ctrl+j" } });
	});

	it("keeps the first previous values across a change of submit key", () => {
		writeFileSync(tui, JSON.stringify({ keybinds: { input_submit: "ctrl+s" } }));
		applyOpencodeTui(tui, backup, "alt+enter");
		expect(applyOpencodeTui(tui, backup, "shift+enter").status).toBe("written");
		expect((read() as { keybinds: Record<string, string> }).keybinds.input_newline).toBe(
			managedKeybinds("shift+enter").input_newline
		);
		restoreOpencodeTui(backup);
		expect(read()).toEqual({ keybinds: { input_submit: "ctrl+s" } });
	});

	it("is a no-op the second time", () => {
		applyOpencodeTui(tui, backup, "alt+enter");
		expect(applyOpencodeTui(tui, backup, "alt+enter").status).toBe("unchanged");
	});

	it("refuses a file that isn't plain JSON and writes nothing", () => {
		const text = '{\n  // mine\n  "theme": "x",\n}\n';
		writeFileSync(tui, text);
		const r = applyOpencodeTui(tui, backup, "alt+enter");
		expect(r.status).toBe("failed");
		expect(r.warning).toContain(tui);
		expect(readFileSync(tui, "utf8")).toBe(text);
		expect(existsSync(backup)).toBe(false);
	});

	it("refuses a non-object keybinds", () => {
		writeFileSync(tui, '{"keybinds": []}');
		expect(applyOpencodeTui(tui, backup, "alt+enter").status).toBe("failed");
	});

	it("leaves a key the user changed after we wrote it", () => {
		applyOpencodeTui(tui, backup, "alt+enter");
		const obj = read() as { keybinds: Record<string, string> };
		obj.keybinds.input_submit = "ctrl+s";
		writeFileSync(tui, JSON.stringify(obj));
		restoreOpencodeTui(backup);
		expect(read()).toEqual({ keybinds: { input_submit: "ctrl+s" } });
	});
});

describe("syncOpencodeTui", () => {
	it("manages with a non-enter key while enabled, restores on enter or when disabled", () => {
		expect(syncOpencodeTui(tui, backup, "alt+enter", true).status).toBe("written");
		expect(syncOpencodeTui(tui, backup, "enter", true).status).toBe("restored");
		expect(existsSync(tui)).toBe(false);
		expect(syncOpencodeTui(tui, backup, "alt+enter", true).status).toBe("written");
		expect(syncOpencodeTui(tui, backup, "alt+enter", false).status).toBe("restored");
		expect(syncOpencodeTui(tui, backup, "enter", true).status).toBe("unchanged");
	});
});
