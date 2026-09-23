// 入力の debounce と確定時の割り込み（T-75）。`views/editor-pane.ts` の内蔵エディタが、
// 入力が落ち着くたびに一時ファイルへ自動保存するのに使う。`setTimeout` 以外は何も持たない
// 純クラス——DOM にも obsidian にも依存しない（`marks.ts` と同じ理由でテストできるように）。

/**
 * `schedule()` を連続で呼んでも、最後の 1 回から `ms` 経ってはじめて `run` が呼ばれる
 * （＝入力のたびに延長される debounce）。確定（送る・入力欄に戻る）は `flush()` で、
 * 待っているタイマーを解除してから `run` を即呼ぶ——自動保存の書き込みと確定の書き込みが
 * 競合しない（片方が終わってからもう片方が始まる。二重に書くこともない）。取消は `cancel()`
 * だけ呼んで `run` を呼ばない（呼出側が別の内容を書く）。
 */
export class SaveDebouncer {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly ms: number,
		private readonly run: () => void
	) {}

	/** 入力があった：待っているタイマーがあれば解除して立て直す。 */
	schedule(): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = null;
			this.run();
		}, this.ms);
	}

	/** 確定：待っているタイマーを解除してから、待たずに `run` を呼ぶ。 */
	flush(): void {
		this.cancel();
		this.run();
	}

	/** 待っているタイマーだけ解除する（`run` は呼ばない）。 */
	cancel(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** タイマーが今も待っているか（テスト・デバッグ用）。 */
	get pending(): boolean {
		return this.timer !== null;
	}
}
