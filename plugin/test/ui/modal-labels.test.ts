import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../src/i18n";
import { modelAliasLabel, modelAliasShortLabel } from "../../src/ui/modal-labels";

afterEach(() => setLang("en"));

describe("modelAliasShortLabel", () => {
	it("shortens the long labels and leaves the rest alone", () => {
		expect(modelAliasShortLabel("opusplan")).toBe("Opus Plan");
		expect(modelAliasShortLabel("best")).toBe("Best");
		expect(modelAliasShortLabel("sonnet")).toBe(modelAliasLabel("sonnet"));
		expect(modelAliasLabel("opusplan").length).toBeGreaterThan("Opus Plan".length);
	});

	it("follows the language", () => {
		setLang("ja");
		expect(modelAliasShortLabel("best")).toBe("最良");
	});
});
