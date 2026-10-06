import { join } from "path";
import { describe, expect, it } from "vitest";
import { efficiencyDir, efficiencyRunDir, organizeDir, runtimeDir } from "../../src/backend/paths";

describe("runtimeDir", () => {
	it("is AGENT_SESSIONS_RUNTIME_DIR when set", () => {
		expect(runtimeDir({ AGENT_SESSIONS_RUNTIME_DIR: "/scratch/runtime" }, "/home/pat")).toBe("/scratch/runtime");
	});

	it("is ~/.agents/sessions when unset or empty", () => {
		expect(runtimeDir({}, "/home/pat")).toBe(join("/home/pat", ".agents", "sessions"));
		expect(runtimeDir({ AGENT_SESSIONS_RUNTIME_DIR: "" }, "/home/pat")).toBe(join("/home/pat", ".agents", "sessions"));
	});

	it("puts Organize's folder and token efficiency's folders under it", () => {
		const env = { AGENT_SESSIONS_RUNTIME_DIR: "/scratch/runtime" };
		expect(organizeDir(env)).toBe(join("/scratch/runtime", "organize"));
		expect(efficiencyRunDir(env)).toBe(join("/scratch/runtime", "efficiency-run"));
		expect(efficiencyDir(env)).toBe(join("/scratch/runtime", "efficiency"));
	});
});
