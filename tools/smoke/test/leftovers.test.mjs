import assert from "node:assert/strict";
import { test } from "node:test";

import { decideLeftovers } from "../lib/leftovers.mjs";

test("only smoke- sessions are leftovers; running ones are killed first", () => {
	const plan = decideLeftovers(
		[
			{ id: "smoke-a", exited: null },
			{ id: "smoke-b", exited: 0 },
			{ id: "real-1", exited: null },
			{ id: "xsmoke-c", exited: null },
		],
		"smoke-"
	);
	assert.deepEqual(plan, { kill: ["smoke-a"], forget: ["smoke-a", "smoke-b"] });
});

test("garbage in, nothing out", () => {
	assert.deepEqual(decideLeftovers(undefined, "smoke-"), { kill: [], forget: [] });
	assert.deepEqual(decideLeftovers([null, { id: 3 }], "smoke-"), { kill: [], forget: [] });
});

test("the function survives being shipped as source into Obsidian", () => {
	const shipped = new Function(`return (${decideLeftovers.toString()})`)();
	assert.deepEqual(shipped([{ id: "smoke-z" }], "smoke-"), { kill: ["smoke-z"], forget: ["smoke-z"] });
});
