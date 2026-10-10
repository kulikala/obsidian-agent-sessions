// Every commit of the range: its message (English; Claude's trailers last, when it has them), its
// author and committer addresses, and the lines and files it adds.

import { commitChanges, listCommits } from "../git.mjs";
import { scanLine } from "../privacy.mjs";
import { JAPANESE, lines, matchesAny } from "../text.mjs";

const CO_AUTHOR = /^Co-Authored-By: Claude [^<>]+ <noreply@anthropic\.com>$/;
const SESSION = /^Claude-Session: https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;
/** Characters a message must not hold: Japanese and the full-width forms an IME types. */
const NOT_ENGLISH = new RegExp(`${JAPANESE.source}|[\\uff01-\\uff65]`);

/** The problems of a commit message, as `{ line, message, fix }`. */
export function messageProblems(message) {
	const problems = [];
	const msgLines = lines(message);
	msgLines.forEach((l, i) => {
		if (NOT_ENGLISH.test(l)) {
			problems.push({ line: i + 1, message: `Japanese in the message: "${l.trim().slice(0, 80)}"`, fix: "write the message in English; name a Japanese UI string by its English label" });
		}
	});
	const claude = msgLines.some((l) => /^Co-Authored-By: Claude\b/.test(l) || /^Claude-Session:/.test(l));
	if (claude) {
		const content = msgLines.filter((l) => l.trim() !== "");
		const last = content.at(-1) ?? "";
		const before = content.at(-2) ?? "";
		if (!CO_AUTHOR.test(before) || !SESSION.test(last)) {
			problems.push({
				line: msgLines.length,
				message: "the message does not end with the Co-Authored-By and Claude-Session lines",
				fix: "end it with exactly: Co-Authored-By: Claude <model> <noreply@anthropic.com>, then Claude-Session: https://claude.ai/code/session_<id>",
			});
		}
	}
	return problems;
}

export function checkCommits({ repo, range, config, privacy, report, accepted = [] }) {
	const commits = listCommits(repo, range);
	const isAccepted = (commit, check) => accepted.some((a) => commit.hash.startsWith(a.commit) && (!a.checks || a.checks.includes(check)));
	const add = (commit, check, where, message, fix) => {
		if (isAccepted(commit, check)) report.warn(check, where, `${message} (accepted in tools/audit/accepted.json)`);
		else report.fail(check, where, message, fix);
	};
	for (const c of commits) {
		const at = `commit ${c.short}`;
		for (const p of messageProblems(c.message)) add(c, "commits", `${at} message:${p.line}`, p.message, p.fix);
		lines(c.message).forEach((l, i) => {
			for (const f of scanLine(l, privacy)) add(c, f.check, `${at} message:${i + 1}`, f.message, f.fix);
		});
		for (const [role, email] of [
			["author", c.authorEmail],
			["committer", c.committerEmail],
		]) {
			if (!privacy.allowedEmails.some((re) => re.test(email))) {
				add(c, "privacy", at, `${role} email ${/@gmail\.com$/i.test(email) ? "is a Gmail address" : "is not a no-reply address"} (${email})`, "commit with -c user.email=<id>+<user>@users.noreply.github.com and amend before pushing");
			}
		}
		if (c.parents.length > 1) continue;
		const { added, files } = commitChanges(repo, c.hash);
		const secretsExempt = config.secrets.exempt;
		for (const a of added) {
			const secrets = !matchesAny(a.path, secretsExempt);
			for (const f of scanLine(a.text, privacy, { secrets })) add(c, f.check, `${at} ${a.path}:${a.line}`, `${f.message}, added by this commit`, f.fix);
		}
		for (const f of files) {
			if (f.size > config.hygiene.largeFileBytes && !matchesAny(f.path, config.hygiene.largeFileExempt)) {
				add(c, "hygiene", `${at} ${f.path}`, `adds ${(f.size / 1048576).toFixed(1)} MB, over the 1 MB limit outside docs/images`, "drop the file from the commit");
			}
		}
	}
	return { commits: commits.length };
}
