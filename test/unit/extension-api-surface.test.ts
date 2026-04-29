import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerHeartbeat, type WorkerHeartbeatState } from "../../src/runtime/worker-heartbeat.ts";

test("EventBus on returns unsubscribe and no off method is required", () => {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
	let calls = 0;
	const unsubscribe = events.on("crew.test", () => { calls += 1; });
	assert.equal(typeof unsubscribe, "function");
	events.emit("crew.test", {});
	unsubscribe();
	events.emit("crew.test", {});
	assert.equal(calls, 1);
	assert.equal("off" in events, false);
});

test("WorkerHeartbeatState exposes expected fields", () => {
	const heartbeat: WorkerHeartbeatState = createWorkerHeartbeat("worker-a", 123);
	assert.equal(heartbeat.workerId, "worker-a");
	assert.equal(heartbeat.pid, 123);
	assert.equal(typeof heartbeat.lastSeenAt, "string");
	assert.equal(heartbeat.alive, true);
});
