/**
 * Tests for src/runtime/crew-hooks.ts
 * Coverage:
 * - register / unregister lifecycle
 * - emit fires registered hooks
 * - emit with no hooks is a no-op
 * - synchronous hook error does not block other hooks
 * - async hook rejection is caught (not unhandled)
 * - duplicate registration is idempotent
 * - unregister of non-existent hook is a no-op
 */
import test from "node:test";
import assert from "node:assert/strict";
import { crewHooks, type CrewHookEvent, type CrewHookEventType } from "../../src/runtime/crew-hooks.ts";

const makeEvent = (type: CrewHookEventType): CrewHookEvent => ({
	type,
	timestamp: new Date().toISOString(),
	runId: "run-1",
	taskId: "task-1",
});

test("crewHooks.register then emit fires the hook", () => {
	const received: string[] = [];
	const hook = (event: CrewHookEvent): void => { received.push(event.type); };
	crewHooks.register("task_started", hook);
	try {
		crewHooks.emit(makeEvent("task_started"));
		assert.equal(received.length, 1);
		assert.equal(received[0], "task_started");
	} finally {
		crewHooks.unregister("task_started", hook);
	}
});

test("crewHooks.emit with no registered hooks is a no-op", () => {
	// Should not throw
	crewHooks.emit(makeEvent("task_completed"));
});

test("crewHooks synchronous hook error does not block other hooks", () => {
	const received: string[] = [];
	const erroringHook = (): void => {
		throw new Error("hook intentionally broken");
	};
	const goodHook = (event: CrewHookEvent): void => { received.push(event.type); };
	crewHooks.register("task_completed", erroringHook);
	crewHooks.register("task_completed", goodHook);
	try {
		// Should not throw, and goodHook should still fire
		crewHooks.emit(makeEvent("task_completed"));
		assert.equal(received.length, 1);
		assert.equal(received[0], "task_completed");
	} finally {
		crewHooks.unregister("task_completed", erroringHook);
		crewHooks.unregister("task_completed", goodHook);
	}
});

test("crewHooks async hook rejection is caught", async () => {
	const asyncHook = async () => {
		throw new Error("async hook intentionally broken");
	};
	crewHooks.register("task_failed", asyncHook);
	try {
		crewHooks.emit(makeEvent("task_failed"));
		// Wait a bit for the async rejection to be caught
		await new Promise((r) => setTimeout(r, 50));
		// If we get here without an unhandled rejection, the test passes.
		assert.ok(true);
	} finally {
		crewHooks.unregister("task_failed", asyncHook);
	}
});

test("crewHooks duplicate registration is idempotent", () => {
	const received: string[] = [];
	const hook = (event: CrewHookEvent): void => { received.push(event.type); };
	crewHooks.register("run_completed", hook);
	crewHooks.register("run_completed", hook);
	try {
		crewHooks.emit(makeEvent("run_completed"));
		// Should fire only once even though registered twice
		assert.equal(received.length, 1);
	} finally {
		crewHooks.unregister("run_completed", hook);
		crewHooks.unregister("run_completed", hook);
	}
});

test("crewHooks unregister of non-existent hook is a no-op", () => {
	// Should not throw
	crewHooks.unregister("run_completed", () => {});
});

test("crewHooks emits to multiple subscribers", () => {
	const received: string[] = [];
	const hookA = (event: CrewHookEvent): void => { received.push(`A:${event.type}`); };
	const hookB = (event: CrewHookEvent): void => { received.push(`B:${event.type}`); };
	crewHooks.register("run_failed", hookA);
	crewHooks.register("run_failed", hookB);
	try {
		crewHooks.emit(makeEvent("run_failed"));
		assert.equal(received.length, 2);
		assert.ok(received.includes("A:run_failed"));
		assert.ok(received.includes("B:run_failed"));
	} finally {
		crewHooks.unregister("run_failed", hookA);
		crewHooks.unregister("run_failed", hookB);
	}
});

test("crewHooks event includes timestamp and ids", () => {
	let captured: CrewHookEvent | undefined;
	const hook = (event: CrewHookEvent): void => {
		captured = event;
	};
	crewHooks.register("task_started", hook);
	try {
		const event = makeEvent("task_started");
		crewHooks.emit(event);
		assert.ok(captured);
		assert.equal(captured?.type, "task_started");
		assert.equal(captured?.runId, "run-1");
		assert.equal(captured?.taskId, "task-1");
		assert.ok(captured?.timestamp);
	} finally {
		crewHooks.unregister("task_started", hook);
	}
});
