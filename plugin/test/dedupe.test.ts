import { describe, expect, it } from "vitest";
import { SessionOpener, VIEW_TYPE_TERMINAL, type LeafLike, type WorkspaceLike } from "../src/open-session";

class FakeLeaf implements LeafLike {
	type = "empty";
	state: Record<string, unknown> = {};
	revealed = 0;

	constructor(private onSet: () => Promise<void>) {}

	getViewState() {
		return { type: this.type, state: this.state };
	}

	async setViewState(vs: { type: string; state: Record<string, unknown> }): Promise<void> {
		await this.onSet();
		this.type = vs.type;
		this.state = vs.state;
	}
}

class FakeWorkspace implements WorkspaceLike<FakeLeaf> {
	leaves: FakeLeaf[] = [];
	created = 0;
	setDelay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 10));

	getLeavesOfType(type: string): FakeLeaf[] {
		return this.leaves.filter((l) => l.type === type);
	}

	getLeaf(_newLeaf: "tab"): FakeLeaf {
		this.created++;
		const leaf = new FakeLeaf(this.setDelay);
		this.leaves.push(leaf);
		return leaf;
	}

	revealLeaf(leaf: FakeLeaf): void {
		leaf.revealed++;
	}
}

describe("SessionOpener（§6.4 の多重呼出）", () => {
	it("同じ id を 3 回同時に呼んでも leaf の生成は 1 回", async () => {
		const ws = new FakeWorkspace();
		const opener = new SessionOpener(ws);
		const results = await Promise.all([opener.open("s1"), opener.open("s1"), opener.open("s1")]);
		expect(ws.created).toBe(1);
		expect(results[0]).toBe(results[1]);
		expect(results[1]).toBe(results[2]);
		expect(results[0].getViewState()).toEqual({
			type: VIEW_TYPE_TERMINAL,
			state: { id: "s1", agent: "claude", cwd: "" },
		});
		expect(opener.opening.size).toBe(0);
	});

	it("開いた後の呼出は revealLeaf だけで leaf を作らない", async () => {
		const ws = new FakeWorkspace();
		const opener = new SessionOpener(ws);
		const first = await opener.open("s1", { agent: "claude", cwd: "/v" });
		expect(first.revealed).toBe(1);
		const again = await opener.open("s1");
		expect(again).toBe(first);
		expect(ws.created).toBe(1);
		expect(first.revealed).toBe(2);
	});

	it("別の id は別の leaf になり、fresh は state に載る", async () => {
		const ws = new FakeWorkspace();
		const opener = new SessionOpener(ws);
		const [a, b] = await Promise.all([opener.open("a"), opener.open("b", { fresh: true, cwd: "/v" })]);
		expect(ws.created).toBe(2);
		expect(a).not.toBe(b);
		expect(b.getViewState().state).toEqual({ id: "b", agent: "claude", cwd: "/v", fresh: true });
	});

	it("setViewState が失敗しても opening から消え、次の呼出は作り直す", async () => {
		const ws = new FakeWorkspace();
		let fail = true;
		ws.setDelay = async () => {
			if (fail) {
				throw new Error("boom");
			}
		};
		const opener = new SessionOpener(ws);
		await expect(opener.open("s1")).rejects.toThrow("boom");
		expect(opener.opening.size).toBe(0);
		fail = false;
		const leaf = await opener.open("s1");
		expect(leaf.getViewState().type).toBe(VIEW_TYPE_TERMINAL);
	});
});
