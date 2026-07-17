import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyHeartbeat, DEFAULT_GRADIENT_THRESHOLDS, heartbeatAgeMs } from "../../src/runtime/heartbeat-gradient.ts";
import type { WorkerHeartbeatState } from "../../src/runtime/worker-heartbeat.ts";

describe("heartbeatAgeMs", () => {
	it("returns Infinity for undefined heartbeat", () => {
		assert.strictEqual(heartbeatAgeMs(undefined), Number.POSITIVE_INFINITY);
	});

	it("returns 0 for heartbeat at exact now", () => {
		const now = Date.now();
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now).toISOString(),
			alive: true,
		};
		assert.strictEqual(heartbeatAgeMs(hb, now), 0);
	});

	it("returns positive age for stale heartbeat", () => {
		const now = Date.parse("2026-01-01T00:10:00.000Z");
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now - 60_000).toISOString(),
			alive: true,
		};
		const age = heartbeatAgeMs(hb, now);
		assert.strictEqual(age, 60_000);
	});

	it("returns Infinity for invalid date string", () => {
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: "not-a-date",
			alive: true,
		};
		assert.strictEqual(heartbeatAgeMs(hb), Number.POSITIVE_INFINITY);
	});

	it("clamps negative age to 0", () => {
		const now = Date.now();
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now + 5000).toISOString(), // future timestamp
			alive: true,
		};
		assert.strictEqual(heartbeatAgeMs(hb, now), 0);
	});
});

describe("classifyHeartbeat", () => {
	const thresholds = DEFAULT_GRADIENT_THRESHOLDS;

	it("returns 'dead' for undefined heartbeat", () => {
		assert.strictEqual(classifyHeartbeat(undefined, thresholds, 0), "dead");
	});

	it("returns 'dead' when alive is false", () => {
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date().toISOString(),
			alive: false,
		};
		assert.strictEqual(classifyHeartbeat(hb, thresholds, Date.now()), "dead");
	});

	it("returns 'healthy' for recent heartbeat", () => {
		const now = Date.now();
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now - 1000).toISOString(),
			alive: true,
		};
		assert.strictEqual(classifyHeartbeat(hb, thresholds, now), "healthy");
	});

	it("returns 'warn' between warnMs and staleMs", () => {
		const now = Date.now();
		const elapsed = thresholds.warnMs + 1000; // above warn, below stale
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now - elapsed).toISOString(),
			alive: true,
		};
		assert.strictEqual(classifyHeartbeat(hb, thresholds, now), "warn");
	});

	it("returns 'stale' between staleMs and deadMs", () => {
		const now = Date.now();
		const elapsed = thresholds.staleMs + 1000;
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now - elapsed).toISOString(),
			alive: true,
		};
		assert.strictEqual(classifyHeartbeat(hb, thresholds, now), "stale");
	});

	it("returns 'dead' when elapsed exceeds deadMs", () => {
		const now = Date.now();
		const elapsed = thresholds.deadMs + 1000;
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now - elapsed).toISOString(),
			alive: true,
		};
		assert.strictEqual(classifyHeartbeat(hb, thresholds, now), "dead");
	});

	it("uses DEFAULT_GRADIENT_THRESHOLDS when not provided", () => {
		const now = Date.now();
		const hb: WorkerHeartbeatState = {
			workerId: "w1",
			lastSeenAt: new Date(now).toISOString(),
			alive: true,
		};
		// Should not throw — default thresholds are used
		assert.strictEqual(classifyHeartbeat(hb, undefined as never, now), "healthy");
	});
});

describe("DEFAULT_GRADIENT_THRESHOLDS", () => {
	it("has expected values", () => {
		assert.strictEqual(DEFAULT_GRADIENT_THRESHOLDS.warnMs, 30_000);
		assert.strictEqual(DEFAULT_GRADIENT_THRESHOLDS.staleMs, 60_000);
		assert.strictEqual(DEFAULT_GRADIENT_THRESHOLDS.deadMs, 300_000);
	});

	it("thresholds are ordered warnMs < staleMs < deadMs", () => {
		assert.ok(DEFAULT_GRADIENT_THRESHOLDS.warnMs < DEFAULT_GRADIENT_THRESHOLDS.staleMs);
		assert.ok(DEFAULT_GRADIENT_THRESHOLDS.staleMs < DEFAULT_GRADIENT_THRESHOLDS.deadMs);
	});
});
