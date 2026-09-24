// Round-trips `EditServer` over a real socket. The socket lives under `/tmp/as-<pid>-<hex>/`
// (Unix socket paths must stay under 104 bytes).

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/daemon-client";
import { EditServer, editReplyFor, submitsAfterEdit, type EditOutcome, type EditRequest, type EditReply } from "../src/edit-server";

interface Client {
	socket: net.Socket;
	responses: Promise<Record<string, unknown>[]>;
	send(body: Record<string, unknown>): void;
}

function connect(sockPath: string): Promise<Client> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(sockPath);
		const decoder = new FrameDecoder();
		const received: Record<string, unknown>[] = [];
		const responses = new Promise<Record<string, unknown>[]>((done) => {
			socket.on("data", (chunk: Buffer) => {
				for (const frame of decoder.feed(chunk)) {
					received.push(JSON.parse(frame.payload.toString("utf8")));
				}
			});
			socket.on("close", () => done(received));
		});
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.removeListener("error", reject);
			socket.on("error", () => undefined);
			resolve({
				socket,
				responses,
				send: (body) => socket.write(encodeFrame("J", Buffer.from(JSON.stringify(body), "utf8"))),
			});
		});
	});
}

function editBody(session = "s1"): Record<string, unknown> {
	return { op: "edit", seq: 1, file: "/tmp/x.md", session, cwd: "/v" };
}

describe("EditServer", () => {
	let dir: string;
	let sockPath: string;
	let server: EditServer;

	beforeEach(async () => {
		dir = `/tmp/as-${process.pid}-${randomBytes(3).toString("hex")}`;
		mkdirSync(dir, { recursive: true });
		sockPath = join(dir, "p.sock");
		server = new EditServer();
	});

	afterEach(() => {
		server.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("the socket is 0600 after listen; an edit request replies ok:true and closes", async () => {
		const seen: EditRequest[] = [];
		server.onEdit((req, reply) => {
			seen.push(req);
			reply(true);
		});
		await server.start(sockPath);
		expect(statSync(sockPath).mode & 0o777).toBe(0o600);

		const client = await connect(sockPath);
		client.send(editBody());
		const responses = await client.responses;
		expect(responses).toEqual([{ ok: true, seq: 1 }]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ file: "/tmp/x.md", session: "s1", cwd: "/v" });
	});

	it("returns no-tab, busy, and cancel as errors", async () => {
		server.onEdit((req, reply) => {
			if (req.session === "none") {
				reply(false, "no-tab");
			} else if (req.session === "busy") {
				reply(false, "busy");
			} else {
				reply(false, "cancel");
			}
		});
		await server.start(sockPath);

		for (const [session, error] of [
			["none", "no-tab"],
			["busy", "busy"],
			["s1", "cancel"],
		]) {
			const client = await connect(sockPath);
			client.send(editBody(session));
			expect(await client.responses).toEqual([{ ok: false, error, seq: 1 }]);
		}
	});

	it("calls onAbort if the peer disconnects before a reply is sent (the reply never arrives)", async () => {
		let aborted = 0;
		let pendingReply: EditReply | null = null;
		server.onEdit((req, reply) => {
			req.onAbort = () => {
				aborted++;
			};
			pendingReply = reply;
		});
		await server.start(sockPath);

		const client = await connect(sockPath);
		client.send(editBody());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(pendingReply).not.toBeNull();
		client.socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(aborted).toBe(1);
		(pendingReply as unknown as EditReply)(true);
		expect(aborted).toBe(1);
	});

	it("also calls onAbort on op:cancel", async () => {
		let aborted = 0;
		server.onEdit((req) => {
			req.onAbort = () => {
				aborted++;
			};
		});
		await server.start(sockPath);

		const client = await connect(sockPath);
		client.send(editBody());
		await new Promise((resolve) => setTimeout(resolve, 30));
		client.send({ op: "cancel", seq: 2 });
		await client.responses;
		expect(aborted).toBe(1);
	});

	it("stop() replies cancel to any pending request and removes the socket", async () => {
		server.onEdit(() => {
			// Never reply (leaves the edit pending).
		});
		await server.start(sockPath);

		const client = await connect(sockPath);
		client.send(editBody());
		await new Promise((resolve) => setTimeout(resolve, 30));
		server.stop();
		expect(await client.responses).toEqual([{ ok: false, error: "cancel", seq: 1 }]);
		expect(() => statSync(sockPath)).toThrow();
		expect(server.listening).toBe(false);
	});

	it("start() removes a stale socket file and listens again", async () => {
		server.onEdit((_req, reply) => reply(true));
		await server.start(sockPath);
		server.stop();
		const again = new EditServer();
		again.onEdit((_req, reply) => reply(true));
		await again.start(sockPath);
		const client = await connect(sockPath);
		client.send(editBody());
		expect(await client.responses).toEqual([{ ok: true, seq: 1 }]);
		again.stop();
	});
});

describe("editReplyFor / submitsAfterEdit", () => {
	it("send and return-to-input are ok; cancel and busy are errors named after themselves", () => {
		expect(editReplyFor("send")).toEqual({ ok: true });
		expect(editReplyFor("return")).toEqual({ ok: true });
		expect(editReplyFor("cancel")).toEqual({ ok: false, error: "cancel" });
		expect(editReplyFor("busy")).toEqual({ ok: false, error: "busy" });
	});

	it("only a prompt-edit temp file continues on to submit", () => {
		expect(submitsAfterEdit("/var/folders/x/T/claude-prompt-1234-abcd.md")).toBe(true);
		expect(submitsAfterEdit("/Users/x/.claude/keybindings.json")).toBe(false);
		expect(submitsAfterEdit("/v/CLAUDE.md")).toBe(false);
		expect(submitsAfterEdit("/tmp/claude-prompt-dir/notes.md")).toBe(false);
	});

	it("over the socket, send/return arrive as ok:true and cancel arrives as ok:false with error:cancel", async () => {
		const dir = `/tmp/as-${process.pid}-${randomBytes(3).toString("hex")}`;
		mkdirSync(dir, { recursive: true });
		const sockPath = join(dir, "p.sock");
		const server = new EditServer();
		server.onEdit((req, reply) => {
			const { ok, error } = editReplyFor(req.session as EditOutcome);
			reply(ok, error);
		});
		await server.start(sockPath);
		try {
			for (const [outcome, expected] of [
				["send", { ok: true, seq: 1 }],
				["return", { ok: true, seq: 1 }],
				["cancel", { ok: false, error: "cancel", seq: 1 }],
			] as const) {
				const client = await connect(sockPath);
				client.send(editBody(outcome));
				expect(await client.responses).toEqual([expected]);
			}
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
