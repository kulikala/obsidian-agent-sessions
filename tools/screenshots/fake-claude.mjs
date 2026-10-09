// Stands in for the `claude` CLI inside the screenshot sandbox: reads the prompt from stdin and
// answers as a Claude Code `stream-json` result -- with the canned suggestions for "Organize names
// and categories", or, for one check of a token efficiency analysis (its prompt carries the data
// between `<<<DATA` markers, with the check's id in `statistics.check`), with that check's canned
// reply.
// Usage (via the wrapper `shoot.mjs` writes): node fake-claude.mjs <suggestions.json> <efficiency.json>

import { readFileSync } from "node:fs";

const [suggestionsPath, efficiencyPath] = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
	const efficiency = prompt.includes("<<<DATA") && efficiencyPath;
	const reply = efficiency ? checkReply(JSON.parse(readFileSync(efficiencyPath, "utf8"))) : readFileSync(suggestionsPath, "utf8");
	setTimeout(() => {
		const result = { type: "result", is_error: false, result: reply };
		if (efficiency) {
			result.total_cost_usd = 0.0162;
			result.usage = { input_tokens: 9, cache_creation_input_tokens: 4_200, cache_read_input_tokens: 0, output_tokens: 310 };
		}
		process.stdout.write(JSON.stringify(result) + "\n");
	}, 1500);
});

/** The canned reply for the check the prompt's data names; "ok" for any other. */
function checkReply(replies) {
	const data = prompt.slice(prompt.indexOf("<<<DATA") + "<<<DATA".length, prompt.indexOf("DATA>>>"));
	let check = "";
	try {
		check = JSON.parse(data).statistics.check;
	} catch {
		check = "";
	}
	return JSON.stringify(replies[check] ?? { verdict: "ok", reason: "-" });
}
