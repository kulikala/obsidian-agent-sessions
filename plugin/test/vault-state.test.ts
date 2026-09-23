import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeVaultState } from "../src/vault-state";

describe("writeVaultState（T-80）", () => {
	let dir: string;
	let runtimeDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-vault-state-"));
		runtimeDir = join(dir, "sessions");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("vault のパスを vault.json に書く", () => {
		writeVaultState(runtimeDir, "/tmp/some-vault");
		const data = JSON.parse(readFileSync(join(runtimeDir, "vault.json"), "utf8"));
		expect(data).toEqual({ vault: "/tmp/some-vault" });
	});

	it("ディレクトリが無ければ作る", () => {
		expect(existsSync(runtimeDir)).toBe(false);
		writeVaultState(runtimeDir, "/tmp/vault");
		expect(existsSync(join(runtimeDir, "vault.json"))).toBe(true);
	});

	it("tmp ファイルを残さない", () => {
		writeVaultState(runtimeDir, "/tmp/vault");
		const files = readdirSync(runtimeDir);
		expect(files).toEqual(["vault.json"]);
	});

	it("書き直すと上書きされる", () => {
		writeVaultState(runtimeDir, "/tmp/vault-a");
		writeVaultState(runtimeDir, "/tmp/vault-b");
		const data = JSON.parse(readFileSync(join(runtimeDir, "vault.json"), "utf8"));
		expect(data).toEqual({ vault: "/tmp/vault-b" });
	});
});
