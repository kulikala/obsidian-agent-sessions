import { describe, expect, it } from "vitest";
import {
	aliasFromDisplay,
	EFFORT_CHOICES,
	KEEP,
	MODEL_ALIASES,
	planEditorSend,
	planModelChange,
	preselectedEffort,
	preselectedModel,
} from "../../src/terminal/model-switch";

const opusMedium = { display: "Opus 5.5", effort: "medium" };

describe("lists", () => {
	it("offers Claude Code's aliases and effort levels", () => {
		expect([...MODEL_ALIASES]).toEqual(["default", "best", "fable", "opus", "sonnet", "haiku", "sonnet[1m]", "opus[1m]", "opusplan"]);
		expect(EFFORT_CHOICES).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);
	});
});

describe("aliasFromDisplay / preselection", () => {
	it("maps a display name to its family alias", () => {
		expect(aliasFromDisplay("Opus 5.5")).toBe("opus");
		expect(aliasFromDisplay("Sonnet 5.5")).toBe("sonnet");
		expect(aliasFromDisplay("Haiku 4.5")).toBe("haiku");
		expect(aliasFromDisplay("Opus 5.5 (1M context)")).toBe("opus[1m]");
		expect(aliasFromDisplay("Mystery")).toBeNull();
		expect(aliasFromDisplay(null)).toBeNull();
	});

	it("preselects the current values, else keep", () => {
		expect(preselectedModel(opusMedium)).toBe("opus");
		expect(preselectedEffort(opusMedium)).toBe("medium");
		expect(preselectedModel({ display: null, effort: null })).toBe(KEEP);
		expect(preselectedEffort({ display: null, effort: "weird" })).toBe(KEEP);
	});
});

describe("planModelChange", () => {
	it("sends nothing when nothing changed", () => {
		expect(planModelChange(opusMedium, { model: "opus", effort: "medium" })).toEqual([]);
		expect(planModelChange(opusMedium, { model: KEEP, effort: KEEP })).toEqual([]);
	});

	it("sends only what changed, model first", () => {
		expect(planModelChange(opusMedium, { model: "sonnet", effort: "medium" })).toEqual(["/model sonnet"]);
		expect(planModelChange(opusMedium, { model: "opus", effort: "high" })).toEqual(["/effort high"]);
		expect(planModelChange(opusMedium, { model: "haiku", effort: "low" })).toEqual(["/model haiku", "/effort low"]);
	});

	it("takes a full model id and auto", () => {
		expect(planModelChange(opusMedium, { model: " claude-opus-5-5 ", effort: "auto" })).toEqual(["/model claude-opus-5-5", "/effort auto"]);
	});

	it("treats an empty Other… id as no change", () => {
		expect(planModelChange(opusMedium, { model: "", effort: KEEP })).toEqual([]);
	});
});

describe("planEditorSend", () => {
	it("is a plain send when unchanged", () => {
		expect(planEditorSend(opusMedium, { model: "opus", effort: "medium" })).toEqual({ kind: "plain" });
	});

	it("switches first when the model or effort changed", () => {
		expect(planEditorSend(opusMedium, { model: "opus", effort: "max" })).toEqual({ kind: "switch", commands: ["/effort max"] });
	});
});
