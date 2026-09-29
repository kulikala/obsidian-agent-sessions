// Stands in for the `agent-sessions` CLI inside the screenshot sandbox: answers the plugin's
// `json …` calls from the scenario instead of scanning real transcripts.
// Usage (via the wrapper `shoot.mjs` writes): node fake-cli.mjs <state.json> <args…>

import { appendFileSync, readFileSync } from "node:fs";

const [statePath, ...args] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const { now, sessions, limits } = state;

function out(value) {
	process.stdout.write(JSON.stringify(value));
}

function lastActivity(s) {
	return now - s.minutesAgo * 60 - 20;
}

function scanSession(s) {
	const [group, label] = s.name.includes(": ") ? s.name.split(": ", 2) : [null, s.name];
	const row = {
		id: s.id,
		agent: s.agent,
		name: s.name,
		group,
		label,
		cwd: s.cwd,
		folder: s.project,
		last_activity: lastActivity(s),
		child: false,
		transcript: null,
	};
	if (s.agent === "codex") {
		row.model = s.model;
		row.effort = s.effort;
	}
	return row;
}

function statsUsage(u, fraction) {
	const scale = (n) => Math.round(n * fraction);
	return {
		calls: Math.max(1, scale(u.input / 9000)),
		input: scale(u.input),
		output: scale(u.output),
		cache_read: scale(u.cache_read),
		cache_create: scale(u.cache_create),
		cost: Math.round(u.cost * fraction * 100) / 100,
		unknown_cost: false,
	};
}

function sumUsage(list) {
	const total = { calls: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, cost: 0, unknown_cost: false };
	for (const u of list) {
		for (const k of ["calls", "input", "output", "cache_read", "cache_create", "cost"]) {
			total[k] += u[k];
		}
	}
	total.cost = Math.round(total.cost * 100) / 100;
	return total;
}

function windowOf(agent, minutes, elapsedSeconds, used, costKey) {
	const start = now - Math.round(elapsedSeconds);
	const perSession = {};
	for (const s of sessions.filter((x) => x.agent === agent && x[costKey])) {
		perSession[s.id] = statsUsage(s.usage, s[costKey] / s.usage.cost);
	}
	return {
		start,
		end: start + minutes * 60,
		used_percentage: used,
		total: sumUsage(Object.values(perSession)),
		sessions: perSession,
		minutes,
		label_key: minutes === 300 ? "stats.window.fiveHour" : "stats.window.sevenDay",
	};
}

function windowsFor(agent) {
	const l = limits[agent];
	return {
		five_hour: windowOf(agent, 300, l.fiveHour.elapsedHours * 3600, l.fiveHour.used, "cost5h"),
		seven_day: windowOf(agent, 10080, l.sevenDay.elapsedDays * 86400, l.sevenDay.used, "cost7d"),
	};
}

function usageOf(s) {
	const u = s.usage;
	const last = lastActivity(s);
	const first = last - 50 * 60;
	const prompts = [s.detail.last_user];
	const turns = prompts.map((prompt, index) => ({
		index,
		ts: first,
		prompt,
		calls: Math.max(1, Math.round(u.input / 9000)),
		input: u.input,
		cache_create: u.cache_create,
		cache_read: u.cache_read,
		output: u.output,
		thinking: 0,
		cost: u.cost,
		tools: { Read: 6, Edit: 3, Bash: 4 },
		estimated: false,
		last_ts: last,
		context_last: Math.round(((s.ctx ?? 30) / 100) * 200_000),
		models: { [s.model]: Math.max(1, Math.round(u.input / 9000)) },
	}));
	return {
		turns,
		total: {
			calls: turns[0].calls,
			input: u.input,
			cache_create: u.cache_create,
			cache_read: u.cache_read,
			output: u.output,
			thinking: 0,
			cost: u.cost,
			tools: turns[0].tools,
			estimated: false,
			duration: last - first,
			first_ts: first,
			last_ts: last,
			context_last: turns[0].context_last,
		},
		from: null,
		to: null,
	};
}

const byId = (id) => sessions.find((s) => s.id === id);

if (args[0] === "--version") {
	out("agent-sessions (screenshot sandbox)");
} else if (args[0] === "daemon") {
	// The sandbox's daemon is already running inside shoot.mjs.
} else if (args[0] === "json") {
	const [, cmd, ...rest] = args;
	if (cmd === "scan") {
		const only = rest[0] === "--only" ? rest.slice(1) : null;
		const list = sessions.filter((s) => !only || only.includes(s.id)).map(scanSession);
		out({ sessions: list, store: { folded: [], archived: [], pendingRenames: {}, sessions: {} } });
	} else if (cmd === "live") {
		const daemonSessions = sessions
			.filter((s) => s.daemon)
			.map((s, i) => ({
				id: s.id,
				agent: s.agent,
				cwd: s.cwd,
				pid: 40000 + i,
				startedAt: lastActivity(s) - 3600,
				clients: s.tab ? 1 : 0,
				exited: s.exited ?? null,
				exitedAt: s.exited != null ? lastActivity(s) : null,
			}));
		out({ live: {}, daemon: { running: true, sessions: daemonSessions } });
	} else if (cmd === "detail") {
		const s = byId(rest[0]);
		out({
			last_user: s?.detail.last_user ?? null,
			last_assistant: s?.detail.last_assistant ?? null,
			last_command: s?.detail.last_command ?? null,
			tools: [],
			model: s?.agent === "codex" ? s.model : null,
			effort: s?.agent === "codex" ? s.effort : null,
		});
	} else if (cmd === "stats") {
		const claude = windowsFor("claude");
		out({ windows: claude, agents: { claude: { windows: claude }, codex: { windows: windowsFor("codex") } } });
	} else if (cmd === "usage") {
		const s = byId(rest[0]);
		out(s ? usageOf(s) : { turns: [], total: null, from: null, to: null });
	} else if (cmd === "resolve") {
		out({ thread: null, transcript: null });
	} else {
		appendFileSync(state.logPath, `unhandled: ${args.join(" ")}\n`);
		out({});
	}
} else {
	appendFileSync(state.logPath, `unhandled: ${args.join(" ")}\n`);
}
