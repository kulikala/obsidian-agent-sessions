// transcript の末尾から「直近の指示が `/compact` か」を見る（D-42）。`json detail` の
// `last_user` はスラッシュコマンド（`<command-name>…</command-name>`）を人の指示と数えない
// ので、ここで transcript の末尾を直接読む。判定は純関数、読み出しは `readTailLines`。

import * as fs from "node:fs";

/** 末尾から読む量。直近の指示に届けば十分（1 行が長い tool_result を挟んでも余る）。 */
const TAIL_BYTES = 256 * 1024;

const COMMAND_RE = /^\s*<command-name>\s*([^<\s]+)\s*<\/command-name>/;

interface UserRecord {
	type?: unknown;
	isMeta?: unknown;
	isSidechain?: unknown;
	isCompactSummary?: unknown;
	message?: { content?: unknown };
}

/** `content` からテキストだけを取り出す（`tool_result` だけの行は空になる）。 */
function textOf(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") {
				texts.push(text);
			}
		}
	}
	return texts.join("\n");
}

/**
 * 直近の指示（人が打った `user` 行、またはスラッシュコマンド）を末尾から探し、それが
 * `/compact` なら `true`。機械の差し込み（`isMeta`・`isCompactSummary`・`isSidechain`・
 * `<local-command-stdout>`・`<system-reminder>` だけの行・`tool_result` だけの行）は飛ばす。
 */
export function lastInstructionIsCompact(lines: string[]): boolean {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.includes('"type":"user"')) {
			continue;
		}
		let rec: UserRecord;
		try {
			rec = JSON.parse(line) as UserRecord;
		} catch {
			continue;
		}
		if (rec.type !== "user" || rec.isMeta || rec.isSidechain || rec.isCompactSummary) {
			continue;
		}
		const text = textOf(rec.message?.content).trim();
		if (!text) {
			continue;
		}
		const command = COMMAND_RE.exec(text);
		if (command) {
			return command[1] === "/compact";
		}
		if (text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-caveat>")) {
			continue;
		}
		if (/^<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text)) {
			continue;
		}
		return false;
	}
	return false;
}

/** ファイル末尾 `bytes` を行に割って返す（先頭の切れた行は捨てる）。読めなければ空。 */
export function readTailLines(path: string, bytes = TAIL_BYTES): string[] {
	let fd: number;
	try {
		fd = fs.openSync(path, "r");
	} catch {
		return [];
	}
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		const lines = buf.toString("utf8").split("\n");
		if (start > 0) {
			lines.shift();
		}
		return lines;
	} catch {
		return [];
	} finally {
		fs.closeSync(fd);
	}
}
