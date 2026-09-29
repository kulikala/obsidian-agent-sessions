"""The OpenCode plugin `agent-sessions setup --opencode` installs, as source text.

It lives in a `.py` module (not a `.js` file) so the plugin build, which bundles
every `.py` under `agentsessions/`, carries it into an in-Obsidian install
without a separate asset. The first line is the marker `setup.py` uses to
recognize the file as ours: only a file carrying it is ever overwritten or
removed.

The plugin runs inside the `opencode` process and writes one status file per
session, `~/.agents/sessions/opencode/<ses_id>.json`:
`{"status": "busy"|"idle"|"waiting", "waiting_for": "permission"|"question"|"",
"pid": process.pid, "cwd", "updated_at"}` (seconds), atomically (tmp + rename).
`agents/opencode/live.py` reads them; a dead `pid` marks a file stale.
Event names are the ones OpenCode's SDK types declare; `permission.asked` /
`permission.updated` and both spellings of a session id location are handled
because versions differ. Sub-agent sessions (`parentID` set) are ignored, like
in the session list. Nothing here may throw into OpenCode.
"""

MARKER = '// managed by Agent Sessions'

PLUGIN_JS = r'''// managed by Agent Sessions (`agent-sessions setup --opencode`). Do not edit: it is rewritten on update
// and deleted by `agent-sessions setup --remove`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".agents", "sessions", "opencode");
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// id -> { base: "busy" | "idle" | "", permission: bool, question: bool }
const sessions = new Map();
const children = new Set();
const written = new Set();

function fileOf(id) {
	return path.join(DIR, id + ".json");
}

function remove(id) {
	sessions.delete(id);
	written.delete(id);
	try {
		fs.unlinkSync(fileOf(id));
	} catch {}
}

function write(id, directory) {
	const s = sessions.get(id);
	if (!s) {
		return;
	}
	const waiting = s.permission || s.question;
	const status = waiting ? "waiting" : s.base;
	if (!status) {
		return;
	}
	const waitingFor = !waiting ? "" : s.permission ? "permission" : "question";
	const file = fileOf(id);
	const tmp = file + "." + process.pid + ".tmp";
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(
		tmp,
		JSON.stringify({
			status,
			waiting_for: waitingFor,
			pid: process.pid,
			cwd: directory || "",
			updated_at: Date.now() / 1000,
		}),
	);
	fs.renameSync(tmp, file);
	written.add(id);
}

function update(id, directory, change) {
	if (typeof id !== "string" || !SAFE_ID.test(id) || children.has(id)) {
		return;
	}
	const s = sessions.get(id) || { base: "", permission: false, question: false };
	sessions.set(id, s);
	change(s);
	write(id, directory);
}

function handle(event, directory) {
	const props = (event && event.properties) || {};
	const id = props.sessionID || (props.info && props.info.sessionID);
	switch (event && event.type) {
		case "session.created":
		case "session.updated": {
			const info = props.info || {};
			if (info.parentID && typeof info.id === "string") {
				children.add(info.id);
				remove(info.id);
			}
			break;
		}
		case "session.status": {
			const type = props.status && props.status.type;
			if (type === "busy" || type === "retry") {
				update(id, directory, (s) => {
					s.base = "busy";
				});
			} else if (type === "idle") {
				update(id, directory, (s) => {
					s.base = "idle";
					s.permission = false;
					s.question = false;
				});
			}
			break;
		}
		case "session.idle":
			update(id, directory, (s) => {
				s.base = "idle";
				s.permission = false;
				s.question = false;
			});
			break;
		case "permission.asked":
		case "permission.updated":
			update(id, directory, (s) => {
				s.permission = true;
			});
			break;
		case "permission.replied":
			update(id, directory, (s) => {
				s.permission = false;
			});
			break;
		case "question.asked":
			update(id, directory, (s) => {
				s.question = true;
			});
			break;
		case "question.replied":
		case "question.rejected":
			update(id, directory, (s) => {
				s.question = false;
			});
			break;
		case "session.deleted": {
			const gone = (props.info && props.info.id) || props.sessionID;
			if (typeof gone === "string" && SAFE_ID.test(gone)) {
				remove(gone);
			}
			break;
		}
	}
}

process.on("exit", () => {
	for (const id of written) {
		try {
			fs.unlinkSync(fileOf(id));
		} catch {}
	}
});

export const AgentSessionsStatus = async ({ directory }) => ({
	event: async ({ event }) => {
		try {
			handle(event, directory);
		} catch {}
	},
});
'''
