// Git access for the audit: the files of a tree (the working tree or a commit) and the commits of a
// range with their messages, identities and added lines.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(repo, args, { allowFail = false, input } = {}) {
	const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
		cwd: repo,
		encoding: "buffer",
		maxBuffer: 1024 * 1024 * 1024,
		input,
	});
	if (result.status !== 0 && !allowFail) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return { ok: result.status === 0, out: result.stdout, err: result.stderr.toString() };
}

export function gitText(repo, args, options) {
	return git(repo, args, options).out.toString("utf8");
}

export function isBinary(buffer) {
	return buffer.subarray(0, 8000).includes(0);
}

/**
 * The files of a tree: `list()` gives `{ path, size }` for every file, `read(path)` its bytes (or
 * null when it isn't there). With `rev`, the tree of that commit; without, the working tree's
 * tracked files plus the untracked ones that aren't ignored.
 */
export function openTree(repo, rev) {
	if (rev) {
		const entries = gitText(repo, ["ls-tree", "-r", "-z", "--long", rev])
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const [meta, file] = line.split("\t");
				const [, type, blob, size] = meta.trim().split(/\s+/);
				return { path: file, size: Number(size), blob, type };
			})
			.filter((e) => e.type === "blob");
		const byPath = new Map(entries.map((e) => [e.path, e]));
		return {
			label: rev,
			list: () => entries.map(({ path: p, size }) => ({ path: p, size })),
			has: (p) => byPath.has(p),
			read: (p) => (byPath.has(p) ? git(repo, ["cat-file", "blob", byPath.get(p).blob]).out : null),
		};
	}
	const files = gitText(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
		.split("\0")
		.filter(Boolean);
	const present = [...new Set(files)].filter((p) => fs.existsSync(path.join(repo, p)) && fs.statSync(path.join(repo, p)).isFile());
	const set = new Set(present);
	return {
		label: "working tree",
		list: () => present.map((p) => ({ path: p, size: fs.statSync(path.join(repo, p)).size })),
		has: (p) => set.has(p),
		read: (p) => (set.has(p) ? fs.readFileSync(path.join(repo, p)) : null),
	};
}

const SEP = "\x1e";

/** The commits of `range`, oldest first: hash, identities, message and parents. */
export function listCommits(repo, range) {
	const format = ["%H", "%h", "%P", "%an", "%ae", "%cn", "%ce", "%B"].join("%x1f") + "%x1e";
	return gitText(repo, ["log", "--reverse", `--format=${format}`, range])
		.split(SEP)
		.map((chunk) => chunk.replace(/^\n/, ""))
		.filter((chunk) => chunk.trim())
		.map((chunk) => {
			const [hash, short, parents, authorName, authorEmail, committerName, committerEmail, message] = chunk.split("\x1f");
			return {
				hash,
				short,
				parents: parents.split(" ").filter(Boolean),
				authorName,
				authorEmail,
				committerName,
				committerEmail,
				message: message.replace(/\n+$/, ""),
			};
		});
}

/**
 * The lines a commit adds, per file, with their line numbers in the new file; and the files it
 * adds or changes with their blob sizes. Merge commits add nothing of their own here: their
 * changes are the commits they bring in.
 */
export function commitChanges(repo, hash) {
	const patch = gitText(repo, ["show", "--no-color", "--no-ext-diff", "--unified=0", "--format=", "--no-renames", hash]);
	/** @type {{ path: string, line: number, text: string }[]} */
	const added = [];
	let file = null;
	let line = 0;
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			file = null;
		} else if (raw.startsWith("+++ ")) {
			file = raw === "+++ /dev/null" ? null : raw.slice(4).replace(/^b\//, "");
		} else if (raw.startsWith("@@")) {
			const m = /\+(\d+)/.exec(raw);
			line = m ? Number(m[1]) : 0;
		} else if (file && raw.startsWith("+")) {
			added.push({ path: file, line, text: raw.slice(1) });
			line++;
		}
	}
	const files = gitText(repo, ["show", "--no-color", "--format=", "--raw", "--no-renames", "--no-abbrev", hash])
		.split("\n")
		.filter((l) => l.startsWith(":"))
		.map((l) => {
			const [meta, file2] = l.split("\t");
			const parts = meta.split(" ");
			return { path: file2, blob: parts[3], status: parts[4] };
		})
		.filter((f) => f.status === "A" || f.status === "M")
		.map((f) => ({ ...f, size: Number(gitText(repo, ["cat-file", "-s", f.blob]).trim()) }));
	return { added, files };
}
