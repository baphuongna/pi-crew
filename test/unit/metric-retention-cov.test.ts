import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TimeWindowedCounter } from "../../src/observability/metric-retention.ts";

describe("TimeWindowedCounter inc", () => {
	it("increments with default delta of 1", () => {
		let now = 1000;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "a" });
		assert.equal(counter.count({ reason: "a" }), 1);
	});

	it("increments with custom delta", () => {
		let now = 1000;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "b" }, 5);
		assert.equal(counter.count({ reason: "b" }), 5);
	});

	it("ignores non-finite deltas", () => {
		let now = 1000;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "c" }, Infinity);
		counter.inc({ reason: "c" }, NaN);
		assert.equal(counter.count({ reason: "c" }), 0);
	});

	it("increments multiple times and sums correctly", () => {
		let now = 1000;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "d" }, 3);
		counter.inc({ reason: "d" }, 7);
		assert.equal(counter.count({ reason: "d" }), 10);
	});
});

describe("TimeWindowedCounter count", () => {
	it("returns 0 for labels never incremented", () => {
		let now = 1000;
		const counter = new TimeWindowedCounter(1000, () => now);
		assert.equal(counter.count({ missing: "label" }), 0);
	});

	it("excludes events outside the window", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "x" }, 10);
		now = 2000; // window has passed
		assert.equal(counter.count({ reason: "x" }), 0);
	});

	it("counts within custom durationMs", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(10000, () => now);
		counter.inc({ reason: "y" }, 5);
		now = 3000;
		counter.inc({ reason: "y" }, 3);
		// durationMs=3000 from now=3000: cutoff = 0, includes both events (t=0 and t=3000)
		assert.equal(counter.count({ reason: "y" }, 3000), 8);
		// durationMs=2999 from now=3000: cutoff = 1, excludes first event
		assert.equal(counter.count({ reason: "y" }, 2999), 3);
	});

	it("isolates different label sets", () => {
		let now = 1000;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ a: "1" }, 10);
		counter.inc({ a: "2" }, 20);
		assert.equal(counter.count({ a: "1" }), 10);
		assert.equal(counter.count({ a: "2" }), 20);
	});
});

describe("TimeWindowedCounter rate", () => {
	it("computes per-second rate correctly", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "rate" }, 10);
		assert.equal(counter.rate({ reason: "rate" }, 1000), 10);
	});

	it("returns 0 for zero duration", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ reason: "rate" }, 10);
		assert.equal(counter.rate({ reason: "rate" }, 0), 0);
	});

	it("returns 0 when no events in window", () => {
		let now = 5000;
		const counter = new TimeWindowedCounter(1000, () => now);
		assert.equal(counter.rate({ reason: "none" }, 1000), 0);
	});
});

describe("TimeWindowedCounter size", () => {
	it("returns 0 for empty counter", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(1000, () => now);
		assert.equal(counter.size(), 0);
	});

	it("returns number of events after increments", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(10000, () => now);
		counter.inc({ a: "1" });
		counter.inc({ a: "2" });
		counter.inc({ a: "3" });
		assert.equal(counter.size(), 3);
	});

	it("shrinks as events are pruned", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ a: "1" });
		now = 2000;
		assert.equal(counter.size(), 0);
	});
});

describe("TimeWindowedCounter pruning", () => {
	it("prunes events outside the window on inc", () => {
		let now = 0;
		const counter = new TimeWindowedCounter(1000, () => now);
		counter.inc({ old: "event" }, 1);
		now = 2000;
		counter.inc({ new: "event" }, 1); // triggers prune
		assert.equal(counter.count({ old: "event" }), 0);
		assert.equal(counter.count({ new: "event" }), 1);
	});
});
