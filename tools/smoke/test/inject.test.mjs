import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

// Loads inject.js the way Obsidian's renderer evaluates it, with a stand-in plugin whose
// `editorEnv` has the real one's shape: `(agent, launchEnv) => Promise<Record<string, string>>`.
function loadSmoke() {
	const context = vm.createContext({ require: createRequire(import.meta.url), process, setTimeout, clearTimeout, console, Buffer });
	vm.runInContext(readFileSync(new URL("../inject.js", import.meta.url), "utf8"), context);
	return context.__agentSessionsSmoke;
}

const plugin = (editorEnv) => ({ editorEnv, vaultPath: () => "/vault" });

test("the fake agent starts with the plugin's VISUAL, awaited", async () => {
	const smoke = loadSmoke();
	const env = await smoke.startEnv(plugin(async (agent, launchEnv) => ({ VISUAL: `/shim-for-${agent}`, SEEN: String("PATH" in launchEnv || "Path" in launchEnv) })));
	assert.equal(env.VISUAL, "/shim-for-claude");
	assert.equal(env.SEEN, "true");
	assert.equal(env.AGENT_SESSIONS_VAULT, "/vault");
});

test("a start without VISUAL fails at once", async () => {
	const smoke = loadSmoke();
	await assert.rejects(smoke.startEnv(plugin(async () => ({}))), /VISUAL/);
});
