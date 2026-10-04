// Result files: markdown, home paths, file names.

const HOME_PATTERNS = [
	// macOS, Linux, Windows (either slash): the user's folder under Users / home.
	/(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s"'`:;,)\]}]+/g,
	/\/root(?=[\\/\s"'`:;,)\]}]|$)/g,
];

/** Replaces home folders (`/Users/x`, `C:\Users\x`, `/home/x`, `/root`, plus `extraHomes`) with `~`. */
export function replaceHome(text, extraHomes = []) {
	let out = String(text);
	for (const home of [...extraHomes].filter(Boolean).sort((a, b) => b.length - a.length)) {
		out = out.split(home).join("~");
		out = out.split(home.replace(/\\/g, "/")).join("~");
	}
	for (const pattern of HOME_PATTERNS) {
		out = out.replace(pattern, "~");
	}
	return out;
}

/** Applies `replaceHome` to every string inside a JSON-like value. */
export function scrubHome(value, extraHomes = []) {
	if (typeof value === "string") {
		return replaceHome(value, extraHomes);
	}
	if (Array.isArray(value)) {
		return value.map((v) => scrubHome(v, extraHomes));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubHome(v, extraHomes)]));
	}
	return value;
}

const MARK = { pass: "pass", fail: "FAIL", skipped: "skipped" };

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function stepTable(steps) {
	if (steps.length === 0) {
		return "_(none)_\n";
	}
	const rows = steps.map((s) => `| ${cell(s.name)} | ${MARK[s.status] ?? s.status} | ${s.ms} ms | ${cell(s.message)} |`);
	return ["| Step | Result | Time | Message |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

/** One target's result as markdown. */
export function toMarkdown(result) {
	const lines = [`# Smoke test: ${result.target}`, ""];
	lines.push(`- Result: **${result.ok ? "pass" : "FAIL"}** (${result.summary.pass} pass, ${result.summary.fail} fail, ${result.summary.skipped} skipped)`);
	lines.push(`- Started: ${result.startedAt}`);
	if (result.error) {
		lines.push(`- Error: ${result.error}`);
	}
	lines.push("");
	if (result.env) {
		lines.push("## Environment", "");
		for (const [key, value] of Object.entries(result.env)) {
			lines.push(`- ${key}: ${value}`);
		}
		lines.push("");
	}
	lines.push("## Run", "", stepTable(result.run), "## Verify after restart", "", stepTable(result.verify));
	return lines.join("\n");
}

/** `20261004-153045` in local time. */
export function timestamp(date = new Date()) {
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** The file stem of a result: `<target>-<timestamp>`, the target made safe for a file name. */
export function resultStem(target, date = new Date()) {
	return `${target.replace(/[^A-Za-z0-9._-]/g, "_")}-${timestamp(date)}`;
}
