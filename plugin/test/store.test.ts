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

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("loadStore / updateStore round-trip", () => {
	let dir: string;
	let storePath: string;

	beforeEach(() => {
		dir = tmpDir("agent-sessions-store-");
		storePath = join(dir, "sessions.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads back exactly what was written", () => {
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

	it("returns an empty Store when the file is missing", () => {
		expect(loadStore(join(dir, "missing.json"))).toEqual(emptyStore());
	});

	it("reads back categoryColors without dropping entries", () => {
		updateStore(storePath, (store) => {
			store.categoryColors.RIM = 3;
			// Japanese fixture: categoryColors keys are free-form category names, so this
			// exercises round-tripping a non-ASCII key.
			store.categoryColors["スキル開発"] = 0;
		});

		expect(loadStore(storePath).categoryColors).toEqual({ RIM: 3, スキル開発: 0 });
	});

	it("can update when the parent directory doesn't exist yet (a vault with no .agents/sessions/ yet)", () => {
		const nested = join(dir, ".agents", "sessions", "sessions.json");
		expect(existsSync(join(dir, ".agents"))).toBe(false);

		updateStore(nested, (store) => {
			store.folded.push("RIM");
		});

		expect(loadStore(nested).folded).toEqual(["RIM"]);
	});

	it("quarantines broken JSON and returns an empty Store", () => {
		writeFileSync(storePath, "{not json", "utf8");

		expect(loadStore(storePath)).toEqual(emptyStore());
		expect(existsSync(storePath)).toBe(false);
		const broken = readdirSync(dir).filter((n) => n.startsWith("sessions.json.broken-"));
		expect(broken).toHaveLength(1);
		expect(readFileSync(join(dir, broken[0]), "utf8")).toBe("{not json");
	});

	it("treats JSON that isn't an object as broken too", () => {
		writeFileSync(storePath, "[1, 2, 3]", "utf8");

		expect(loadStore(storePath)).toEqual(emptyStore());
		const broken = readdirSync(dir).filter((n) => n.startsWith("sessions.json.broken-"));
		expect(broken).toHaveLength(1);
	});
});

describe("locking", () => {
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

	it("throws StoreLockError if the lock can't be acquired within the (default) 2 seconds", () => {
		mkdirSync(lockPath);
		try {
			expect(() => updateStore(storePath, () => {}, { timeoutMs: 200, retryIntervalMs: 50 })).toThrow(
				StoreLockError
			);
		} finally {
			rmdirSync(lockPath);
		}
	});

	it("treats a lock older than 10 seconds as stale, removes it, and reacquires", () => {
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

describe("updateStore mutual exclusion (2 processes)", () => {
	it("doesn't lose updates when writing concurrently", async () => {
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

describe("migrateFromMarkdown", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir("agent-sessions-md-");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("copies folded and hidden into folded/archived (mixing quoted and unquoted entries)", () => {
		const md = [
			"---",
			"folded:",
			'  - "RIM"',
			"  - Other session",
			"hidden:",
			'  - "5778f81f-0be9-4744-aa4c-9f6d5211bd5c | Late night sushi"',
			"---",
			"# Claude sessions",
			"",
		].join("\n");
		const mdPath = join(dir, "claude-sessions.md");
		const storePath = join(dir, "sessions.json");
		writeFileSync(mdPath, md, "utf8");

		const result = migrateFromMarkdown(mdPath, storePath);

		expect(result?.folded).toEqual(["RIM", "Other session"]);
		expect(result?.archived).toEqual([
			{ id: "5778f81f-0be9-4744-aa4c-9f6d5211bd5c", name: "Late night sushi", agent: "claude" },
		]);
		expect(result?.migratedFrom?.path).toBe(mdPath);
		expect(loadStore(storePath)).toEqual(result);
	});

	it("does nothing when sessions.json already exists", () => {
		const mdPath = join(dir, "claude-sessions.md");
		const storePath = join(dir, "sessions.json");
		writeFileSync(mdPath, "---\nfolded:\n  - RIM\n---\n", "utf8");
		updateStore(storePath, () => {});
		const before = loadStore(storePath);

		const result = migrateFromMarkdown(mdPath, storePath);

		expect(result).toBeNull();
		expect(loadStore(storePath)).toEqual(before);
	});

	it("does nothing when the markdown file doesn't exist", () => {
		const storePath = join(dir, "sessions.json");

		expect(migrateFromMarkdown(join(dir, "missing.md"), storePath)).toBeNull();
		expect(existsSync(storePath)).toBe(false);
	});

	it("determines archived from the hidden list alone, even when a table body follows the frontmatter", () => {
		// migrateFromMarkdown doesn't read the table body (the `| name | ... | id |` rows) —
		// it only looks at `hidden:` in the frontmatter — so confirm the body is ignored even
		// when present.
		const md = [
			"---",
			"folded:",
			'  - "RIM"',
			"hidden:",
			'  - "5778f81f-0be9-4744-aa4c-9f6d5211bd5c | Late night sushi"',
			"---",
			"# Claude sessions",
			"",
			"| Name | Folder | Updated | ID |",
			"|---|---|---|---|",
			"| Another session | v | 2026-01-01 12:00 | 11111111-1111-1111-1111-111111111111 |",
			"",
		].join("\n");
		const mdPath = join(dir, "claude-sessions.md");
		const storePath = join(dir, "sessions.json");
		writeFileSync(mdPath, md, "utf8");

		const result = migrateFromMarkdown(mdPath, storePath);

		expect(result?.archived).toEqual([
			{ id: "5778f81f-0be9-4744-aa4c-9f6d5211bd5c", name: "Late night sushi", agent: "claude" },
		]);
	});
});
