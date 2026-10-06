// The empty folder a token efficiency analysis runs in: a fresh one for every run, under
// `<runtime>/efficiency-run/`, removed when the run ends however it ends (success, failure,
// timeout or cancel). Nothing is written into it -- the prompt goes in on stdin -- so the agent
// that reads the excerpts finds no other conversation text next to it.

import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";

/** Runs `fn` in a new empty folder under `base` and removes the folder afterwards. */
export async function inRunFolder<T>(base: string, fn: (dir: string) => Promise<T>): Promise<T> {
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "run-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
