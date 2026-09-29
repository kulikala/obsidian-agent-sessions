import { describe, expect, it } from "vitest";
import { opencodePluginArgs, OPENCODE_PLUGIN_NOTICE, parseOpencodePluginStatus } from "../../src/backend/opencode-plugin";

describe("parseOpencodePluginStatus", () => {
	it("reads the status line at the end of the output", () => {
		expect(parseOpencodePluginStatus("opencode plugin: installed /x\nopencode-plugin: installed\n")).toBe("installed");
		expect(parseOpencodePluginStatus("no changes\nopencode-plugin: unchanged\n")).toBe("unchanged");
		expect(parseOpencodePluginStatus("x\nopencode-plugin: foreign")).toBe("foreign");
	});

	it("returns null without a (known) status line", () => {
		expect(parseOpencodePluginStatus("")).toBeNull();
		expect(parseOpencodePluginStatus("no changes\n")).toBeNull();
		expect(parseOpencodePluginStatus("opencode-plugin: exploding\n")).toBeNull();
	});
});

describe("opencodePluginArgs", () => {
	it("never lets remove touch anything but the plugin, nor update-only create it", () => {
		expect(opencodePluginArgs("install")).toEqual(["setup", "--opencode"]);
		expect(opencodePluginArgs("update-only")).toEqual(["setup", "--opencode", "--update-only"]);
		expect(opencodePluginArgs("remove")).toEqual(["setup", "--remove-opencode"]);
		expect(opencodePluginArgs("remove")).not.toContain("--remove");
	});
});

describe("OPENCODE_PLUGIN_NOTICE", () => {
	it("says something different for installed, updated, unchanged, foreign and removed", () => {
		const keys = (["installed", "updated", "unchanged", "foreign", "removed"] as const).map((s) => OPENCODE_PLUGIN_NOTICE[s]);
		expect(new Set(keys).size).toBe(5);
		expect(keys).not.toContain(null);
	});
});
