import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyStore, loadStore, migrateFromMarkdown, StoreLockError, updateStore } from "../src/store";

const here = fileURLToPath(new URL(".", import.meta.url));
const storeSrcPath = join(here, "..", "src", "store.ts");

const REAL_MD_PATH =
	"/path/to/vault/claude-sessions.md";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("loadStore / updateStore 往復", () => {
	let dir: string;
	let storePath: string;

	beforeEach(() => {
		dir = tmpDir("agent-sessions-store-");
		storePath = join(dir, "sessions.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("書いたものをそのまま読める", () => {
		updateStore(storePath, (store) => {
			store.folded.push("RIM");
			store.archived.push({ id: "a", name: "x", agent: "claude" });
			store.pendingRenames.a = "new name";
			store.sessions.a = { agent: "claude", cwd: "/v" };
		});

		expect(loadStore(storePath)).toEqual({
			version: 1,
			folded: ["RIM"],
			archived: [{ id: "a", name: "x", agent: "claude" }],
			pendingRenames: { a: "new name" },
			sessions: { a: { agent: "claude", cwd: "/v" } },
			categoryColors: {},
		});
	});

	it("無いファイルは空の Store", () => {
		expect(loadStore(join(dir, "missing.json"))).toEqual(emptyStore());
	});

	it("categoryColors を落とさず書いたものをそのまま読める（T-70）", () => {
		updateStore(storePath, (store) => {
			store.categoryColors.RIM = 3;
			store.categoryColors["スキル開発"] = 0;
		});

		expect(loadStore(storePath).categoryColors).toEqual({ RIM: 3, スキル開発: 0 });
	});

	it("親ディレクトリが無い状態から update できる（.agents/sessions/ がまだ無い vault）", () => {
		const nested = join(dir, ".agents", "sessions", "sessions.json");
		expect(existsSync(join(dir, ".agents"))).toBe(false);

		updateStore(nested, (store) => {
			store.folded.push("RIM");
		});

		expect(loadStore(nested).folded).toEqual(["RIM"]);
	});

	it("壊れた JSON は退避して空の Store を返す", () => {
		writeFileSync(storePath, "{not json", "utf8");

		expect(loadStore(storePath)).toEqual(emptyStore());
		expect(existsSync(storePath)).toBe(false);
		const broken = readdirSync(dir).filter((n) => n.startsWith("sessions.json.broken-"));
		expect(broken).toHaveLength(1);
		expect(readFileSync(join(dir, broken[0]), "utf8")).toBe("{not json");
	});

	it("オブジェクトでない JSON も壊れた扱い", () => {
		writeFileSync(storePath, "[1, 2, 3]", "utf8");

		expect(loadStore(storePath)).toEqual(emptyStore());
		const broken = readdirSync(dir).filter((n) => n.startsWith("sessions.json.broken-"));
		expect(broken).toHaveLength(1);
	});
});

describe("ロック", () => {
	let dir: string;
	let storePath: string;
	let lockPath: string;

	beforeEach(() => {
		dir = tmpDir("agent-sessions-lock-");
		storePath = join(dir, "sessions.json");
		lockPath = `${storePath}.lock`;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("2 秒（既定）で取れなければ StoreLockError", () => {
		mkdirSync(lockPath);
		try {
			expect(() => updateStore(storePath, () => {}, { timeoutMs: 200, retryIntervalMs: 50 })).toThrow(
				StoreLockError
			);
		} finally {
			rmdirSync(lockPath);
		}
	});

	it("10 秒より古いロックは壊れたものとして消し、取り直す", () => {
		mkdirSync(lockPath);
		const old = new Date(Date.now() - 20000);
		utimesSync(lockPath, old, old);

		const start = Date.now();
		const result = updateStore(
			storePath,
			(store) => {
				store.folded.push("x");
			},
			{ timeoutMs: 1000, retryIntervalMs: 50, staleAfterMs: 10000 }
		);

		expect(Date.now() - start).toBeLessThan(500);
		expect(result.folded).toEqual(["x"]);
	});
});

describe("updateStore の排他（2 プロセス）", () => {
	it("同時に書いても更新を失わない", async () => {
		const dir = tmpDir("agent-sessions-concurrency-");
		const bundlePath = join(dir, "store.bundle.cjs");
		buildSync({
			entryPoints: [storeSrcPath],
			bundle: true,
			platform: "node",
			format: "cjs",
			outfile: bundlePath,
		});

		const storePath = join(dir, "sessions.json");
		updateStore(storePath, () => {});

		const runnerPath = join(here, "fixtures", "bump-runner.cjs");
		const run = (tag: string) =>
			new Promise<void>((resolve, reject) => {
				const child = spawn(process.execPath, [runnerPath, bundlePath, storePath, tag, "50"]);
				child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`bump-runner exit ${code}`))));
				child.on("error", reject);
			});

		await Promise.all([run("a"), run("b")]);

		const final = loadStore(storePath);
		expect(final.folded).toHaveLength(100);
		expect(new Set(final.folded).size).toBe(100);

		rmSync(dir, { recursive: true, force: true });
	}, 30000);
});

function stripFrontmatter(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") {
		return text;
	}
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			return lines.slice(i + 1).join("\n");
		}
	}
	return text;
}

describe("migrateFromMarkdown", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir("agent-sessions-md-");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("folded と hidden を folded／archived に写す（引用符あり・無し混在）", () => {
		const md = [
			"---",
			"folded:",
			'  - "RIM"',
			"  - その他のセッション",
			"hidden:",
			'  - "5778f81f-0be9-4744-aa4c-9f6d5211bd5c | 酔い酒鮨庵"',
			"---",
			"# Claude sessions",
			"",
		].join("\n");
		const mdPath = join(dir, "claude-sessions.md");
		const storePath = join(dir, "sessions.json");
		writeFileSync(mdPath, md, "utf8");

		const result = migrateFromMarkdown(mdPath, storePath);

		expect(result?.folded).toEqual(["RIM", "その他のセッション"]);
		expect(result?.archived).toEqual([
			{ id: "5778f81f-0be9-4744-aa4c-9f6d5211bd5c", name: "酔い酒鮨庵", agent: "claude" },
		]);
		expect(result?.migratedFrom?.path).toBe(mdPath);
		expect(loadStore(storePath)).toEqual(result);
	});

	it("sessions.json が既にあれば何もしない", () => {
		const mdPath = join(dir, "claude-sessions.md");
		const storePath = join(dir, "sessions.json");
		writeFileSync(mdPath, "---\nfolded:\n  - RIM\n---\n", "utf8");
		updateStore(storePath, () => {});
		const before = loadStore(storePath);

		const result = migrateFromMarkdown(mdPath, storePath);

		expect(result).toBeNull();
		expect(loadStore(storePath)).toEqual(before);
	});

	it("md が無ければ何もしない", () => {
		const storePath = join(dir, "sessions.json");

		expect(migrateFromMarkdown(join(dir, "missing.md"), storePath)).toBeNull();
		expect(existsSync(storePath)).toBe(false);
	});

	it("実 vault の claude-sessions.md をコピーした fixture で archived が入る", () => {
		if (!existsSync(REAL_MD_PATH)) {
			return;
		}
		const body = readFileSync(REAL_MD_PATH, "utf8");
		const rowMatch = body.match(/^\|\s*([^|]+?)\s*\|[^|]*\|[^|]*\|\s*([0-9a-fA-F-]{36})\s*\|\s*$/m);
		expect(rowMatch).not.toBeNull();
		const [, name, id] = rowMatch as RegExpMatchArray;

		// 実物には folded/hidden が無いので、コピーした本体に frontmatter を足して
		// 取り込みを試す（実物の行データはそのまま使う）。
		const fixture = [
			"---",
			"folded:",
			'  - "RIM"',
			"hidden:",
			`  - "${id} | ${name}"`,
			"---",
			stripFrontmatter(body),
		].join("\n");

		const mdPath = join(dir, "claude-sessions.md");
		const storePath = join(dir, "sessions.json");
		writeFileSync(mdPath, fixture, "utf8");

		const result = migrateFromMarkdown(mdPath, storePath);

		expect(result?.archived).toEqual([{ id, name, agent: "claude" }]);
	});
});
