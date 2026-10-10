// What must not leave the machine: home folders with a real user's name, email addresses other
// than the no-reply ones, the local user's names, and secrets. The names are read from this
// machine when the audit runs; none of them is written in the repository.

import { spawnSync } from "node:child_process";
import os from "node:os";

import { gitText } from "./git.mjs";

/** Accounts a CI runner or container uses: never a person, and too common a word to search for. */
const SYSTEM_ACCOUNTS = new Set(["runner", "runneradmin", "root", "ubuntu", "admin", "user", "vscode", "codespace", "node", "github"]);

function run(cmd, args) {
	const r = spawnSync(cmd, args, { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : "";
}

/** The names of the person running the audit: the login name, the account's full name, git's
 * user.name, and anything in AUDIT_PRIVATE_NAMES (comma-separated). */
export function localNames(repo, env = process.env) {
	const names = new Set();
	let login = "";
	try {
		login = os.userInfo().username;
	} catch {
		login = env.USER || env.USERNAME || "";
	}
	names.add(login);
	if (process.platform === "darwin") names.add(run("id", ["-F"]));
	else if (process.platform !== "win32") names.add(run("getent", ["passwd", login]).split(":")[4]?.split(",")[0] ?? "");
	names.add(run("git", ["-C", repo, "config", "user.name"]));
	for (const n of (env.AUDIT_PRIVATE_NAMES || "").split(",")) names.add(n);
	return [...names].map((n) => (n || "").trim()).filter((n) => n.length >= 3 && !SYSTEM_ACCOUNTS.has(n.toLowerCase()));
}

/** The GitHub owner of `origin`, whose handle is public in the repository's own URLs. */
export function originOwner(repo) {
	const url = gitText(repo, ["remote", "get-url", "origin"], { allowFail: true }).trim();
	const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
	return m ? { owner: m[1], repo: m[2] } : null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function privacyContext({ repo, names, origin, config }) {
	const publicForms = [];
	if (origin) {
		const o = escape(origin.owner);
		publicForms.push(
			new RegExp(`github\\.com/${o}\\b`, "gi"),
			new RegExp(`githubusercontent\\.com/${o}\\b`, "gi"),
			new RegExp(`\\b${o}/${escape(origin.repo)}\\b`, "gi"),
			new RegExp(`\\d+\\+${o}@users\\.noreply\\.github\\.com`, "gi"),
		);
	}
	return {
		names: names.map((n) => ({ name: n, re: new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(n)}(?![\\p{L}\\p{N}_])`, "iu") })),
		publicForms,
		placeholders: new Set(config.privacy.homePlaceholders.map((n) => n.toLowerCase())),
		allowedEmails: config.privacy.allowedEmails.map((p) => new RegExp(`^${p}$`, "i")),
		secrets: config.secrets.patterns.map((p) => ({ name: p.name, re: new RegExp(p.pattern) })),
		repo,
	};
}

const HOME = /(?<![\w./-])(?:\/Users\/|\/home\/|\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))([^/\\\s"'`<>()[\]{}:,;*|]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/**
 * The privacy findings of one line of text. `secrets` is false where the file is allowed to hold
 * made-up keys (a masker's tests). Each finding is `{ check, message, fix }`.
 */
export function scanLine(text, ctx, { secrets = true } = {}) {
	const found = [];
	for (const m of text.matchAll(HOME)) {
		// A name with an escape or a short-name suffix in it (a&b, JANEDO~1, A%20B) is tested by its
		// leading word; markers like $USER, <name>, {user} and ... are not names.
		const name = (/^[\p{L}\p{N}._-]+/u.exec(m[1]) ?? [""])[0];
		if (name === "" || /^[.\d]/.test(name)) continue;
		const real = ctx.names.find((n) => n.name.toLowerCase() === name.toLowerCase());
		if (real) {
			found.push({ check: "privacy", message: `home folder of the local user (${m[0]})`, fix: "use a placeholder home such as /Users/alex or ~" });
		} else if (!ctx.placeholders.has(name.toLowerCase())) {
			found.push({
				check: "privacy",
				message: `home folder with a name that is not a known placeholder (${m[0]})`,
				fix: "use /Users/alex, /home/sam or ~; if the name is made up, add it to privacy.homePlaceholders in tools/audit/config.json",
			});
		}
	}
	for (const m of text.matchAll(EMAIL)) {
		const email = m[0];
		if (/@gmail\.com$/i.test(email)) {
			found.push({ check: "privacy", message: `a Gmail address (${email})`, fix: "remove it; commits use the GitHub no-reply address" });
		} else if (!ctx.allowedEmails.some((re) => re.test(email))) {
			found.push({ check: "privacy", message: `an email address (${email})`, fix: "use an address at example.com/example.org, or a no-reply address" });
		}
	}
	let scrubbed = text;
	for (const re of ctx.publicForms) scrubbed = scrubbed.replace(re, " ");
	for (const { re } of ctx.names) {
		if (re.test(scrubbed)) {
			found.push({ check: "privacy", message: "the local user's name (from this machine's account or git config)", fix: "remove it, or use a placeholder (alex, sam)" });
		}
	}
	if (secrets) {
		for (const { name, re } of ctx.secrets) {
			if (re.test(text)) found.push({ check: "secrets", message: `looks like ${name}`, fix: "remove the secret and revoke it; tests build fake keys at run time" });
		}
	}
	return found;
}
