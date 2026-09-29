import { describe, expect, it, vi } from "vitest";
import { OllamaModelCache } from "../../src/backend/ollama-models";

describe("OllamaModelCache", () => {
	it("loads once however often ensure is called, and tells every caller that was waiting", async () => {
		const cache = new OllamaModelCache();
		const load = vi.fn(async () => ["a", "b"]);
		const first = vi.fn();
		const second = vi.fn();
		const late = vi.fn();

		await Promise.all([cache.ensure(load, first), cache.ensure(load, second)]);
		await cache.ensure(load, late);

		expect(load).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(late).not.toHaveBeenCalled();
		expect(cache.list).toEqual(["a", "b"]);
	});

	it("does not load again from inside onLoaded (a redraw that asks again)", async () => {
		const cache = new OllamaModelCache();
		const load = vi.fn(async () => ["a"]);
		const onLoaded = vi.fn(() => void cache.ensure(load, onLoaded));

		await cache.ensure(load, onLoaded);

		expect(load).toHaveBeenCalledTimes(1);
		expect(onLoaded).toHaveBeenCalledTimes(1);
	});

	it("keeps an empty list after a failure and does not retry by itself", async () => {
		const cache = new OllamaModelCache();
		const load = vi.fn(async () => {
			throw new Error("no ollama");
		});
		const onLoaded = vi.fn();

		await cache.ensure(load, onLoaded);
		await cache.ensure(load, onLoaded);

		expect(cache.list).toEqual([]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(onLoaded).toHaveBeenCalledTimes(1);
	});

	it("reset makes the next ensure load again and drops a load still in flight", async () => {
		const cache = new OllamaModelCache();
		let finish: (names: string[]) => void = () => undefined;
		const slow = new Promise<string[]>((resolve) => (finish = resolve));
		const stale = vi.fn();
		const pending = cache.ensure(() => slow, stale);

		cache.reset();
		finish(["old"]);
		await pending;
		expect(stale).not.toHaveBeenCalled();
		expect(cache.list).toBeNull();

		const load = vi.fn(async () => ["new"]);
		await cache.ensure(load, vi.fn());
		expect(load).toHaveBeenCalledTimes(1);
		expect(cache.list).toEqual(["new"]);
	});
});
