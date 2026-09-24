// Writes the vault's location to `~/.agents/sessions/vault.json`. `agent-sessions` has no
// default vault, so the Python side (`_resolve_vault` in `agentsessions/config.py`) reads this
// after the `AGENT_SESSIONS_VAULT` env var, so vault location isn't lost even when called from
// outside Obsidian (TUI, CLI). Writes the same way `ui-state.ts`'s `writeUiState` does (tmp,
// then rename).

import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultState {
	vault: string;
}

/** Writes `vault.json` into `runtimeDir` (`~/.agents/sessions`). Called from `onload`. */
export function writeVaultState(runtimeDir: string, vaultPath: string): void {
	fs.mkdirSync(runtimeDir, { recursive: true });
	const state: VaultState = { vault: vaultPath };
	const data = JSON.stringify(state, null, 1);
	const filePath = path.join(runtimeDir, "vault.json");
	const tmp = path.join(runtimeDir, `.vault.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, data, "utf8");
	try {
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// no-op
		}
		throw err;
	}
}
