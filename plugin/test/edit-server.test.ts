// 実ソケットで `EditServer` の往復（D-21）。ソケットは `/tmp/as-<pid>-<hex>/` に置く
// （Unix ソケットのパスは 104 バイト未満）。

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../src/daemon-client";
import { EditServer, type EditRequest, type EditReply } from "../src/edit-server";

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

describe("EditServer（D-21）", () => {
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

	it("listen 後にソケットは 0600、edit → ok:true で閉じる", async () => {
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

	it("no-tab と busy と cancel を error で返す", async () => {
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

	it("応答の前に相手が切れたら onAbort を呼ぶ（reply は届かない）", async () => {
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

	it("op:cancel でも onAbort を呼ぶ", async () => {
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

	it("stop() は応答待ちに cancel を返し、ソケットを消す", async () => {
		server.onEdit(() => {
			// 応答しない（編集中のまま）。
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

	it("start() は古いソケットを消して listen し直す", async () => {
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
