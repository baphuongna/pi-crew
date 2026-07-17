import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkerHeartbeat, isWorkerHeartbeatStale, touchWorkerHeartbeat } from "../../src/runtime/worker-heartbeat.ts";

describe("createWorkerHeartbeat", () => {
	it("creates heartbeat with required fields", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		const hb = createWorkerHeartbeat("w1", undefined, now);
		assert.equal(hb.workerId, "w1");
		assert.equal(hb.pid, undefined);
		assert.equal(hb.lastSeenAt, now.toISOString());
		assert.equal(hb.alive, true);
	});

	it("creates heartbeat with pid", () => {
		const hb = createWorkerHeartbeat("w2", 12345);
		assert.equal(hb.pid, 12345);
		assert.ok(hb.lastSeenAt);
	});

	it("defaults to current time when now is omitted", () => {
		const before = new Date();
		const hb = createWorkerHeartbeat("w3");
		const after = new Date();
		const ts = new Date(hb.lastSeenAt).getTime();
		assert.ok(ts >= before.getTime() && ts <= after.getTime());
	});
});

describe("touchWorkerHeartbeat", () => {
	it("updates lastSeenAt", () => {
		const hb = createWorkerHeartbeat("w1", undefined, new Date("2026-01-01T00:00:00Z"));
		const later = new Date("2026-01-01T00:01:00Z");
		const updated = touchWorkerHeartbeat(hb, {}, later);
		assert.equal(updated.lastSeenAt, later.toISOString());
		assert.equal(updated.workerId, "w1");
	});

	it("merges partial updates", () => {
		const hb = createWorkerHeartbeat("w1", 100);
		const updated = touchWorkerHeartbeat(hb, { pid: 200, alive: false });
		assert.equal(updated.pid, 200);
		assert.equal(updated.alive, false);
		assert.equal(updated.workerId, "w1");
	});

	it("does not mutate the original heartbeat", () => {
		const hb = createWorkerHeartbeat("w1", 100);
		const originalTime = hb.lastSeenAt;
		touchWorkerHeartbeat(hb, { pid: 999 });
		assert.equal(hb.pid, 100);
		assert.equal(hb.lastSeenAt, originalTime);
	});

	it("overrides lastStdoutAt and lastEventAt", () => {
		const hb = createWorkerHeartbeat("w1");
		const updated = touchWorkerHeartbeat(hb, {
			lastStdoutAt: "2026-01-01T01:00:00Z",
			lastEventAt: "2026-01-01T01:00:01Z",
			turnCount: 5,
		});
		assert.equal(updated.lastStdoutAt, "2026-01-01T01:00:00Z");
		assert.equal(updated.lastEventAt, "2026-01-01T01:00:01Z");
		assert.equal(updated.turnCount, 5);
	});
});

describe("isWorkerHeartbeatStale", () => {
	it("returns false when heartbeat is fresh", () => {
		const now = new Date("2026-01-01T00:05:00Z");
		const hb = createWorkerHeartbeat("w1", undefined, now);
		assert.equal(isWorkerHeartbeatStale(hb, 60_000, now), false);
	});

	it("returns true when heartbeat exceeds staleMs", () => {
		const created = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-01-01T00:05:00Z"); // 5 min later
		const hb = createWorkerHeartbeat("w1", undefined, created);
		assert.equal(isWorkerHeartbeatStale(hb, 60_000, now), true);
	});

	it("returns false at exact boundary", () => {
		const created = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-01-01T00:01:00Z"); // exactly 60s
		const hb = createWorkerHeartbeat("w1", undefined, created);
		assert.equal(isWorkerHeartbeatStale(hb, 60_000, now), false);
	});

	it("works with default now parameter", () => {
		const hb = createWorkerHeartbeat("w1");
		// Just created, should be fresh with a 1-hour stale window
		assert.equal(isWorkerHeartbeatStale(hb, 3600_000), false);
	});
});
