import assert from "node:assert/strict";
import test from "node:test";
import type { TeamEvent } from "../../src/state/event-log.ts";
import { classifyEventChannel, emitFromTeamEvent, runEventBus, teamEventToRunEventType } from "../../src/ui/run-event-bus.ts";

test("runEventBus on/off delivers events to subscribed listeners", async () => {
	const received: string[] = [];
	const unsub = runEventBus.on("test-run-1", (event) => received.push(event.type));
	runEventBus.emit({ type: "task_started", runId: "test-run-1" });
	await Promise.resolve();
	assert.equal(received.length, 1);
	assert.equal(received[0], "task_started");
	unsub();
	runEventBus.emit({ type: "task_completed", runId: "test-run-1" });
	await Promise.resolve();
	assert.equal(received.length, 1);
});

test("runEventBus onAny receives events from all runs", async () => {
	const received: string[] = [];
	const unsub = runEventBus.onAny((event) => received.push(event.runId));
	runEventBus.emit({ type: "task_started", runId: "run-a" });
	runEventBus.emit({ type: "task_completed", runId: "run-b" });
	await Promise.resolve();
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
	assert.equal(
		teamEventToRunEventType({
			type: "task.started",
			runId: "r1",
		} as TeamEvent),
		"task_started",
	);
	assert.equal(
		teamEventToRunEventType({
			type: "task.completed",
			runId: "r1",
		} as TeamEvent),
		"task_completed",
	);
	assert.equal(
		teamEventToRunEventType({
			type: "run.running",
			runId: "r1",
		} as TeamEvent),
		"run_started",
	);
	assert.equal(
		teamEventToRunEventType({
			type: "run.completed",
			runId: "r1",
		} as TeamEvent),
		"run_completed",
	);
	assert.equal(
		teamEventToRunEventType({
			type: "run.blocked",
			runId: "r1",
		} as TeamEvent),
		"run_blocked",
	);
	assert.equal(
		teamEventToRunEventType({
			type: "run.cancelled",
			runId: "r1",
		} as TeamEvent),
		"run_cancelled",
	);
	assert.equal(
		teamEventToRunEventType({
			type: "unknown.event",
			runId: "r1",
		} as TeamEvent),
		undefined,
	);
});

// --- Typed channel tests ---

test("classifyEventChannel maps tool/progress events to worker:progress", () => {
	assert.equal(classifyEventChannel("tool_execution_start"), "worker:progress");
	assert.equal(classifyEventChannel("tool_result"), "worker:progress");
	assert.equal(classifyEventChannel("agent_progress"), "worker:progress");
	assert.equal(classifyEventChannel("worker_status"), "worker:progress");
});

test("classifyEventChannel maps lifecycle events to worker:lifecycle", () => {
	assert.equal(classifyEventChannel("task_started"), "worker:lifecycle");
	assert.equal(classifyEventChannel("task_completed"), "worker:lifecycle");
	assert.equal(classifyEventChannel("task_failed"), "worker:lifecycle");
	assert.equal(classifyEventChannel("task_cancelled"), "worker:lifecycle");
	assert.equal(classifyEventChannel("run_started"), "worker:lifecycle");
	assert.equal(classifyEventChannel("run_completed"), "worker:lifecycle");
	assert.equal(classifyEventChannel("run_cancelled"), "worker:lifecycle");
	assert.equal(classifyEventChannel("run_blocked"), "worker:lifecycle");
	// dot-notation variants
	assert.equal(classifyEventChannel("task.started"), "worker:lifecycle");
	assert.equal(classifyEventChannel("task.completed"), "worker:lifecycle");
	assert.equal(classifyEventChannel("run.completed"), "worker:lifecycle");
});

test("classifyEventChannel maps stream events to worker:stream", () => {
	assert.equal(classifyEventChannel("stdout_chunk"), "worker:stream");
	assert.equal(classifyEventChannel("stderr_chunk"), "worker:stream");
	assert.equal(classifyEventChannel("stream"), "worker:stream");
});

test("classifyEventChannel maps state events to run:state", () => {
	assert.equal(classifyEventChannel("manifest.saved"), "run:state");
	assert.equal(classifyEventChannel("task.claimed"), "run:state");
	assert.equal(classifyEventChannel("task.unclaimed"), "run:state");
	assert.equal(classifyEventChannel("mailbox_updated"), "run:state");
});

test("classifyEventChannel maps ui events to ui:invalidate", () => {
	assert.equal(classifyEventChannel("effectiveness_changed"), "ui:invalidate");
	assert.equal(classifyEventChannel("snapshot_stale"), "ui:invalidate");
});

test("classifyEventChannel falls back to worker:progress for unknown types", () => {
	assert.equal(classifyEventChannel("something_unknown"), "worker:progress");
});

test("onChannel receives only events for that channel", async () => {
	const lifecycleReceived: string[] = [];
	const streamReceived: string[] = [];
	const unsubLifecycle = runEventBus.onChannel("worker:lifecycle", (e) => lifecycleReceived.push(e.type));
	const unsubStream = runEventBus.onChannel("worker:stream", (e) => streamReceived.push(e.type));

	// Emit lifecycle events
	runEventBus.emit({ type: "task_started", runId: "ch-test-1" });
	runEventBus.emit({ type: "run_completed", runId: "ch-test-1" });

	// Emit a non-lifecycle event (worker_status → worker:progress channel)
	runEventBus.emit({ type: "worker_status", runId: "ch-test-1" });

	await Promise.resolve();

	assert.equal(lifecycleReceived.length, 2);
	assert.equal(lifecycleReceived[0], "task_started");
	assert.equal(lifecycleReceived[1], "run_completed");
	assert.equal(streamReceived.length, 0);

	unsubLifecycle();
	unsubStream();
});

test("onChannelForRun receives filtered by runId + channel", async () => {
	const received: string[] = [];
	const unsub = runEventBus.onChannelForRun("worker:lifecycle", "run-filter-test", (e) => received.push(e.type));

	// Should match: same channel + same runId
	runEventBus.emit({ type: "task_started", runId: "run-filter-test" });
	runEventBus.emit({ type: "run_completed", runId: "run-filter-test" });

	// Should NOT match: different runId
	runEventBus.emit({ type: "task_started", runId: "other-run" });

	// Should NOT match: same runId but different channel
	runEventBus.emit({ type: "worker_status", runId: "run-filter-test" });

	await Promise.resolve();

	assert.equal(received.length, 2);
	assert.equal(received[0], "task_started");
	assert.equal(received[1], "run_completed");

	unsub();
});

test("emit auto-classifies channel when not set", async () => {
	const channels: (string | undefined)[] = [];
	const unsub = runEventBus.onAny((e) => channels.push(e.channel));

	runEventBus.emit({ type: "task_started", runId: "auto-ch" });
	runEventBus.emit({ type: "effectiveness_changed", runId: "auto-ch" });
	runEventBus.emit({ type: "mailbox_updated", runId: "auto-ch" });

	await Promise.resolve();

	assert.equal(channels[0], "worker:lifecycle");
	assert.equal(channels[1], "ui:invalidate");
	assert.equal(channels[2], "run:state");

	unsub();
});

test("dispose clears channel subscriptions too", () => {
	const received: string[] = [];
	runEventBus.onChannel("worker:lifecycle", (e) => received.push(e.type));
	runEventBus.onChannelForRun("worker:lifecycle", "dispose-test", (e) => received.push(e.type));

	runEventBus.dispose();

	// After dispose, no callbacks should fire
	runEventBus.emit({ type: "task_started", runId: "dispose-test" });
	assert.equal(received.length, 0);
});
