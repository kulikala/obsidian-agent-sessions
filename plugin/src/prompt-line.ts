// 入力行が空かの判定（D-42）。xterm の画面（現在の行の列）から、Claude Code の入力行
// （最後の `❯` の行）を探し、その後ろが空白だけなら「入力中でない」とみなす。
// xterm にも obsidian にも依存しない純関数。`main.ts` の `sendCommand` の経路①で使う。

/** Claude Code の入力行の先頭記号。 */
export const PROMPT_CHAR = "❯";

/**
 * `lines` は画面の上から下への行の列。最後に `❯` を含む行を入力行とし、`❯` より後ろが
 * 空白だけなら `true`。`❯` の行が無ければ `false`（入力行が見えない＝空と断定しない）。
 */
export function isPromptEmpty(lines: string[]): boolean {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const at = line.indexOf(PROMPT_CHAR);
		if (at === -1) {
			continue;
		}
		return line.slice(at + PROMPT_CHAR.length).trim() === "";
	}
	return false;
}
