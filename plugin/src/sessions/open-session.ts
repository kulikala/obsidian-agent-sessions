// One session per tab. `openSession`'s implementation takes only the workspace operations it
// needs through an interface, so it doesn't depend on `obsidian` (mocked in vitest).

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
	/** A brand-new session (no transcript yet) — `views/terminal.ts`'s `startSession` picks the
	 * agent-appropriate fresh-launch argv (`backend.ts`'s `buildAgentArgv`; Claude's is
	 * `--session-id`, Codex has no equivalent). */
	fresh?: boolean;
}

/** The existing leaf, if any, that's a terminal view whose state `id` matches. */
export function findTerminalLeaf<L extends LeafLike>(workspace: WorkspaceLike<L>, id: string): L | undefined {
	return workspace.getLeavesOfType(VIEW_TYPE_TERMINAL).find((leaf) => leaf.getViewState().state?.id === id);
}

/**
 * `openSession(id)`'s implementation. `revealLeaf`s an existing leaf for the same `id`, or
 * otherwise `getLeaf('tab')` then `setViewState`. If a call for the same `id` is already in
 * flight, returns that same promise (`opening`) — removed from `opening` once `setViewState` finishes.
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
