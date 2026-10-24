// The Python a checkout's tooling runs: its own virtual environment when it has one, so the
// Python that `python3` resolves to (Homebrew's, a distribution's) can move on without changing
// what the project tests; otherwise `python3` from PATH, as CI and the VMs have it.

import fs from "node:fs";
import path from "node:path";

/** The interpreter to run a Python script with: the checkout's `.venv`, else `python3`. */
export function pythonCommand(repo) {
	const venv = process.platform === "win32" ? path.join(repo, ".venv", "Scripts", "python.exe") : path.join(repo, ".venv", "bin", "python3");
	return fs.existsSync(venv) ? venv : "python3";
}
