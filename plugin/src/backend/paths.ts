// Where the plugin keeps its runtime files: the same rule as the Python side's
// `config.RUNTIME_DIR` -- `AGENT_SESSIONS_RUNTIME_DIR` when set (how a scratch Obsidian and its
// daemon are kept apart from the real ones), `~/.agents/sessions` otherwise. Every runtime path
// is built from `runtimeDir`, never from the home folder directly.

import { homedir } from "os";
import { join } from "path";

/** The runtime folder for `env`. An empty `AGENT_SESSIONS_RUNTIME_DIR` counts as unset. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return env.AGENT_SESSIONS_RUNTIME_DIR || join(home, ".agents", "sessions");
}

/** The folder Organize's headless runs use (it has no CLAUDE.md above it). */
export function organizeDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(runtimeDir(env), "organize");
}

/** Where each token efficiency analysis gets its own empty folder (`inRunFolder`). */
export function efficiencyRunDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(runtimeDir(env), "efficiency-run");
}

/** Where token efficiency keeps its statistics cache (Python) and the last results. */
export function efficiencyDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(runtimeDir(env), "efficiency");
}
