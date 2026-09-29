// Telling "the session to resume doesn't exist" from every other early exit, by what the agent
// printed.

/** What each agent prints when the id to resume doesn't exist. Claude Code: "No conversation
 * found…". Codex: a plain "not found". OpenCode: "Error: Session not found: <id>". */
const RESUME_FAILURE_PATTERNS: Record<string, readonly string[]> = {
	claude: ["No conversation found", "not found"],
	codex: ["not found"],
	// Only OpenCode's own message: through `ollama launch`, ollama's errors also say "not found"
	// (`model "x" not found`) and offering "Start fresh" for those would launch another doomed session.
	opencode: ["Session not found"],
};

export function isResumeFailure(agent: string, earlyOutput: string): boolean {
	const patterns = RESUME_FAILURE_PATTERNS[agent] ?? RESUME_FAILURE_PATTERNS.claude;
	return patterns.some((p) => earlyOutput.includes(p));
}
