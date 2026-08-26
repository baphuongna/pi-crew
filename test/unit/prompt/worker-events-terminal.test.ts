/**
 * worker-events-terminal.test.ts — emitTerminal bypasses rate-limit
 * (spec §5.3, task S2-T6).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createWorkerEventsChannel } from "../../../src/prompt/worker-events-channel.ts";

describe("worker-events-channel emitTerminal", () => {
	describe("bypasses rate-limit", () => {
		it("channel maxEventsPerWindow:1 → 50 emit = 49 dropped-rate", () => {
			const events: unknown[] = [];
			const channel = createWorkerEventsChannel({
				env: {
					PI_CREW_EVENTS_PATH: "/tmp/test-events.jsonl",
					PI_CREW_BROKER_RUN_ID: "run-123",
					PI_CREW_TASK_ID: "task-1",
				},
				appendEvent: (_path: string, event: Record<string, unknown>) => {
					events.push({ ...event });
				},
				maxEventsPerWindow: 1,
				windowMs: 60_000,
				now: () => 0,
			});

			// Emit 50 regular events → only 1 accepted, 49 dropped-rate
			let accepted = 0;
			for (let i = 0; i < 50; i++) {
				if (channel.emit("worker.test", { idx: i })) accepted++;
			}

			assert.strictEqual(accepted, 1, "emit should accept only 1 event (rate-limited)");
			const stats = channel.stats();
			assert.strictEqual(stats.droppedRate, 49, "emit should drop 49 events due to rate limit");
			assert.strictEqual(stats.accepted, 1, "stats should show 1 accepted");
		});

		it("channel maxEventsPerWindow:1 → 50 emitTerminal = ALL accepted (burst >30 still passes)", () => {
			const events: unknown[] = [];
			const channel = createWorkerEventsChannel({
				env: {
					PI_CREW_EVENTS_PATH: "/tmp/test-events.jsonl",
					PI_CREW_BROKER_RUN_ID: "run-123",
					PI_CREW_TASK_ID: "task-1",
				},
				appendEvent: (_path: string, event: Record<string, unknown>) => {
					events.push({ ...event });
				},
				maxEventsPerWindow: 1,
				windowMs: 60_000,
				now: () => 0,
			});

			// Emit 50 terminal events → ALL accepted (rate-limit bypass)
			let accepted = 0;
			for (let i = 0; i < 50; i++) {
				if ((channel as { emitTerminal: typeof channel.emit }).emitTerminal("worker.terminal", { idx: i })) {
					accepted++;
				}
			}

			assert.strictEqual(accepted, 50, "emitTerminal should accept all 50 events (bypasses rate-limit)");
			const stats = channel.stats();
			assert.strictEqual(stats.droppedRate, 0, "emitTerminal should drop 0 events (no rate-limit)");
			assert.strictEqual(stats.accepted, 50, "stats should show 50 accepted");
		});
	});

	describe("still enforces schema validation", () => {
		it("emitTerminal drops invalid schema types", () => {
			const events: unknown[] = [];
			const channel = createWorkerEventsChannel({
				env: {
					PI_CREW_EVENTS_PATH: "/tmp/test-events.jsonl",
					PI_CREW_BROKER_RUN_ID: "run-123",
					PI_CREW_TASK_ID: "task-1",
				},
				appendEvent: (_path: string, event: Record<string, unknown>) => {
					events.push({ ...event });
				},
				maxEventsPerWindow: 1,
				now: () => 0,
			});

			// Invalid type: not worker.* namespace
			const acceptedInvalid = (channel as { emitTerminal: typeof channel.emit }).emitTerminal("task.invalid", {
				idx: 1,
			});

			assert.strictEqual(acceptedInvalid, false, "emitTerminal should drop non-worker.* events");
			const stats = channel.stats();
			assert.strictEqual(stats.droppedSchema, 1, "stats should show 1 dropped due to schema");
		});

		it("emitTerminal drops malformed type (too long)", () => {
			const events: unknown[] = [];
			const channel = createWorkerEventsChannel({
				env: {
					PI_CREW_EVENTS_PATH: "/tmp/test-events.jsonl",
					PI_CREW_BROKER_RUN_ID: "run-123",
					PI_CREW_TASK_ID: "task-1",
				},
				appendEvent: (_path: string, event: Record<string, unknown>) => {
					events.push({ ...event });
				},
				now: () => 0,
			});

			// Type too long (>64 chars)
			const longType = "worker." + "x".repeat(100);
			const accepted = (channel as { emitTerminal: typeof channel.emit }).emitTerminal(longType, { idx: 1 });

			assert.strictEqual(accepted, false, "emitTerminal should drop types longer than 64 chars");
			const stats = channel.stats();
			assert.strictEqual(stats.droppedSchema, 1, "stats should show 1 dropped due to schema");
		});
	});

	describe("shares FIFO buffer with emit", () => {
		it("pending queue from emit is flushed before emitTerminal writes", () => {
			const events: unknown[] = [];
			let writeCount = 0;
			const channel = createWorkerEventsChannel({
				env: {
					PI_CREW_EVENTS_PATH: "/tmp/test-events.jsonl",
					PI_CREW_BROKER_RUN_ID: "run-123",
					PI_CREW_TASK_ID: "task-1",
				},
				appendEvent: (_path: string, event: Record<string, unknown>) => {
					writeCount++;
					if (writeCount === 1) {
						throw new Error("EBUSY: writer busy");
					}
					events.push({ ...event });
				},
				now: () => 0,
			});

			// First emit fails → queued
			const e1 = channel.emit("worker.test1", { idx: 1 });
			assert.strictEqual(e1, true, "emit should accept (queued)");

			// emitTerminal flushes pending before writing
			const e2 = (channel as { emitTerminal: typeof channel.emit }).emitTerminal("worker.terminal", {
				idx: 2,
			});
			assert.strictEqual(e2, true, "emitTerminal should accept");

			// Verify order: queued emit first, then emitTerminal
			assert.strictEqual(events.length, 2, "should have 2 events after flush succeeds");
			assert.strictEqual((events[0] as { type: string }).type, "worker.test1", "first event should be queued emit");
			assert.strictEqual((events[1] as { type: string }).type, "worker.terminal", "second event should be emitTerminal");
		});
	});
});
