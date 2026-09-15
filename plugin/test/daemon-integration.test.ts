// 実デーモンとの往復。`AGENT_SESSIONS_BIN`（`agent-sessions` 本体へのパス）が
// 環境変数に無ければ丸ごと skip する。
// ソケットは `/tmp/as-<pid>/` に置く（Unix ソケットのパスは 104 バイト未満）。
// 実行時ディレクトリも同じ場所にし、本物の `~/.agents/sessions` に触れない。

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client";

const BIN = process.env.AGENT_SESSIONS_BIN;

function waitForSocket(sockPath: string, timeoutMs = 3000): Promise<void> {
	const client = new DaemonClient(sockPath);
	const start = Date.now();
	const attempt = async (): Promise<void> => {
		try {
			await client.connect();
			client.close();
		} catch (err) {
			if (Date.now() - start > timeoutMs) {
				throw err;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
			return attempt();
		}
	};
	return attempt();
}

describe.skipIf(!BIN)("daemon（実プロセス）", () => {
	let daemonProc: ChildProcess | undefined;
	let runtimeDir: string;
	let sockPath: string;

	afterEach(async () => {
		const proc = daemonProc;
		daemonProc = undefined;
		if (proc && proc.exitCode === null) {
			// shutdown 後の後始末（exited.json・ソケットの削除）が済むのを待ってから消す。
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
					resolve();
				}, 2000);
				proc.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		rmSync(runtimeDir, { recursive: true, force: true });
	});

	it("hello → start(cat) → attach → 入出力の往復 → shutdown", async () => {
		runtimeDir = `/tmp/as-${process.pid}-${randomBytes(3).toString("hex")}`;
		mkdirSync(runtimeDir, { recursive: true });
		sockPath = join(runtimeDir, "d.sock");
		daemonProc = spawn(BIN as string, ["daemon", "--sock", sockPath, "--runtime-dir", runtimeDir], {
			env: { ...process.env, AGENT_SESSIONS_SOCK: sockPath, AGENT_SESSIONS_RUNTIME_DIR: runtimeDir },
			stdio: "ignore",
		});

		await waitForSocket(sockPath);

		const client = new DaemonClient(sockPath);
		await client.connect();

		const helloRes = await client.hello("plugin");
		expect(helloRes.ok).toBe(true);

		const id = `it-${randomBytes(4).toString("hex")}`;
		const startRes = await client.start({
			id,
			agent: "test",
			cwd: process.cwd(),
			argv: ["cat"],
			env: {},
			cols: 80,
			rows: 24,
		});
		expect(startRes.ok).toBe(true);

		const chunks: Buffer[] = [];
		client.on("data", (buf: Buffer) => chunks.push(buf));
		const replayed = new Promise<void>((resolve) => client.once("replayed", () => resolve()));

		const attachRes = await client.attach(id, 80, 24);
		expect(attachRes.ok).toBe(true);
		await replayed;

		client.writeInput(Buffer.from("hello\n"));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(Buffer.concat(chunks).toString("utf8")).toContain("hello");

		const killRes = await client.kill(id);
		expect(killRes.ok).toBe(true);

		const shutdownRes = await client.shutdown();
		expect(shutdownRes.ok).toBe(true);
	});
});
