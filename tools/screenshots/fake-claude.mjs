// Stands in for the `claude` CLI inside the screenshot sandbox, for "Organize names and
// categories": reads the prompt from stdin, then answers with the canned suggestions as a
// Claude Code `stream-json` result.
// Usage (via the wrapper `shoot.mjs` writes): node fake-claude.mjs <suggestions.json>

import { readFileSync } from "node:fs";

const [suggestionsPath] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
	const reply = readFileSync(suggestionsPath, "utf8");
	setTimeout(() => {
		process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: reply }) + "\n");
	}, 1500);
});
