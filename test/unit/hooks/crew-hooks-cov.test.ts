import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type CrewHookEvent,
	type CrewHookEventType,
	crewHooks,
	HookRegistry,
	isHookEvent,
	isValidEventType,
} from "../../../src/runtime/crew-hooks.ts";

describe("isValidEventType", () => {
	it("returns true for all valid event types", () => {
		const validTypes: CrewHookEventType[] = ["task_started", "task_completed", "task_failed", "run_completed", "run_failed"];
		for (const t of validTypes) {
			assert.equal(isValidEventType(t), true, `Expected ${t} to be valid`);
		}
	});

	it("returns false for invalid event types", () => {
		assert.equal(isValidEventType("invalid"), false);
		assert.equal(isValidEventType(""), false);
		assert.equal(isValidEventType("task_start"), false);
	});
});

describe("isHookEvent", () => {
	it("returns true for a valid event object", () => {
		const event: CrewHookEvent = {
			type: "task_started",
			timestamp: new Date().toISOString(),
			runId: "run-1",
		};
		assert.equal(isHookEvent(event), true);
	});

	it("returns true with optional taskId and data", () => {
		const event: CrewHookEvent = {
			type: "task_failed",
			timestamp: new Date().toISOString(),
			runId: "run-2",
			taskId: "task-1",
			data: { error: "something" },
		};
		assert.equal(isHookEvent(event), true);
	});

	it("returns false for null", () => {
		assert.equal(isHookEvent(null), false);
	});

	it("returns false for missing required fields", () => {
		assert.equal(isHookEvent({ type: "task_started" }), false);
		assert.equal(isHookEvent({ timestamp: "", runId: "" }), false);
	});

	it("returns false for invalid event type", () => {
		assert.equal(isHookEvent({ type: "bogus", timestamp: "", runId: "r" }), false);
	});

	it("returns false for non-string taskId", () => {
		assert.equal(
			isHookEvent({
				type: "task_started",
				timestamp: "",
				runId: "r",
				taskId: 123,
			}),
			false,
		);
	});
});

describe("HookRegistry", () => {
	it("register and emit invokes the hook", () => {
		const registry = new HookRegistry();
		let received: CrewHookEvent | undefined;
		registry.register("task_started", (e) => {
			received = e;
		});
		const event: CrewHookEvent = {
			type: "task_started",
			timestamp: new Date().toISOString(),
			runId: "run-1",
			taskId: "t1",
		};
		registry.emit(event);
		assert.deepEqual(received, event);
	});

	it("unregister removes the hook", () => {
		const registry = new HookRegistry();
		let called = false;
		const hook = () => {
			called = true;
		};
		registry.register("task_completed", hook);
		registry.unregister("task_completed", hook);
		registry.emit({ type: "task_completed", timestamp: "", runId: "r" });
		assert.equal(called, false);
	});

	it("emit with unknown type does not throw", () => {
		const registry = new HookRegistry();
		assert.doesNotThrow(() => {
			registry.emit({
				type: "task_started" as CrewHookEventType,
				timestamp: "",
				runId: "r",
			});
		});
	});

	it("hooksFor returns registered hooks", () => {
		const registry = new HookRegistry();
		const fn1 = () => undefined;
		const fn2 = () => undefined;
		registry.register("task_failed", fn1);
		registry.register("task_failed", fn2);
		const hooks = registry.hooksFor("task_failed");
		assert.equal(hooks.length, 2);
		assert.ok(hooks.includes(fn1));
		assert.ok(hooks.includes(fn2));
	});

	it("hooksFor returns empty array for no hooks", () => {
		const registry = new HookRegistry();
		assert.deepEqual(registry.hooksFor("run_completed"), []);
	});

	it("count returns correct number", () => {
		const registry = new HookRegistry();
		assert.equal(registry.count("task_started"), 0);
		registry.register("task_started", () => undefined);
		assert.equal(registry.count("task_started"), 1);
	});

	it("clear removes hooks for a specific event type", () => {
		const registry = new HookRegistry();
		registry.register("task_started", () => undefined);
		registry.register("task_failed", () => undefined);
		registry.clear("task_started");
		assert.equal(registry.count("task_started"), 0);
		assert.equal(registry.count("task_failed"), 1);
	});

	it("clearAll removes all hooks", () => {
		const registry = new HookRegistry();
		registry.register("task_started", () => undefined);
		registry.register("task_failed", () => undefined);
		registry.clearAll();
		assert.equal(registry.count("task_started"), 0);
		assert.equal(registry.count("task_failed"), 0);
	});

	it("emit catches synchronous errors from hooks", () => {
		const registry = new HookRegistry();
		let secondCalled = false;
		registry.register("task_failed", () => {
			throw new Error("boom");
		});
		registry.register("task_failed", () => {
			secondCalled = true;
		});
		// Should not throw — errors are caught
		registry.emit({ type: "task_failed", timestamp: "", runId: "r" });
		assert.equal(secondCalled, true, "second hook should still be called after first throws");
	});

	it("registering the same hook twice is a no-op (Set semantics)", () => {
		const registry = new HookRegistry();
		const fn = () => undefined;
		registry.register("task_started", fn);
		registry.register("task_started", fn);
		assert.equal(registry.count("task_started"), 1);
	});
});

describe("crewHooks (global singleton)", () => {
	it("is an instance of HookRegistry", () => {
		assert.ok(crewHooks instanceof HookRegistry);
	});

	it("can register and emit events", () => {
		crewHooks.clearAll();
		let received: CrewHookEvent | undefined;
		crewHooks.register("run_completed", (e) => {
			received = e;
		});
		crewHooks.emit({
			type: "run_completed",
			timestamp: "2026-01-01T00:00:00Z",
			runId: "r1",
		});
		assert.ok(received);
		assert.equal(received!.runId, "r1");
		crewHooks.clearAll();
	});
});
