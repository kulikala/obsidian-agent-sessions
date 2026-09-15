// 未適用の名前変更（§6.6 D-12）。`pendingRenames[id]` を、対象のセッションが（daemon 上に
// 存在して）最初に idle になってから 1 秒後に 1 回だけ `/rename` として送り、その後の走査で
// 名前が一致したら消す——という状態機械。時間・状態の通知はすべて外から注入し、`obsidian`・
// `registry.ts`・ファイル I/O には依存しない（テストは test/pending.test.ts）。

/** `tick` が「今すぐ送るべき」と返す 1 件。 */
export interface RenameToSend {
	id: string;
	name: string;
}

export interface PendingTickResult {
	/** 今回の `tick` で送るべきになったもの。 */
	sends: RenameToSend[];
	/** 走査結果の名前が一致し、`pendingRenames` から消してよいもの。 */
	removals: string[];
}

/** idle になってからこの時間が経ったら送る（§6.6）。 */
const SEND_DELAY_MS = 1000;

interface Entry {
	name: string;
	/** 対象のセッションが daemon 上に存在する（`registry` に台帳がある）。 */
	attached: boolean;
	/** 最初に idle を見た時刻。`tick` がこれを起点に `SEND_DELAY_MS` を数える。 */
	idleSince: number | null;
	/** `onStatus("idle")` は見たが、まだ `tick` で時刻を刻んでいない。 */
	awaitingStamp: boolean;
	/** 送信済み（二重送信しない）。 */
	sent: boolean;
}

export class PendingRenamer {
	private entries = new Map<string, Entry>();
	private toRemove = new Set<string>();

	/** `pendingRenames[id] = name` を追う対象にする。名前が変われば送信をやり直す。 */
	track(id: string, name: string): void {
		const existing = this.entries.get(id);
		if (!existing) {
			this.entries.set(id, { name, attached: false, idleSince: null, awaitingStamp: false, sent: false });
			return;
		}
		if (existing.name !== name) {
			existing.name = name;
			existing.sent = false;
		}
	}

	/** `pendingRenames` から消えた（送った側で消した、またはユーザーが取り消した）。 */
	untrack(id: string): void {
		this.entries.delete(id);
		this.toRemove.delete(id);
	}

	/** 対象のセッションが daemon 上に存在するようになった（`registry` に台帳が現れた）。 */
	onAttached(id: string): void {
		const entry = this.entries.get(id);
		if (entry) {
			entry.attached = true;
		}
	}

	/** `registry` の現在の状態。`idle` を見た最初の 1 回だけ `tick` に時刻を刻ませる。 */
	onStatus(id: string, status: string): void {
		const entry = this.entries.get(id);
		if (!entry) {
			return;
		}
		if (status === "idle") {
			if (entry.attached && entry.idleSince === null) {
				entry.awaitingStamp = true;
			}
		} else {
			entry.awaitingStamp = false;
		}
	}

	/** 走査結果の名前。追っている目標名と一致すれば、次の `tick` で `removals` に入る。 */
	onScanned(id: string, name: string | null): void {
		const entry = this.entries.get(id);
		if (entry && name === entry.name) {
			this.toRemove.add(id);
		}
	}

	/** `now` を基準に、送るべきもの・消してよいものを出す。呼ぶたびに内部状態を進める。 */
	tick(now: number): PendingTickResult {
		const sends: RenameToSend[] = [];
		for (const [id, entry] of this.entries) {
			if (entry.awaitingStamp && entry.idleSince === null) {
				entry.idleSince = now;
				entry.awaitingStamp = false;
			}
			if (!entry.sent && entry.idleSince !== null && now - entry.idleSince >= SEND_DELAY_MS) {
				entry.sent = true;
				sends.push({ id, name: entry.name });
			}
		}
		const removals = [...this.toRemove];
		this.toRemove.clear();
		for (const id of removals) {
			this.entries.delete(id);
		}
		return { sends, removals };
	}
}
