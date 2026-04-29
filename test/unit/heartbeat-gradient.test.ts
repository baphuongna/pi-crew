import test from "node:test";
import assert from "node:assert/strict";
import { classifyHeartbeat, heartbeatAgeMs } from "../../src/runtime/heartbeat-gradient.ts";

const now = Date.parse("2026-01-01T00:10:00.000Z");
const hb = (ageMs: number) => ({ workerId: "w", lastSeenAt: new Date(now - ageMs).toISOString(), alive: true });

test("classifyHeartbeat returns healthy/warn/stale/dead levels", () => {
	assert.equal(classifyHeartbeat(hb(1000), undefined, now), "healthy");
	assert.equal(classifyHeartbeat(hb(30_001), undefined, now), "warn");
	assert.equal(classifyHeartbeat(hb(60_001), undefined, now), "stale");
	assert.equal(classifyHeartbeat(hb(300_001), undefined, now), "dead");
});

test("classifyHeartbeat treats missing, invalid, and explicit dead as dead", () => {
	assert.equal(classifyHeartbeat(undefined, undefined, now), "dead");
	assert.equal(classifyHeartbeat({ workerId: "w", lastSeenAt: "bad", alive: true }, undefined, now), "dead");
	assert.equal(classifyHeartbeat({ workerId: "w", lastSeenAt: new Date(now).toISOString(), alive: false }, undefined, now), "dead");
});

test("heartbeatAgeMs computes finite age", () => {
	assert.equal(heartbeatAgeMs(hb(1234), now), 1234);
});
