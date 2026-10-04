import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate, failedStep, oneLine, skipAll, targetResult } from "../lib/results.mjs";

const step = (status) => ({ name: "s", status, ms: 1, message: "" });

test("aggregate counts each status and passes only with no failure", () => {
	const r = aggregate([step("pass"), step("pass"), step("skipped")]);
	assert.deepEqual([r.pass, r.fail, r.skipped, r.total, r.ok], [2, 0, 1, 3, true]);
	assert.equal(aggregate([step("pass"), step("fail")]).ok, false);
});

test("aggregate: nothing that passed is not a pass", () => {
	assert.equal(aggregate([]).ok, false);
	assert.equal(aggregate([step("skipped")]).ok, false);
});

test("aggregate: an unknown status counts as a failure", () => {
	const r = aggregate([step("pass"), step("weird")]);
	assert.equal(r.fail, 1);
	assert.equal(r.ok, false);
});

test("skipAll and failedStep", () => {
	assert.deepEqual(skipAll(["a", "b"], "why"), [
		{ name: "a", status: "skipped", ms: 0, message: "why" },
		{ name: "b", status: "skipped", ms: 0, message: "why" },
	]);
	assert.equal(failedStep("x", "boom").status, "fail");
});

test("targetResult joins run and verify; a runner error fails it", () => {
	const ok = targetResult({ target: "t", startedAt: "now", run: [step("pass")], verify: [step("pass")] });
	assert.equal(ok.ok, true);
	assert.equal(ok.summary.total, 2);
	const bad = targetResult({ target: "t", startedAt: "now", run: [step("pass")], verify: [step("pass")], error: "x" });
	assert.equal(bad.ok, false);
	assert.match(oneLine(bad), /^FAIL t: 2 pass, 0 fail, 0 skipped \(x\)$/);
	assert.match(oneLine(ok), /^PASS t/);
});
