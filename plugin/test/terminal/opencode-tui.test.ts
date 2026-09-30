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
		expect(managedKeybinds("alt+enter", "ctrl+g")).toEqual({
			input_submit: "linefeed,ctrl+j",
			input_newline: "return,shift+return,ctrl+return",
			editor_open: "ctrl+g",
		});
		expect(managedKeybinds("shift+enter", "ctrl+g").input_newline).toBe("return,ctrl+return,alt+return");
		expect(managedKeybinds("ctrl+enter", "ctrl+g").input_newline).toBe("return,shift+return,alt+return");
		expect(managedKeybinds("cmd+enter", "ctrl+g").input_newline).toBe("return,shift+return,ctrl+return,alt+return");
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
		expect(applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g").status).toBe("written");
		expect(read()).toEqual({ keybinds: managedKeybinds("alt+enter", "ctrl+g") });
		expect(restoreOpencodeTui(backup).status).toBe("restored");
		expect(existsSync(tui)).toBe(false);
		expect(existsSync(backup)).toBe(false);
	});

	it("keeps other keys and the indent, and restores the user's own values", () => {
		writeFileSync(
			tui,
			'{\n\t"theme": "x",\n\t"keybinds": {\n\t\t"leader": "ctrl+x",\n\t\t"input_newline": "ctrl+j"\n\t}\n}\n'
		);
		expect(applyOpencodeTui(tui, backup, "shift+enter", "ctrl+g").status).toBe("written");
		const text = readFileSync(tui, "utf8");
		expect(text).toContain('\n\t"theme": "x"');
		expect(text.endsWith("}\n")).toBe(true);
		expect(read()).toEqual({
			theme: "x",
			keybinds: { leader: "ctrl+x", ...managedKeybinds("shift+enter", "ctrl+g") },
		});
		expect(restoreOpencodeTui(backup).status).toBe("restored");
		expect(read()).toEqual({ theme: "x", keybinds: { leader: "ctrl+x", input_newline: "ctrl+j" } });
	});

	it("keeps the first previous values across a change of submit key", () => {
		writeFileSync(tui, JSON.stringify({ keybinds: { input_submit: "ctrl+s" } }));
		applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g");
		expect(applyOpencodeTui(tui, backup, "shift+enter", "ctrl+g").status).toBe("written");
		expect((read() as { keybinds: Record<string, string> }).keybinds.input_newline).toBe(
			managedKeybinds("shift+enter", "ctrl+g").input_newline
		);
		restoreOpencodeTui(backup);
		expect(read()).toEqual({ keybinds: { input_submit: "ctrl+s" } });
	});

	it("is a no-op the second time", () => {
		applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g");
		expect(applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g").status).toBe("unchanged");
	});

	it("refuses a file that isn't plain JSON and writes nothing", () => {
		const text = '{\n  // mine\n  "theme": "x",\n}\n';
		writeFileSync(tui, text);
		const r = applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g");
		expect(r.status).toBe("failed");
		expect(r.warning).toContain(tui);
		expect(readFileSync(tui, "utf8")).toBe(text);
		expect(existsSync(backup)).toBe(false);
	});

	it("refuses a non-object keybinds", () => {
		writeFileSync(tui, '{"keybinds": []}');
		expect(applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g").status).toBe("failed");
	});

	it("leaves a key the user changed after we wrote it", () => {
		applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g");
		const obj = read() as { keybinds: Record<string, string> };
		obj.keybinds.input_submit = "ctrl+s";
		writeFileSync(tui, JSON.stringify(obj));
		restoreOpencodeTui(backup);
		expect(read()).toEqual({ keybinds: { input_submit: "ctrl+s" } });
	});
});

describe("managedKeybinds with the editor key", () => {
	it("always carries editor_open in OpenCode's own key syntax, and the submit pair only off Enter", () => {
		expect(managedKeybinds("enter", "ctrl+g")).toEqual({ editor_open: "ctrl+g" });
		expect(managedKeybinds("enter", "ctrl+q")).toEqual({ editor_open: "ctrl+q" });
		expect(managedKeybinds("enter", "alt+g")).toEqual({ editor_open: "alt+g" });
		expect(managedKeybinds("alt+enter", "ctrl+q")).toEqual({
			input_submit: "linefeed,ctrl+j",
			input_newline: "return,shift+return,ctrl+return",
			editor_open: "ctrl+q",
		});
	});
});

describe("editor_open", () => {
	it("is written for Enter submit, backed up, and restored (file removed when created by us)", () => {
		expect(applyOpencodeTui(tui, backup, "enter", "ctrl+g").status).toBe("written");
		expect(read()).toEqual({ keybinds: { editor_open: "ctrl+g" } });
		expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual({
			path: tui,
			editor_open: null,
			managed: { editor_open: "ctrl+g" },
			created_keybinds: true,
			created_file: true,
		});
		expect(restoreOpencodeTui(backup).status).toBe("restored");
		expect(existsSync(tui)).toBe(false);
		expect(existsSync(backup)).toBe(false);
	});

	it("remembers the user's own editor_open and puts it back", () => {
		writeFileSync(tui, JSON.stringify({ keybinds: { leader: "ctrl+x", editor_open: "<leader>o" } }));
		applyOpencodeTui(tui, backup, "enter", "ctrl+g");
		expect(read()).toEqual({ keybinds: { leader: "ctrl+x", editor_open: "ctrl+g" } });
		applyOpencodeTui(tui, backup, "enter", "alt+g");
		expect(read()).toEqual({ keybinds: { leader: "ctrl+x", editor_open: "alt+g" } });
		expect(restoreOpencodeTui(backup).status).toBe("restored");
		expect(read()).toEqual({ keybinds: { leader: "ctrl+x", editor_open: "<leader>o" } });
	});

	it("is a no-op the second time", () => {
		applyOpencodeTui(tui, backup, "enter", "ctrl+q");
		expect(applyOpencodeTui(tui, backup, "enter", "ctrl+q").status).toBe("unchanged");
	});

	it("keeps the editor key when the submit key goes back to Enter, and the submit keys when the editor key changes", () => {
		applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g");
		expect(applyOpencodeTui(tui, backup, "enter", "ctrl+g").status).toBe("written");
		expect(read()).toEqual({ keybinds: { editor_open: "ctrl+g" } });
		expect(JSON.parse(readFileSync(backup, "utf8")).managed).toEqual({ editor_open: "ctrl+g" });
		applyOpencodeTui(tui, backup, "shift+enter", "ctrl+q");
		expect(read()).toEqual({ keybinds: { ...managedKeybinds("shift+enter", "ctrl+q") } });
		restoreOpencodeTui(backup);
		expect(existsSync(tui)).toBe(false);
	});

	it("hands back only the released key and leaves one the user changed since", () => {
		writeFileSync(tui, JSON.stringify({ keybinds: { input_submit: "ctrl+s", editor_open: "<leader>o" } }));
		applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g");
		applyOpencodeTui(tui, backup, "enter", "ctrl+g");
		expect(read()).toEqual({ keybinds: { input_submit: "ctrl+s", editor_open: "ctrl+g" } });
		const obj = read() as { keybinds: Record<string, string> };
		obj.keybinds.editor_open = "ctrl+e";
		writeFileSync(tui, JSON.stringify(obj));
		expect(restoreOpencodeTui(backup).status).toBe("unchanged");
		expect(read()).toEqual({ keybinds: { input_submit: "ctrl+s", editor_open: "ctrl+e" } });
		expect(existsSync(backup)).toBe(false);
	});

	it("reads a backup written before editor_open existed", () => {
		const old = managedKeybinds("alt+enter", "ctrl+g");
		writeFileSync(tui, JSON.stringify({ keybinds: { input_submit: old.input_submit, input_newline: old.input_newline } }));
		writeFileSync(
			backup,
			JSON.stringify({
				path: tui,
				input_submit: "return",
				input_newline: null,
				managed: { input_submit: old.input_submit, input_newline: old.input_newline },
				created_keybinds: false,
				created_file: false,
			})
		);
		expect(applyOpencodeTui(tui, backup, "alt+enter", "ctrl+g").status).toBe("written");
		expect(read()).toEqual({ keybinds: { ...old } });
		restoreOpencodeTui(backup);
		expect(read()).toEqual({ keybinds: { input_submit: "return" } });
	});
});

describe("syncOpencodeTui", () => {
	it("manages while enabled (editor key even on Enter), restores when disabled", () => {
		expect(syncOpencodeTui(tui, backup, "alt+enter", "ctrl+g", true).status).toBe("written");
		expect(syncOpencodeTui(tui, backup, "enter", "ctrl+g", true).status).toBe("written");
		expect(read()).toEqual({ keybinds: { editor_open: "ctrl+g" } });
		expect(syncOpencodeTui(tui, backup, "enter", "ctrl+g", false).status).toBe("restored");
		expect(existsSync(tui)).toBe(false);
		expect(syncOpencodeTui(tui, backup, "enter", "ctrl+g", false).status).toBe("unchanged");
	});

	it("moves to the new file when the config folder moves", () => {
		syncOpencodeTui(tui, backup, "enter", "ctrl+g", true);
		const other = join(dir, "other", "tui.json");
		expect(syncOpencodeTui(other, backup, "enter", "ctrl+g", true).status).toBe("written");
		expect(existsSync(tui)).toBe(false);
		expect(JSON.parse(readFileSync(other, "utf8"))).toEqual({ keybinds: { editor_open: "ctrl+g" } });
	});
});
