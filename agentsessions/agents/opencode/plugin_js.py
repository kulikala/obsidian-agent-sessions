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
A top-level session gets its file (status `idle`) when it is created, so the file
is there from launch, before any prompt.
`agents/opencode/live.py` reads them; a dead `pid` marks a file stale.
Event names are the ones OpenCode's SDK types declare; `permission.asked` /
`permission.updated` and both spellings of a session id location are handled
because versions differ. Sub-agent sessions (`parentID` set) are ignored, like
in the session list. Nothing here may throw into OpenCode.

`TUI_PLUGIN_JSX` is the second file, OpenCode's status line
(`~/.config/opencode/agent-sessions-tui.jsx`). A module is either a server plugin or a
TUI plugin, never both, and TUI plugins are not discovered from a folder: the file sits
outside `plugins/` and `tui.json`'s `plugin` array lists it (`tui_config.PLUGIN_SPEC`, kept
there by the managed tui.json writer). It is JSX with the `@opentui/solid` pragma, which the
`opencode` binary compiles itself when it loads the file, so no build step is involved. It
registers a renderer for the `app_bottom` slot, the row under OpenCode's own footer, showing
`[<submit-key symbol> · ]<model> · <variant> · ctx NN% · ●/○ <busy|idle|waiting>` for the
session on screen, all read from the TUI's own state (`api.state`).
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
			} else if (event.type === "session.created") {
				// A top-level session exists from launch: publish it (idle, this process's pid) so
				// the app can tie the session to its process before the first prompt.
				update(info.id, info.directory || directory, (s) => {
					if (!s.base) {
						s.base = "idle";
					}
				});
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


TUI_PLUGIN_JSX = r'''// managed by Agent Sessions (`agent-sessions setup --opencode`). Do not edit: it is rewritten on update
// and deleted by `agent-sessions setup --remove`.
/** @jsxImportSource @opentui/solid */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UI_STATE = path.join(process.env.AGENT_SESSIONS_RUNTIME_DIR || path.join(os.homedir(), ".agents", "sessions"), "ui.json");
const MAX_MODEL = 28;

let cached = { at: 0, symbol: "", ja: false };

// ui.json is written by the Obsidian plugin: the submit-key symbol (shown only in a session it
// started, like `agent-sessions status`) and the display language.
function uiState() {
	const now = Date.now();
	if (now - cached.at < 2000) {
		return cached;
	}
	let symbol = "";
	let ja = false;
	try {
		const data = JSON.parse(fs.readFileSync(UI_STATE, "utf8"));
		if (data && typeof data === "object") {
			ja = typeof data.language === "string" && data.language.startsWith("ja");
			if (process.env.AGENT_SESSIONS_ID && typeof data.submitSymbol === "string") {
				symbol = data.submitSymbol;
			}
		}
	} catch {}
	cached = { at: now, symbol, ja };
	return cached;
}

function last(list, role) {
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i].role === role) {
			return list[i];
		}
	}
	return undefined;
}

function shortModel(id) {
	const name = String(id).split("/").pop();
	return name.length > MAX_MODEL ? name.slice(0, MAX_MODEL - 1) + "…" : name;
}

// The parts of the line for the session on screen: the same items as `agent-sessions status`
// (submit-key symbol, model, effort, ctx %), plus what the session is doing.
function parts(api) {
	try {
		const route = api.route.current;
		if (route.name !== "session" || !route.params || typeof route.params.sessionID !== "string") {
			return null;
		}
		const sid = route.params.sessionID;
		const ui = uiState();
		const msgs = api.state.session.messages(sid);
		const user = last(msgs, "user");
		const assistant = last(msgs, "assistant");
		let providerID = user ? user.model.providerID : assistant ? assistant.providerID : "";
		let modelID = user ? user.model.modelID : assistant ? assistant.modelID : "";
		if (!modelID) {
			const configured = String((api.state.config && api.state.config.model) || "");
			const slash = configured.indexOf("/");
			providerID = slash < 0 ? "" : configured.slice(0, slash);
			modelID = slash < 0 ? configured : configured.slice(slash + 1);
		}
		const variant = (user && user.model.variant) || (assistant && assistant.variant) || (ui.ja ? "デフォルト" : "Default");

		let pct = "—";
		const counted = msgs.findLast((m) => m.role === "assistant" && m.tokens && m.tokens.output > 0);
		if (counted) {
			const t = counted.tokens;
			const used = t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
			const provider = api.state.provider.find((p) => p.id === counted.providerID);
			const limit = provider && provider.models[counted.modelID] && provider.models[counted.modelID].limit.context;
			if (limit) {
				pct = String(Math.round((used / limit) * 100));
			}
		}

		const status = api.state.session.status(sid);
		const waiting = api.state.session.permission(sid).length + api.state.session.question(sid).length > 0;
		const state = waiting ? "waiting" : status && status.type !== "idle" ? "busy" : "idle";
		return {
			head: (ui.symbol ? ui.symbol + " · " : "") + (modelID ? shortModel(modelID) : ui.ja ? "デフォルト" : "Default") + " · " + variant + " · ctx " + pct + "% ·",
			state,
		};
	} catch {
		return null;
	}
}

const tui = async (api) => {
	api.slots.register({
		slots: {
			// The bottom row of the screen, below OpenCode's own footer: the prompt's row already
			// shows agent, model and variant, so this is where a status line sits.
			app_bottom(ctx) {
				const theme = () => ctx.theme.current;
				const color = (state) => (state === "idle" ? theme().textMuted : theme().warning);
				return (
					<box flexShrink={0} paddingLeft={2} paddingRight={2}>
						{parts(api) ? (
							<text fg={theme().textMuted}>
								{parts(api).head} <span style={{ fg: color(parts(api).state) }}>{parts(api).state === "idle" ? "○" : "●"} {parts(api).state}</span>
							</text>
						) : null}
					</box>
				);
			},
		},
	});
};

export default { id: "agent-sessions", tui };
'''
