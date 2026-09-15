import { describe, expect, it } from "vitest";
import { PendingRenamer } from "../src/pending";

describe("PendingRenamer（§6.6 未適用の名前変更）", () => {
	it("attach → idle から 1 秒経つまでは送らない", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onAttached("a");
		r.onStatus("a", "idle");

		expect(r.tick(0).sends).toEqual([]);
		expect(r.tick(999).sends).toEqual([]);
	});

	it("idle から 1 秒経ったら 1 回だけ送る", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onAttached("a");
		r.onStatus("a", "idle");
		r.tick(0); // idleSince を 0 に刻む

		expect(r.tick(1000).sends).toEqual([{ id: "a", name: "太郎" }]);
		expect(r.tick(2000).sends).toEqual([]);
	});

	it("attach していなければ idle を見ても送らない", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onStatus("a", "idle");

		r.tick(0);
		expect(r.tick(10000).sends).toEqual([]);
	});

	it("attach 前に idle を見て後から attach しても、その後の onStatus で刻む", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onStatus("a", "idle"); // まだ attach していないので無視される
		r.onAttached("a");
		r.onStatus("a", "idle"); // 改めて idle を通知

		r.tick(0);
		expect(r.tick(1000).sends).toEqual([{ id: "a", name: "太郎" }]);
	});

	it("idle の前に busy が挟まっても、最初の idle を起点にする", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onAttached("a");
		r.onStatus("a", "busy");
		r.onStatus("a", "idle");
		r.tick(100); // idleSince = 100

		expect(r.tick(1099).sends).toEqual([]);
		expect(r.tick(1100).sends).toEqual([{ id: "a", name: "太郎" }]);
	});

	it("追跡していない id の onStatus・onScanned は無視する", () => {
		const r = new PendingRenamer();
		r.onAttached("x");
		r.onStatus("x", "idle");
		r.onScanned("x", "何か");

		expect(r.tick(100000)).toEqual({ sends: [], removals: [] });
	});

	it("走査結果の名前が一致したら次の tick で removals に入り、以後追わない", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onScanned("a", "太郎");

		expect(r.tick(0).removals).toEqual(["a"]);

		r.onAttached("a");
		r.onStatus("a", "idle");
		expect(r.tick(100000).sends).toEqual([]);
	});

	it("走査結果の名前が違えば消さない", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onScanned("a", "次郎");

		expect(r.tick(0).removals).toEqual([]);
	});

	it("untrack すると以後 attach・status・scan を無視する", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.untrack("a");
		r.onAttached("a");
		r.onStatus("a", "idle");

		expect(r.tick(100000).sends).toEqual([]);
	});

	it("2 件を独立に追い、送るべきものだけ列にして返す", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.track("b", "花子");
		r.onAttached("a");
		r.onStatus("a", "idle");
		r.tick(0);
		r.onAttached("b");
		r.onStatus("b", "idle");
		r.tick(500); // b の idleSince = 500

		const sent1000 = r.tick(1000).sends;
		expect(sent1000).toEqual([{ id: "a", name: "太郎" }]);
		expect(r.tick(1500).sends).toEqual([{ id: "b", name: "花子" }]);
	});

	it("track で名前が変わると送信し直す（未送信ならそのまま新しい名前で送る）", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onAttached("a");
		r.onStatus("a", "idle");
		r.tick(0);
		r.track("a", "次郎");

		expect(r.tick(1000).sends).toEqual([{ id: "a", name: "次郎" }]);
	});

	it("送信済みの後に名前が変わると、もう一度送る", () => {
		const r = new PendingRenamer();
		r.track("a", "太郎");
		r.onAttached("a");
		r.onStatus("a", "idle");
		r.tick(0);
		expect(r.tick(1000).sends).toEqual([{ id: "a", name: "太郎" }]);

		r.track("a", "次郎");
		expect(r.tick(1000).sends).toEqual([{ id: "a", name: "次郎" }]);
	});
});
