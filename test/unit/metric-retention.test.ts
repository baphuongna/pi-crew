import test from "node:test";
import assert from "node:assert/strict";
import { TimeWindowedCounter } from "../../src/observability/metric-retention.ts";

test("TimeWindowedCounter retains within window and prunes outside", () => {
	let now = 0;
	const counter = new TimeWindowedCounter(1000, () => now);
	counter.inc({ reason: "a" }, 2);
	now = 500;
	counter.inc({ reason: "a" }, 1);
	assert.equal(counter.count({ reason: "a" }), 3);
	now = 1499;
	assert.equal(counter.count({ reason: "a" }), 1);
	assert.equal(counter.size(), 1);
});

test("TimeWindowedCounter isolates labels and computes per-second rate", () => {
	let now = 0;
	const counter = new TimeWindowedCounter(1000, () => now);
	counter.inc({ status: "ok" }, 2);
	counter.inc({ status: "bad" }, 5);
	assert.equal(counter.count({ status: "ok" }), 2);
	assert.equal(counter.rate({ status: "ok" }, 1000), 2);
});
