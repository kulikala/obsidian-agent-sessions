// Registers Claude and Codex's own marks as Obsidian icons (`Obsidian.addIcon`). Split out from
// `icons.ts` (which just holds the SVG data and the id lookup table) so this file can import
// `obsidian` at the top level — `icons.ts` itself is imported directly by `views/rows.ts` and
// `views/detail.ts`, both of which tests import directly, and the `obsidian` npm package has no
// runtime (its `main` is empty), so a top-level `obsidian` import here would break those tests.

import { addIcon } from "obsidian";
import { CLAUDE_SVG, CODEX_SVG, AGENT_ICON_ID } from "./icons";

let registered = false;

/** Idempotent — safe to call from `onload()` every time the plugin loads. */
export function registerAgentIcons(): void {
	if (registered) {
		return;
	}
	addIcon(AGENT_ICON_ID.claude, CLAUDE_SVG);
	addIcon(AGENT_ICON_ID.codex, CODEX_SVG);
	registered = true;
}
