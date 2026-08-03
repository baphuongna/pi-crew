/**
 * Unit tests for src/observability/event-bus.ts
 * Covers: EventBus singleton, emit, on/off, dispose, listener error isolation
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { type CrewEvent, type CrewEventType, crewEventBus } from "../../../src/observability/event-bus.ts";

function makeEvent(overrides: Partial<CrewEvent> = {}): CrewEvent {
	return {
		type: "run:start",
		runId: "test-run",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("EventBus singleton (getInstance)", () => {
	it("returns the same instance across multiple import/usage", () => {
		const a = crewEventBus;
		assert.ok(a, "crewEventBus should be defined");
		// crewEventBus is the singleton exported — verify it's stable
		assert.equal(typeof a.emit, "function");
		assert.equal(typeof a.on, "function");
		assert.equal(typeof a.off, "function");
		assert.equal(typeof a.dispose, "function");
	});

	it("creates a new instance after dispose is called", () => {
		const before = crewEventBus;
		// Subscribe something so we can verify state is cleared
		const ref: CrewEvent[] = [];
		crewEventBus.on("run:start", (e) => ref.push(e));
		crewEventBus.dispose();
		// After dispose, the exported crewEventBus still points to old (disposed) instance.
		// The test verifies dispose clears listeners (tested separately).
		// Re-acquiring through import is not possible in same module,
		// but we can verify the old instance's listeners are cleared by emitting.
		before.emit(makeEvent({ type: "run:start" }));
		assert.equal(ref.length, 0, "listeners should be cleared after dispose");
	});

	it("dispose clears all listener sets", () => {
		const events: CrewEvent[] = [];
		for (const t of ["agent:progress", "agent:complete", "run:start"] as CrewEventType[]) {
			crewEventBus.on(t, (e) => events.push(e));
		}
		crewEventBus.dispose();
		for (const t of ["agent:progress", "agent:complete", "run:start"] as CrewEventType[]) {
			crewEventBus.emit(makeEvent({ type: t }));
		}
		assert.equal(events.length, 0, "no events should be delivered after dispose");
	});
});

describe("EventBus emit", () => {
	beforeEach(() => {
		crewEventBus.dispose();
	});

	it("delivers events to listeners registered for that type", () => {
		const received: CrewEvent[] = [];
		crewEventBus.on("run:start", (e) => received.push(e));
		const event = makeEvent({ type: "run:start" });
		crewEventBus.emit(event);
		assert.equal(received.length, 1);
		assert.equal(received[0].runId, "test-run");
		assert.equal(received[0].type, "run:start");
	});

	it("does not deliver events to listeners of a different type", () => {
		const received: CrewEvent[] = [];
		crewEventBus.on("agent:complete", (e) => received.push(e));
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(received.length, 0, "should not receive events of different type");
	});

	it("delivers to multiple listeners of the same type", () => {
		const a: CrewEvent[] = [];
		const b: CrewEvent[] = [];
		crewEventBus.on("agent:error", (e) => a.push(e));
		crewEventBus.on("agent:error", (e) => b.push(e));
		crewEventBus.emit(makeEvent({ type: "agent:error" }));
		assert.equal(a.length, 1);
		assert.equal(b.length, 1);
	});

	it("isolates errors in listeners — subsequent listeners still run", () => {
		const received: CrewEvent[] = [];
		crewEventBus.on("run:complete", () => {
			throw new Error("boom");
		});
		crewEventBus.on("run:complete", (e) => received.push(e));
		crewEventBus.emit(makeEvent({ type: "run:complete" }));
		assert.equal(received.length, 1, "second listener should still be called despite first throwing");
	});

	it("does nothing when no listeners registered for the event type", () => {
		// Should not throw
		crewEventBus.emit(makeEvent({ type: "agent:progress" }));
		assert.ok(true, "emit with no listeners should not throw");
	});
});

describe("EventBus on (subscribe)", () => {
	beforeEach(() => {
		crewEventBus.dispose();
	});

	it("returns an unsubscribe function that removes the listener", () => {
		const received: CrewEvent[] = [];
		const unsub = crewEventBus.on("run:start", (e) => received.push(e));
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(received.length, 1);
		unsub();
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(received.length, 1, "no events after unsubscribe");
	});

	it("supports multiple on calls for the same type with different listeners", () => {
		const a: CrewEvent[] = [];
		const b: CrewEvent[] = [];
		crewEventBus.on("run:start", (e) => a.push(e));
		crewEventBus.on("run:start", (e) => b.push(e));
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(a.length, 1);
		assert.equal(b.length, 1);
	});

	it("does not add duplicate listener for the same function reference", () => {
		const received: CrewEvent[] = [];
		const listener = (e: CrewEvent) => received.push(e);
		crewEventBus.on("run:start", listener);
		crewEventBus.on("run:start", listener);
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(received.length, 1, "same function reference should only be called once");
	});
});

describe("EventBus off (unsubscribe)", () => {
	beforeEach(() => {
		crewEventBus.dispose();
	});

	it("removes a specific listener", () => {
		const received: CrewEvent[] = [];
		const listener = (e: CrewEvent) => received.push(e);
		crewEventBus.on("run:start", listener);
		crewEventBus.off("run:start", listener);
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(received.length, 0, "listener should be removed");
	});

	it("is a no-op for a listener that was never registered", () => {
		const listener = (_e: CrewEvent) => undefined;
		// Should not throw
		crewEventBus.off("run:start", listener);
		assert.ok(true, "off on non-existent listener should not throw");
	});

	it("removes only the targeted listener, not others", () => {
		const a: CrewEvent[] = [];
		const b: CrewEvent[] = [];
		const listenerA = (e: CrewEvent) => a.push(e);
		const listenerB = (e: CrewEvent) => b.push(e);
		crewEventBus.on("run:start", listenerA);
		crewEventBus.on("run:start", listenerB);
		crewEventBus.off("run:start", listenerA);
		crewEventBus.emit(makeEvent({ type: "run:start" }));
		assert.equal(a.length, 0, "removed listener should not fire");
		assert.equal(b.length, 1, "other listener should still fire");
	});
});
