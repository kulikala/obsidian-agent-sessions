// The empty folder a token efficiency analysis runs in: `<runtime>/efficiency-run/current`,
// created empty right before each run and removed when the run ends however it ends (success,
// failure, timeout or cancel). Nothing is written into it -- the prompt goes in on stdin -- so the
// agent that reads the excerpts finds no other conversation text next to it. The name is fixed
// because Claude Code keeps an (empty) project folder per working folder: one fixed folder means
// one such folder, not one per run.

import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

export const RUN_FOLDER_NAME = "current";

/** Thrown when a run starts while another one is still using the folder. */
export class RunFolderBusyError extends Error {
	constructor() {
		super("another analysis is still running");
	}
}

const busy = new Set<string>();

/**
 * Runs `fn` in `<base>/current`, made empty first and removed afterwards. Refuses (with a
 * `RunFolderBusyError`) while a run of this process is still using it; a folder left behind by a
 * run that never finished (the app quit mid-run) is cleared and reused.
 */
export async function inRunFolder<T>(base: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = join(base, RUN_FOLDER_NAME);
	if (busy.has(dir)) {
		throw new RunFolderBusyError();
	}
	busy.add(dir);
	try {
		mkdirSync(base, { recursive: true });
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
		mkdirSync(dir);
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		busy.delete(dir);
	}
}
