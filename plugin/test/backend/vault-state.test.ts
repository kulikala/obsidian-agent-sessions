import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeVaultState } from "../../src/backend/vault-state";

describe("writeVaultState", () => {
	let dir: string;
	let runtimeDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-sessions-vault-state-"));
		runtimeDir = join(dir, "sessions");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the vault path to vault.json", () => {
		writeVaultState(runtimeDir, "/tmp/some-vault");
		const data = JSON.parse(readFileSync(join(runtimeDir, "vault.json"), "utf8"));
		expect(data).toEqual({ vault: "/tmp/some-vault" });
	});

	it("creates the directory if it doesn't exist", () => {
		expect(existsSync(runtimeDir)).toBe(false);
		writeVaultState(runtimeDir, "/tmp/vault");
		expect(existsSync(join(runtimeDir, "vault.json"))).toBe(true);
	});

	it("doesn't leave a tmp file behind", () => {
		writeVaultState(runtimeDir, "/tmp/vault");
		const files = readdirSync(runtimeDir);
		expect(files).toEqual(["vault.json"]);
	});

	it("overwrites the file when written again", () => {
		writeVaultState(runtimeDir, "/tmp/vault-a");
		writeVaultState(runtimeDir, "/tmp/vault-b");
		const data = JSON.parse(readFileSync(join(runtimeDir, "vault.json"), "utf8"));
		expect(data).toEqual({ vault: "/tmp/vault-b" });
	});
});
