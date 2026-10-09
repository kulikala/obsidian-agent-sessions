// Stands in for the `claude` CLI inside the screenshot sandbox: reads the prompt from stdin and
// answers as a Claude Code `stream-json` result -- with the canned suggestions for "Organize names
// and categories", or, for a token efficiency request (its prompt carries the digest between
// `<<<DATA` markers), with a verdict on every check: the canned issues whose tasks this request
// sent, "ok" for the rest. A request that is one part of several takes longer, so the screenshots
// can catch the analysis between parts.
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
	}, prompt.includes("This is part ") ? 4000 : 2500);
});

const CHECKS = ["rework", "firstRequest", "mixedTasks", "longContext", "largeOutput", "cacheRebuild", "repeatedLookups", "startupSize"];

/** The reply to one request: each canned issue narrowed to the tasks the request sent. */
function checkReply(replies) {
	const data = prompt.slice(prompt.indexOf("<<<DATA") + "<<<DATA".length, prompt.indexOf("DATA>>>"));
	let sent = new Set();
	try {
		sent = new Set(JSON.parse(data).tasks.map((t) => t.id));
	} catch {
		sent = new Set();
	}
	const narrow = (issue) => {
		const evidence = (issue?.evidence ?? []).filter((id) => sent.has(id));
		return evidence.length > 0 ? { ...issue, evidence } : null;
	};
	const checks = Object.fromEntries(CHECKS.map((c) => [c, narrow(replies[c]) ?? { verdict: "ok" }]));
	checks.found = (replies.found ?? []).map(narrow).filter((x) => x);
	return JSON.stringify({ checks });
}
