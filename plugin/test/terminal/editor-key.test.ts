import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCodexConfig, MANAGED_MARKER } from "../../src/terminal/codex-config";
import { applyEditorKey, applySubmitKey } from "../../src/terminal/keybindings";
import {
	agentDefaultEditorKey,
	agentEditorKeyName,
	editorKeyIsAgentDefault,
	editorKeyLabel,
} from "../../src/terminal/keys";
import { DEFAULT_EDITOR_KEY, EDITOR_KEYS, mergeSettings } from "../../src/settings";

describe("editor key names", () => {
	it("offers Ctrl+G first, and it is the default", () => {
		expect(EDITOR_KEYS).toEqual(["ctrl+g", "ctrl+q", "alt+g"]);
		expect(DEFAULT_EDITOR_KEY).toBe("ctrl+g");
		expect(mergeSettings({}).editorKey).toBe("ctrl+g");
	});

	it("spells each key in the agent's own syntax", () => {
		expect(EDITOR_KEYS.map((k) => agentEditorKeyName("claude", k))).toEqual(["ctrl+g", "ctrl+q", "meta+g"]);
		expect(EDITOR_KEYS.map((k) => agentEditorKeyName("codex", k))).toEqual(["ctrl-g", "ctrl-q", "alt-g"]);
		expect(EDITOR_KEYS.map((k) => agentEditorKeyName("opencode", k))).toEqual(["ctrl+g", "ctrl+q", "alt+g"]);
	});

	it("knows which agents already open their editor on Ctrl+G", () => {
		expect(agentDefaultEditorKey("claude")).toBe("ctrl+g");
		expect(agentDefaultEditorKey("codex")).toBe("ctrl+g");
		expect(agentDefaultEditorKey("opencode")).toBeNull();
		expect(editorKeyIsAgentDefault("claude", "ctrl+g")).toBe(true);
		expect(editorKeyIsAgentDefault("codex", "ctrl+q")).toBe(false);
		expect(editorKeyIsAgentDefault("opencode", "ctrl+g")).toBe(false);
	});

	it("labels Alt as Option on macOS", () => {
		expect(editorKeyLabel("alt+g", true)).toBe("Option+G");
		expect(editorKeyLabel("alt+g", false)).toBe("Alt+G");
		expect(editorKeyLabel("ctrl+q", true)).toBe("Ctrl+Q");
	});

	it("drops a saved editor key that is not offered", () => {
		expect(mergeSettings({ editorKey: "ctrl+e" }).editorKey).toBe("ctrl+g");
		expect(mergeSettings({ editorKey: "alt+g" }).editorKey).toBe("alt+g");
	});
});

describe("applyEditorKey (Claude Code keybindings.json)", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-editorkey-"));
		file = join(dir, "keybindings.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const read = () => JSON.parse(readFileSync(file, "utf8"));
	const chat = () => read().bindings.find((b: { context: string }) => b.context === "Chat").bindings;

	it("writes nothing for Ctrl+G, Claude Code's own key", () => {
		expect(applyEditorKey(file, "ctrl+g")).toEqual({ status: "unchanged" });
		expect(existsSync(file)).toBe(false);
	});

	it("binds Ctrl+Q to chat:externalEditor and frees Ctrl+G", () => {
		expect(applyEditorKey(file, "ctrl+q").status).toBe("written");
		expect(chat()).toEqual({ "ctrl+q": "chat:externalEditor", "ctrl+g": null });
		expect(read().$schema).toBe("https://www.schemastore.org/claude-code-keybindings.json");
		expect(applyEditorKey(file, "ctrl+q").status).toBe("unchanged");
	});

	it("uses meta+g for Alt/Option+G and moves from one key to the next", () => {
		applyEditorKey(file, "ctrl+q");
		expect(applyEditorKey(file, "alt+g").status).toBe("written");
		expect(chat()).toEqual({ "meta+g": "chat:externalEditor", "ctrl+g": null });
	});

	it("removes exactly its own keys, and the Chat block when nothing else is left", () => {
		applyEditorKey(file, "ctrl+q");
		expect(applyEditorKey(file, "ctrl+g").status).toBe("written");
		expect(read().bindings).toEqual([]);
	});

	it("keeps the user's other bindings and other contexts", () => {
		writeFileSync(
			file,
			JSON.stringify({
				bindings: [
					{ context: "Global", bindings: { "ctrl+k": "app:redraw" } },
					{ context: "Chat", bindings: { "ctrl+s": null, "ctrl+j": "chat:newline" } },
				],
			})
		);
		applyEditorKey(file, "ctrl+q");
		expect(chat()).toEqual({ "ctrl+s": null, "ctrl+j": "chat:newline", "ctrl+q": "chat:externalEditor", "ctrl+g": null });
		applyEditorKey(file, "ctrl+g");
		expect(read().bindings).toEqual([
			{ context: "Global", bindings: { "ctrl+k": "app:redraw" } },
			{ context: "Chat", bindings: { "ctrl+s": null, "ctrl+j": "chat:newline" } },
		]);
	});

	it("never overwrites a key that holds another action, and keeps Ctrl+G bound", () => {
		writeFileSync(file, JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+q": "chat:stash" } }] }));
		const r = applyEditorKey(file, "ctrl+q");
		expect(r.warning).toContain("ctrl+q");
		expect(chat()).toEqual({ "ctrl+q": "chat:stash" });
	});

	it("leaves a Ctrl+G the user bound to something else", () => {
		writeFileSync(file, JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+g": "chat:stash" } }] }));
		applyEditorKey(file, "ctrl+q");
		expect(chat()).toEqual({ "ctrl+g": "chat:stash", "ctrl+q": "chat:externalEditor" });
		applyEditorKey(file, "ctrl+g");
		expect(chat()).toEqual({ "ctrl+g": "chat:stash" });
	});

	it("does not remove a key of the same name the user pointed at another action, and says so", () => {
		writeFileSync(file, JSON.stringify({ bindings: [{ context: "Chat", bindings: { "ctrl+q": "chat:stash" } }] }));
		const r = applyEditorKey(file, "ctrl+g");
		expect(r.status).toBe("unchanged");
		expect(r.warning).toContain("ctrl+q");
		expect(chat()).toEqual({ "ctrl+q": "chat:stash" });
	});

	it("does not disturb the submit key's bindings, in either order", () => {
		applySubmitKey(file, "alt+enter");
		applyEditorKey(file, "ctrl+q");
		expect(chat()).toEqual({
			enter: "chat:newline",
			"meta+enter": "chat:submit",
			"ctrl+q": "chat:externalEditor",
			"ctrl+g": null,
		});
		applySubmitKey(file, "enter");
		expect(chat()).toEqual({ "ctrl+q": "chat:externalEditor", "ctrl+g": null });
		applySubmitKey(file, "alt+enter");
		applyEditorKey(file, "ctrl+g");
		expect(chat()).toEqual({ enter: "chat:newline", "meta+enter": "chat:submit" });
	});

	it("fails without writing when the file is not valid JSON", () => {
		writeFileSync(file, "{nope");
		const r = applyEditorKey(file, "ctrl+q");
		expect(r.status).toBe("failed");
		expect(readFileSync(file, "utf8")).toBe("{nope");
	});
});

describe("applyCodexConfig with the editor key", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-editorkey-codex-"));
		file = join(dir, "config.toml");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	const text = () => readFileSync(file, "utf8");

	it("writes open_external_editor under [tui.keymap.global] (table marked as ours) for a non-default key", () => {
		expect(applyCodexConfig(file, "enter", "ctrl+q").status).toBe("written");
		expect(text()).toContain(`[tui.keymap.global] ${MANAGED_MARKER}\nopen_external_editor = "ctrl-q" ${MANAGED_MARKER}\n`);
		applyCodexConfig(file, "enter", "alt+g");
		expect(text()).toContain(`open_external_editor = "alt-g" ${MANAGED_MARKER}`);
		expect(text()).not.toContain("ctrl-q");
	});

	it("writes nothing keymap-related for Ctrl+G and removes the line when going back", () => {
		applyCodexConfig(file, "enter", "ctrl+g");
		expect(text()).not.toContain("open_external_editor");
		applyCodexConfig(file, "enter", "ctrl+q");
		applyCodexConfig(file, "enter", "ctrl+g");
		expect(text()).not.toContain("open_external_editor");
	});

	it("is idempotent, and coexists with the submit-key lines", () => {
		applyCodexConfig(file, "alt+enter", "ctrl+q");
		const first = text();
		expect(first).toContain('submit = "alt-enter"');
		expect(first).toContain('open_external_editor = "ctrl-q"');
		expect(applyCodexConfig(file, "alt+enter", "ctrl+q").status).toBe("unchanged");
		applyCodexConfig(file, "enter", "ctrl+q");
		expect(text()).not.toContain("alt-enter");
		expect(text()).toContain('open_external_editor = "ctrl-q"');
	});

	it("leaves a user's own open_external_editor alone and warns", () => {
		writeFileSync(file, '[tui.keymap.global]\nopen_external_editor = "ctrl-o"\n');
		const r = applyCodexConfig(file, "enter", "ctrl+q");
		expect(r.warning).toContain("open_external_editor");
		expect(text()).toContain('[tui.keymap.global]\nopen_external_editor = "ctrl-o"\n');
		expect(text()).not.toContain("ctrl-q");
	});

	it("statusLine: false (Codex switched off) removes the key lines and writes no status_line", () => {
		applyCodexConfig(file, "alt+enter", "ctrl+q");
		expect(applyCodexConfig(file, "alt+enter", "ctrl+q", { statusLine: false }).status).toBe("written");
		expect(text()).not.toContain("open_external_editor");
		expect(text()).not.toContain('submit = "alt-enter"');
		expect(text()).toContain("status_line");
	});

	it("statusLine: false leaves a missing file missing", () => {
		expect(applyCodexConfig(file, "enter", "ctrl+g", { statusLine: false }).status).toBe("unchanged");
		expect(existsSync(file)).toBe(false);
	});
});
