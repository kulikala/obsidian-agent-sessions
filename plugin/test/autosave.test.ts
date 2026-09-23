import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveDebouncer } from "../src/autosave";

describe("SaveDebouncer（T-75：内蔵エディタの自動保存）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedule から ms 経つと run が 1 回呼ばれる", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		vi.advanceTimersByTime(799);
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("ms の間に連続で schedule すると、最後の 1 回から ms 経ってはじめて run が 1 回だけ呼ばれる（debounce）", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		vi.advanceTimersByTime(500);
		d.schedule();
		vi.advanceTimersByTime(500);
		d.schedule();
		vi.advanceTimersByTime(799);
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("flush は待っているタイマーを解除してから即 run を呼ぶ（確定が自動保存を待たない）", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		vi.advanceTimersByTime(100);
		d.flush();
		expect(run).toHaveBeenCalledTimes(1);

		// 解除したタイマーは後から発火しない＝二重に書かれない。
		vi.advanceTimersByTime(1000);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("flush は待っているタイマーが無くても run を呼ぶ（入力していなくても確定は書く）", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.flush();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("cancel は待っているタイマーを消すだけで run は呼ばない（取消は元の内容を別に書く）", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		d.cancel();
		vi.advanceTimersByTime(2000);
		expect(run).not.toHaveBeenCalled();
	});

	it("flush の後に schedule すると、また新しいタイマーで run が呼ばれる", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		d.flush();
		expect(run).toHaveBeenCalledTimes(1);

		d.schedule();
		vi.advanceTimersByTime(800);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("pending はタイマーが待っている間だけ true", () => {
		const d = new SaveDebouncer(800, () => undefined);
		expect(d.pending).toBe(false);
		d.schedule();
		expect(d.pending).toBe(true);
		vi.advanceTimersByTime(800);
		expect(d.pending).toBe(false);
	});

	it("pending は flush・cancel の後は false", () => {
		const d = new SaveDebouncer(800, () => undefined);
		d.schedule();
		d.flush();
		expect(d.pending).toBe(false);

		d.schedule();
		d.cancel();
		expect(d.pending).toBe(false);
	});
});
