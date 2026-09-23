import { describe, expect, it } from "vitest";
import { envWithVault } from "../src/backend";

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
