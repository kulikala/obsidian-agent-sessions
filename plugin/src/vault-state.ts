// vault の場所を `~/.agents/sessions/vault.json` へ書く（T-80）。`agent-sessions` は
// 既定の vault を持たないので、python 側（`agentsessions/config.py` の `_resolve_vault`）が
// env `AGENT_SESSIONS_VAULT` の次にここを読み、Obsidian の外（TUI・CLI）から呼んでも
// vault を見失わないようにする。書き方は `ui-state.ts` の `writeUiState` と同じ
// （tmp に書いて rename）。

import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultState {
	vault: string;
}

/** `runtimeDir`（`~/.agents/sessions`）へ `vault.json` を書く。`onload` から呼ぶ。 */
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
