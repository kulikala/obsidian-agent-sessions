// Stands in for the `claude` CLI inside the screenshot sandbox: reads the prompt from stdin and
// answers as a Claude Code `stream-json` result -- with the canned suggestions for "Organize names
// and categories", or with the canned findings for a token efficiency analysis (its prompt carries
// the data between `<<<DATA` markers).
// Usage (via the wrapper `shoot.mjs` writes): node fake-claude.mjs <suggestions.json> <efficiency.json>

import { readFileSync } from "node:fs";

const [suggestionsPath, efficiencyPath] = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
	const efficiency = prompt.includes("<<<DATA") && efficiencyPath;
	const reply = readFileSync(efficiency ? efficiencyPath : suggestionsPath, "utf8");
	setTimeout(() => {
		const result = { type: "result", is_error: false, result: reply };
		if (efficiency) {
			result.total_cost_usd = 0.0812;
			result.usage = { input_tokens: 9, cache_creation_input_tokens: 14_200, cache_read_input_tokens: 0, output_tokens: 1_350 };
		}
		process.stdout.write(JSON.stringify(result) + "\n");
	}, 1500);
});
