import esbuild from "esbuild";
import process from "node:process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import builtins from "builtin-modules";

const mode = process.argv[2];
const production = mode === "production";
// `dev` builds once, with the development flag on, and exits; no argument builds the same way and keeps
// watching; `production` builds once, minified, with the flag off.
const once = production || mode === "dev";
const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The `agent-sessions` program as plain text, keyed by its path in an install directory: every
 * `.py` under `agentsessions/` and the agent skills' `SKILL.md` templates, plus the two launchers in
 * `bin/`. The plugin writes these out when
 * the user installs the program from inside Obsidian (`src/backend/bundle.ts`).
 */
function backendFiles() {
	const files = {};
	const add = (full) => {
		files[relative(REPO, full).split(sep).join("/")] = readFileSync(full, "utf8");
	};
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name !== "__pycache__") {
					walk(full);
				}
			} else if (name.endsWith(".py") || name === "SKILL.md") {
				add(full);
			}
		}
	};
	walk(join(REPO, "agentsessions"));
	add(join(REPO, "bin", "agent-sessions"));
	add(join(REPO, "bin", "agent-sessions-code"));
	return files;
}

/** Serves `virtual:agent-sessions-backend`: the files above and a version that changes whenever
 * any of them does (the plugin's version plus a content hash), so an install is refreshed after
 * every plugin update that touches the program. */
const bundledBackend = {
	name: "bundled-backend",
	setup(build) {
		build.onResolve({ filter: /^virtual:agent-sessions-backend$/ }, (args) => ({
			path: args.path,
			namespace: "bundled-backend",
		}));
		build.onLoad({ filter: /.*/, namespace: "bundled-backend" }, () => {
			const files = backendFiles();
			const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
			const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
			return {
				contents:
					`export const BACKEND_VERSION = ${JSON.stringify(`${version}+${hash}`)};\n` +
					`export const BACKEND_FILES = ${JSON.stringify(files)};\n`,
				loader: "js",
				watchFiles: Object.keys(files).map((f) => join(REPO, f)),
			};
		});
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	plugins: [bundledBackend],
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
		...builtins.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	// AGENT_SESSIONS_OUTFILE: build somewhere else than plugin/main.js (which a development vault may
	// link to), e.g. for a test machine.
	outfile: process.env.AGENT_SESSIONS_OUTFILE || "main.js",
	// True only in a development build: code behind it (the welcome guide's picture-folder override)
	// is removed from the shipped bundle.
	define: { __AGENT_SESSIONS_DEV__: String(!production) },
	minify: production,
});

if (once) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
