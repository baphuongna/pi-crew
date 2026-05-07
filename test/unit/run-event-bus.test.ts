import test from "node:test";
import assert from "node:assert/strict";
import { runEventBus, teamEventToRunEventType, emitFromTeamEvent } from "../../src/ui/run-event-bus.ts";
import type { TeamEvent } from "../../src/state/event-log.ts";

test("runEventBus on/off delivers events to subscribed listeners", () => {
	const received: string[] = [];
	const unsub = runEventBus.on("test-run-1", (event) => received.push(event.type));
	runEventBus.emit({ type: "task_started", runId: "test-run-1" });
	assert.equal(received.length, 1);
	assert.equal(received[0], "task_started");
	unsub();
	runEventBus.emit({ type: "task_completed", runId: "test-run-1" });
	assert.equal(received.length, 1);
});

test("runEventBus onAny receives events from all runs", () => {
	const received: string[] = [];
	const unsub = runEventBus.onAny((event) => received.push(event.runId));
	runEventBus.emit({ type: "task_started", runId: "run-a" });
	runEventBus.emit({ type: "task_completed", runId: "run-b" });
	assert.equal(received.length, 2);
	assert.equal(received[0], "run-a");
	assert.equal(received[1], "run-b");
	unsub();
});

test("runEventBus listenerCount tracks subscriptions", () => {
	const unsub1 = runEventBus.on("test-run-2", () => {});
	const unsub2 = runEventBus.on("test-run-2", () => {});
	assert.equal(runEventBus.listenerCount("test-run-2"), 2);
	assert.equal(runEventBus.listenerCount("nonexistent"), 0);
	unsub1();
	assert.equal(runEventBus.listenerCount("test-run-2"), 1);
	unsub2();
	assert.equal(runEventBus.listenerCount("test-run-2"), 0);
});

test("teamEventToRunEventType maps known event types", () => {
	assert.equal(teamEventToRunEventType({ type: "task.started", runId: "r1" } as TeamEvent), "task_started");
	assert.equal(teamEventToRunEventType({ type: "task.completed", runId: "r1" } as TeamEvent), "task_completed");
	assert.equal(teamEventToRunEventType({ type: "run.running", runId: "r1" } as TeamEvent), "run_started");
	assert.equal(teamEventToRunEventType({ type: "run.completed", runId: "r1" } as TeamEvent), "run_completed");
	assert.equal(teamEventToRunEventType({ type: "run.blocked", runId: "r1" } as TeamEvent), "run_blocked");
	assert.equal(teamEventToRunEventType({ type: "run.cancelled", runId: "r1" } as TeamEvent), "run_cancelled");
	assert.equal(teamEventToRunEventType({ type: "unknown.event", runId: "r1" } as TeamEvent), undefined);
});