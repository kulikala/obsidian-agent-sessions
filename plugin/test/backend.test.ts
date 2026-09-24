import { describe, expect, it } from "vitest";
import { defaultLoginShell, envWithVault } from "../src/backend";

describe("envWithVault（T-80：json … を呼ぶすべての経路に AGENT_SESSIONS_VAULT を通す）", () => {
	it("base に AGENT_SESSIONS_VAULT を重ねる", () => {
		const base = { PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "old" };
		const result = envWithVault("/tmp/vault", base);
		expect(result).toEqual({ PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "/tmp/vault" });
	});

	it("base に無ければ追加するだけ", () => {
		const result = envWithVault("/tmp/vault", { PATH: "/usr/bin" });
		expect(result).toEqual({ PATH: "/usr/bin", AGENT_SESSIONS_VAULT: "/tmp/vault" });
	});

	it("base を書き換えない（新しいオブジェクトを返す）", () => {
		const base = { PATH: "/usr/bin" };
		const result = envWithVault("/tmp/vault", base);
		expect(base).toEqual({ PATH: "/usr/bin" });
		expect(result).not.toBe(base);
	});
});

describe("defaultLoginShell（非macOS対応：$SHELL が無いときの既定）", () => {
	it("macOS は zsh", () => {
		expect(defaultLoginShell(true)).toBe("/bin/zsh");
	});

	it("非 macOS は sh（bash が無い最小環境もあるため）", () => {
		expect(defaultLoginShell(false)).toBe("/bin/sh");
	});
});
