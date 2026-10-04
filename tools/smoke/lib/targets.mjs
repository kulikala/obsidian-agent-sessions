// The targets file (default tools/smoke/targets.json) and the command templates in it.

const REQUIRED = ["push", "pluginDir", "workDir", "exec", "restartObsidian", "cdpPort"];
const STRING_KEYS = ["push", "pluginDir", "workDir", "exec", "restartObsidian", "tunnel", "before"];

/** Parses the targets file's text. Throws an Error naming what is wrong. */
export function parseTargets(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new Error(`the targets file is not valid JSON: ${err.message}`);
	}
	const targets = data && data.targets;
	if (!targets || typeof targets !== "object" || Array.isArray(targets) || Object.keys(targets).length === 0) {
		throw new Error('the targets file needs a non-empty "targets" object');
	}
	const out = {};
	for (const [name, t] of Object.entries(targets)) {
		if (!t || typeof t !== "object") {
			throw new Error(`target "${name}" must be an object`);
		}
		for (const key of REQUIRED) {
			if (t[key] === undefined || t[key] === "") {
				throw new Error(`target "${name}" lacks "${key}"`);
			}
		}
		for (const key of STRING_KEYS) {
			if (t[key] !== undefined && typeof t[key] !== "string") {
				throw new Error(`target "${name}": "${key}" must be a string`);
			}
		}
		if (!Number.isInteger(t.cdpPort) || t.cdpPort < 1 || t.cdpPort > 65535) {
			throw new Error(`target "${name}": "cdpPort" must be a port number`);
		}
		for (const key of ["push", "exec"]) {
			const want = key === "push" ? ["{files}", "{dest}"] : ["{command}"];
			for (const token of want) {
				if (!t[key].includes(token)) {
					throw new Error(`target "${name}": "${key}" must contain ${token}`);
				}
			}
		}
		out[name] = { tunnel: "", ...t, name };
	}
	return out;
}

/** Picks the targets to run: all in file order, or the one named. */
export function selectTargets(targets, name) {
	if (!name) {
		return Object.values(targets);
	}
	if (!targets[name]) {
		throw new Error(`no target "${name}" (have: ${Object.keys(targets).join(", ")})`);
	}
	return [targets[name]];
}

/** Quotes one word for `sh`. */
export function shQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quotes one word for PowerShell (single quotes, doubled inside). */
export function psQuote(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** Whether a target path is a Windows one (`C:/...` or `C:\...`). */
export function isWindowsPath(p) {
	return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Fills `{files}` (space-separated, each quoted), `{dest}` and `{command}` (quoted) in a template.
 * Placeholders are replaced in one pass, so a value that contains `{dest}` is left alone.
 */
export function expandTemplate(template, values) {
	return template.replace(/\{(files|dest|command)\}/g, (_, key) => {
		const value = values[key];
		if (value === undefined) {
			throw new Error(`the template needs {${key}} but no value was given`);
		}
		return key === "files" ? value.map(shQuote).join(" ") : shQuote(value);
	});
}

/** The remote command that creates `dir` (and parents) on a Unix or a Windows (PowerShell) target. */
export function mkdirCommand(dir) {
	if (isWindowsPath(dir)) {
		return `New-Item -ItemType Directory -Force -Path ${psQuote(dir)} | Out-Null`;
	}
	return `mkdir -p ${shQuote(dir)}`;
}
