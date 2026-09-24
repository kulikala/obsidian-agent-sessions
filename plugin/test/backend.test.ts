import { describe, expect, it } from "vitest";
import { defaultLoginShell, envWithVault } from "../src/backend";

describe("envWithVault (ensures every code path that calls json… gets AGENT_SESSIONS_VAULT)", () => {
	it("overlays AGENT_SESSIONS_VAULT onto the base env", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "old" };
		const result = envWithVault("/tmp/vault", base);
		expect(result).toEqual({ PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "/tmp/vault" });
	});

	it("just adds the key when the base env doesn't have it", () => {
		const result = envWithVault("/tmp/vault", { PATH: "/usr/bin" });
		expect(result).toEqual({ PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "/tmp/vault" });
	});

	it("does not mutate the base env (returns a new object)", () => {
		const base = { PATH: "/usr/bin" };
		const result = envWithVault("/tmp/vault", base);
		expect(base).toEqual({ PATH: "/usr/bin" });
		expect(result).not.toBe(base);
	});
});

describe("defaultLoginShell (non-macOS fallback when $SHELL is unset)", () => {
	it("is zsh on macOS", () => {
		expect(defaultLoginShell(true)).toBe("/bin/zsh");
	});

	it("is sh on non-macOS (some minimal environments lack bash)", () => {
		expect(defaultLoginShell(false)).toBe("/bin/sh");
	});
});
