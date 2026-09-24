import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveDebouncer } from "../../src/terminal/autosave";

describe("SaveDebouncer (autosave for the built-in editor)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("calls run once after ms has passed since schedule", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		vi.advanceTimersByTime(799);
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("calls run only once, ms after the last schedule call, when scheduled repeatedly within ms (debounce)", () => {
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

	it("flush cancels the pending timer and calls run immediately (an explicit save doesn't wait for autosave)", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		vi.advanceTimersByTime(100);
		d.flush();
		expect(run).toHaveBeenCalledTimes(1);

		// The cancelled timer never fires later, so the save isn't written twice.
		vi.advanceTimersByTime(1000);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("flush calls run even when no timer is pending (an explicit save writes even without prior input)", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.flush();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("cancel only clears the pending timer and does not call run (a cancel writes the original content separately)", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		d.cancel();
		vi.advanceTimersByTime(2000);
		expect(run).not.toHaveBeenCalled();
	});

	it("calling schedule after flush starts a new timer that calls run again", () => {
		const run = vi.fn();
		const d = new SaveDebouncer(800, run);
		d.schedule();
		d.flush();
		expect(run).toHaveBeenCalledTimes(1);

		d.schedule();
		vi.advanceTimersByTime(800);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("pending is true only while a timer is waiting", () => {
		const d = new SaveDebouncer(800, () => undefined);
		expect(d.pending).toBe(false);
		d.schedule();
		expect(d.pending).toBe(true);
		vi.advanceTimersByTime(800);
		expect(d.pending).toBe(false);
	});

	it("pending is false after flush or cancel", () => {
		const d = new SaveDebouncer(800, () => undefined);
		d.schedule();
		d.flush();
		expect(d.pending).toBe(false);

		d.schedule();
		d.cancel();
		expect(d.pending).toBe(false);
	});
});
