// Stands in for the agent-sessions daemon inside the screenshot sandbox. Speaks the same framed
// protocol (`plugin/src/backend/daemon-client.ts`), never spawns anything, and replays each
// session's canned transcript on attach.

import * as net from "node:net";
import { rmSync } from "node:fs";
import { renderTranscript } from "./transcripts.mjs";

const KIND = { J: 0x4a, D: 0x44, R: 0x52 };

function frame(kind, payload) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const head = Buffer.alloc(5);
	head.writeUInt8(KIND[kind], 0);
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}

/**
 * `sessions`: the scenario's sessions (with `cwd`). Returns `{ close() }`.
 */
export function startFakeDaemon(sockPath, sessions, now) {
	rmSync(sockPath, { force: true });
	const known = new Map(sessions.filter((s) => s.daemon || s.tab).map((s) => [s.id, s]));
	const server = net.createServer((socket) => {
		let buf = Buffer.alloc(0);
		/** The session this connection is attached to — redrawn at the new width on resize. */
		let attached = null;
		socket.on("error", () => undefined);
		socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 5) {
				const kind = buf.readUInt8(0);
				const len = buf.readUInt32BE(1);
				if (buf.length < 5 + len) {
					break;
				}
				const payload = buf.subarray(5, 5 + len);
				buf = buf.subarray(5 + len);
				if (kind === KIND.J) {
					const msg = JSON.parse(payload.toString("utf8"));
					if (msg.op === "attach") {
						attached = known.get(msg.id) ?? null;
					}
					if (msg.op === "resize" && attached?.transcript) {
						// Like a real TUI: clear and redraw at the new size.
						reply(socket, msg.seq);
						const redraw = "\x1b[H\x1b[2J\x1b[3J" + renderTranscript(attached.transcript, msg.cols, attached.title);
						socket.write(frame("D", redraw));
						continue;
					}
					handle(socket, msg);
				}
			}
		});
	});

	function reply(socket, seq, body = {}) {
		socket.write(frame("J", JSON.stringify({ ok: true, seq, ...body })));
	}

	function handle(socket, msg) {
		const { op, seq } = msg;
		if (op === "list") {
			reply(socket, seq, {
				sessions: [...known.values()].map((s, i) => ({
					id: s.id,
					agent: s.agent,
					cwd: s.cwd,
					pid: 40000 + i,
					startedAt: now - 3600,
					clients: s.tab ? 1 : 0,
					exited: s.exited ?? null,
					exitedAt: null,
				})),
			});
		} else if (op === "start") {
			if (!known.has(msg.id)) {
				known.set(msg.id, { id: msg.id, agent: msg.agent, cwd: msg.cwd, tab: true });
			}
			reply(socket, seq);
		} else if (op === "attach") {
			reply(socket, seq);
			const s = known.get(msg.id);
			if (s?.transcript) {
				socket.write(frame("R", renderTranscript(s.transcript, msg.cols, s.title)));
			}
			socket.write(frame("J", JSON.stringify({ ev: "replayed" })));
		} else {
			// hello, resize, detach, kill, forget, shutdown: acknowledge and do nothing.
			reply(socket, seq);
		}
	}

	server.listen(sockPath);
	return {
		close() {
			server.close();
			rmSync(sockPath, { force: true });
		},
	};
}
