#!/usr/bin/env node
// The audit before a push or a release: privacy and secrets in the tree and in every commit about
// to be pushed, the commit message rules, the language rule, the locales, the versions, the
// documents' links, leftover debugging, and the build and tests.
//
//   node tools/audit/run.mjs [--range A..B] [--rev REV] [--skip-tests] [--only a,b]
//
// Exits 1 when anything fails; warnings alone pass. See docs/development.md, "Before pushing or
// releasing". Node 20 or newer, nothing to install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBuild } from "./lib/checks/build.mjs";
import { checkCommits } from "./lib/checks/commits.mjs";
import { checkDocs } from "./lib/checks/docs.mjs";
import { checkI18n } from "./lib/checks/i18n.mjs";
import { checkTree, loadDenylist } from "./lib/checks/tree.mjs";
import { checkVersions } from "./lib/checks/versions.mjs";
import { git, gitText, openTree } from "./lib/git.mjs";
import { localNames, originOwner, privacyContext } from "./lib/privacy.mjs";
import { Report } from "./lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = ["tree", "commits", "i18n", "versions", "docs", "build"];

const USAGE = `usage: node tools/audit/run.mjs [--range A..B] [--rev REV] [--skip-tests] [--only CHECKS] [--repo DIR]

  --range A..B    the commits to check (default origin/main..HEAD, or ..REV); "none" skips them
  --rev REV       check the tree of this commit instead of the working tree (implies --skip-tests)
  --skip-tests    leave out the build, tsc, vitest and unittest
  --only CHECKS   comma-separated, from: ${CHECKS.join(", ")}
  --repo DIR      the repository (default: the one this script is in)

  AUDIT_PRIVATE_NAMES  more names to look for, comma-separated (the login name, the account's full
                       name and git's user.name are always looked for)`;

function parseArgs(argv) {
	const args = { range: null, rev: null, skipTests: false, only: null, repo: path.resolve(HERE, "../..") };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			return argv[++i];
		};
		if (a === "--range") args.range = value();
		else if (a === "--rev") args.rev = value();
		else if (a === "--skip-tests") args.skipTests = true;
		else if (a === "--only") args.only = value().split(",").map((s) => s.trim());
		else if (a === "--repo") args.repo = path.resolve(value());
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else throw new Error(`unknown argument ${a}`);
	}
	for (const c of args.only ?? []) if (!CHECKS.includes(c)) throw new Error(`unknown check ${c}`);
	return args;
}

function readJson(file, fallback) {
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`${err.message}\n\n${USAGE}`);
		process.exit(2);
	}
	const log = (m) => process.stderr.write(`${m}\n`);
	const repo = gitText(args.repo, ["rev-parse", "--show-toplevel"]).trim();
	const config = readJson(path.join(HERE, "config.json"));
	const denylist = loadDenylist(readJson(path.join(HERE, "denylist.json"), []));
	const accepted = readJson(path.join(HERE, "accepted.json"), []);
	const want = (c) => !args.only || args.only.includes(c);
	const report = new Report();
	const tree = openTree(repo, args.rev);
	const privacy = privacyContext({ repo, names: localNames(repo), origin: originOwner(repo), config });
	log(`audit: ${tree.label}${privacy.names.length ? `, looking for ${privacy.names.length} local names` : ", no local names to look for"}`);

	if (want("tree")) {
		const { files, scanned } = checkTree({ tree, config, denylist, privacy, report });
		report.ran("tree", `${scanned} of ${files} files read`);
	}
	if (want("commits")) {
		let range = args.range;
		if (!range) {
			const hasOrigin = git(repo, ["rev-parse", "--verify", "--quiet", "origin/main"], { allowFail: true }).ok;
			range = hasOrigin ? `origin/main..${args.rev ?? "HEAD"}` : "none";
		}
		if (range === "none") report.skipped("commits", "no range");
		else {
			const { commits } = checkCommits({ repo, range, config, privacy, report, accepted });
			report.ran("commits", `${range}, ${commits} commits`);
		}
	}
	if (want("i18n")) {
		checkI18n({ tree, config, report });
		report.ran("i18n");
	}
	if (want("versions")) {
		checkVersions({ tree, report });
		report.ran("versions");
	}
	if (want("docs")) {
		const { docs, links } = checkDocs({ tree, config, report });
		report.ran("docs", `${docs} documents, ${links} relative links`);
	}
	if (want("build")) {
		if (args.skipTests || args.rev) report.skipped("build", args.rev ? "--rev" : "--skip-tests");
		else {
			checkBuild({ repo, report, log });
			report.ran("build");
		}
	}
	console.log(report.format());
	process.exit(report.failures.length > 0 ? 1 : 0);
}

main();
