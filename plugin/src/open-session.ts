// 1 セッション＝1 タブ（§6.4）。`openSession` の本体を、workspace の必要な操作だけを
// インターフェースで受ける形にし、`obsidian` に依存させない（vitest でモックする）。

export const VIEW_TYPE_TERMINAL = "agent-sessions-terminal";

export interface LeafLike {
	getViewState(): { type: string; state?: Record<string, unknown> };
	setViewState(state: { type: string; state: Record<string, unknown>; active?: boolean }): Promise<void>;
}

export interface WorkspaceLike<L extends LeafLike> {
	getLeavesOfType(type: string): L[];
	getLeaf(newLeaf: "tab"): L;
	revealLeaf(leaf: L): Promise<void> | void;
}

export interface OpenSessionOptions {
	agent?: string;
	cwd?: string;
	/** 新規セッション（transcript がまだ無い）。`start` の argv が `--session-id` になる。 */
	fresh?: boolean;
}

/** 既存の leaf のうち、ターミナルビューで state の `id` が一致するもの。 */
export function findTerminalLeaf<L extends LeafLike>(workspace: WorkspaceLike<L>, id: string): L | undefined {
	return workspace.getLeavesOfType(VIEW_TYPE_TERMINAL).find((leaf) => leaf.getViewState().state?.id === id);
}

/**
 * `openSession(id)` の中身。同じ `id` の leaf があれば `revealLeaf`、無ければ
 * `getLeaf('tab')` → `setViewState`。同じ `id` の呼出が進行中なら、その Promise を返す
 * （`opening`）。`setViewState` が終わってから `opening` から消す。
 */
export class SessionOpener<L extends LeafLike> {
	readonly opening = new Map<string, Promise<L>>();

	constructor(private workspace: WorkspaceLike<L>) {}

	open(id: string, opts: OpenSessionOptions = {}): Promise<L> {
		const inflight = this.opening.get(id);
		if (inflight) {
			return inflight;
		}
		const existing = findTerminalLeaf(this.workspace, id);
		if (existing) {
			return Promise.resolve(this.workspace.revealLeaf(existing)).then(() => existing);
		}
		const promise = this.create(id, opts).finally(() => {
			this.opening.delete(id);
		});
		this.opening.set(id, promise);
		return promise;
	}

	private async create(id: string, opts: OpenSessionOptions): Promise<L> {
		const leaf = this.workspace.getLeaf("tab");
		const state: Record<string, unknown> = { id, agent: opts.agent ?? "claude", cwd: opts.cwd ?? "" };
		if (opts.fresh) {
			state.fresh = true;
		}
		await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, state, active: true });
		await this.workspace.revealLeaf(leaf);
		return leaf;
	}
}
