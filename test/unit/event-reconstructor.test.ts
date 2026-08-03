import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamEvent } from "../../src/state/event-log/event-log.ts";
import { reconstructTasksFromEvents, reconstructTasksFromLines } from "../../src/state/event-log/event-reconstructor.ts";

/** Helper to create a minimal TeamEvent with required fields. */
function makeEvent(overrides: Partial<TeamEvent> & Pick<TeamEvent, "type" | "runId">): TeamEvent {
	return {
		time: overrides.time ?? new Date().toISOString(),
		type: overrides.type,
		runId: overrides.runId,
		taskId: overrides.taskId,
		message: overrides.message,
		data: overrides.data,
	};
}

describe("reconstructTasksFromEvents", () => {
	describe("empty input", () => {
		it("returns empty task map for empty event array", () => {
			const result = reconstructTasksFromEvents([]);
			assert.equal(result.tasks.size, 0);
			assert.equal(result.eventCount, 0);
			assert.equal(result.corruptedCount, 0);
		});
	});

	describe("single task.created event", () => {
		it("creates a task with status 'created'", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
				}),
			];
			const result = reconstructTasksFromEvents(events);
			assert.equal(result.tasks.size, 1);
			assert.equal(result.eventCount, 1);
			assert.equal(result.corruptedCount, 0);

			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.id, "task-1");
			assert.equal(task.status, "created");
		});
	});

	describe("full lifecycle: created → started → completed", () => {
		it("reconstructs a completed task with correct timing", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
					time: "2026-01-01T00:00:00.000Z",
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
					time: "2026-01-01T00:00:01.000Z",
				}),
				makeEvent({
					type: "task.completed",
					runId: "run-1",
					taskId: "task-1",
					time: "2026-01-01T00:00:10.000Z",
				}),
			];
			const result = reconstructTasksFromEvents(events);
			assert.equal(result.tasks.size, 1);

			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "completed");
			assert.equal(task.startedAt, "2026-01-01T00:00:01.000Z");
			assert.equal(task.finishedAt, "2026-01-01T00:00:10.000Z");
		});
	});

	describe("multiple tasks", () => {
		it("reconstructs all tasks independently", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-2",
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-2",
				}),
				makeEvent({
					type: "task.completed",
					runId: "run-1",
					taskId: "task-1",
				}),
			];
			const result = reconstructTasksFromEvents(events);
			assert.equal(result.tasks.size, 2);

			const task1 = result.tasks.get("task-1");
			assert.ok(task1);
			assert.equal(task1.status, "completed");

			const task2 = result.tasks.get("task-2");
			assert.ok(task2);
			assert.equal(task2.status, "running");
		});
	});

	describe("failed task with error message", () => {
		it("captures error message from task.failed event", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.failed",
					runId: "run-1",
					taskId: "task-1",
					message: "build error: missing dependency",
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "failed");
			assert.equal(task.error, "build error: missing dependency");
			assert.ok(task.finishedAt);
		});
	});

	describe("events with diagnostics data", () => {
		it("preserves diagnostics from event data", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
					data: {
						diagnostics: {
							toolCalls: 5,
							filesEdited: 3,
							phase: "implementation",
						},
					},
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.deepEqual(task.diagnostics, {
				toolCalls: 5,
				filesEdited: 3,
				phase: "implementation",
			});
		});

		it("ignores non-object diagnostics", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
					data: { diagnostics: "not an object" },
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.diagnostics, undefined);
		});
	});

	describe("events with metrics data", () => {
		it("preserves numeric metrics from event data", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.completed",
					runId: "run-1",
					taskId: "task-1",
					data: {
						metrics: {
							linesAdded: 150,
							linesRemoved: 30,
							filesChanged: 5,
						},
					},
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.deepEqual(task.metrics, {
				linesAdded: 150,
				linesRemoved: 30,
				filesChanged: 5,
			});
		});

		it("filters non-numeric metric values", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.completed",
					runId: "run-1",
					taskId: "task-1",
					data: {
						metrics: {
							validMetric: 42,
							invalidMetric: "string",
							nanMetric: NaN,
						},
					},
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.deepEqual(task.metrics, { validMetric: 42 });
		});
	});

	describe("segment tracking", () => {
		it("preserves segment number from event data", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 1 },
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.segment, 1);
		});

		it("tracks segment through retry lifecycle", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 0 },
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 0 },
				}),
				makeEvent({
					type: "task.failed",
					runId: "run-1",
					taskId: "task-1",
					message: "first attempt failed",
				}),
				makeEvent({
					type: "task.retried",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 1 },
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 1 },
				}),
				makeEvent({
					type: "task.completed",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 1 },
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "completed");
			assert.equal(task.segment, 1);
		});
	});

	describe("later events override earlier state", () => {
		it("applies events in sequence with last-wins semantics", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
					data: { segment: 0 },
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
					data: { metrics: { attempts: 1 } },
				}),
				makeEvent({
					type: "task.completed",
					runId: "run-1",
					taskId: "task-1",
					data: { metrics: { attempts: 1, success: 1 } },
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "completed");
			assert.deepEqual(task.metrics, { attempts: 1, success: 1 });
			assert.equal(task.segment, 0);
		});
	});

	describe("non-task events are ignored", () => {
		it("skips events without taskId", () => {
			const events: TeamEvent[] = [
				makeEvent({ type: "run.created", runId: "run-1" }),
				makeEvent({ type: "run.running", runId: "run-1" }),
			];
			const result = reconstructTasksFromEvents(events);
			assert.equal(result.tasks.size, 0);
			assert.equal(result.eventCount, 2);
		});

		it("skips non-lifecycle task events", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.progress",
					runId: "run-1",
					taskId: "task-1",
				}),
			];
			// task.progress is a lifecycle event but doesn't change status — task is created implicitly
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			// Status should remain at the initial "created" since task.progress doesn't map to a status
			assert.equal(task.status, "created");
		});
	});

	describe("cancelled and skipped tasks", () => {
		it("reconstructs cancelled task", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.started",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.cancelled",
					runId: "run-1",
					taskId: "task-1",
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "cancelled");
			assert.ok(task.finishedAt);
		});

		it("reconstructs skipped task", () => {
			const events: TeamEvent[] = [
				makeEvent({
					type: "task.created",
					runId: "run-1",
					taskId: "task-1",
				}),
				makeEvent({
					type: "task.skipped",
					runId: "run-1",
					taskId: "task-1",
				}),
			];
			const result = reconstructTasksFromEvents(events);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "skipped");
			assert.ok(task.finishedAt);
		});
	});
});

describe("reconstructTasksFromLines", () => {
	describe("malformed JSON lines", () => {
		it("skips malformed lines and increments corruptedCount", () => {
			const lines = [
				'{"type":"task.created","runId":"run-1","taskId":"task-1","time":"2026-01-01T00:00:00.000Z"}',
				"not valid json{{{",
				"",
				'{"type":"task.started","runId":"run-1","taskId":"task-1","time":"2026-01-01T00:00:01.000Z"}',
			];
			const result = reconstructTasksFromLines(lines);
			assert.equal(result.tasks.size, 1);
			assert.equal(result.corruptedCount, 1);
			assert.equal(result.eventCount, 3); // empty line not counted

			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "running");
		});

		it("skips lines with missing required fields", () => {
			const lines = [
				'{"type":"task.created","taskId":"task-1"}', // missing runId → corrupted
				'{"type":"task.created","runId":"run-1"}', // missing taskId → parsed but no task reconstructed
			];
			const result = reconstructTasksFromLines(lines);
			assert.equal(result.tasks.size, 0);
			// Only the first line is corrupted (missing runId); the second is valid event but no taskId
			assert.equal(result.corruptedCount, 1);
		});

		it("handles all-corrupted input gracefully", () => {
			const lines = ["garbage", "more garbage", "///"];
			const result = reconstructTasksFromLines(lines);
			assert.equal(result.tasks.size, 0);
			assert.equal(result.corruptedCount, 3);
			assert.equal(result.eventCount, 3);
		});
	});

	describe("valid lines reconstruction", () => {
		it("reconstructs from raw JSONL lines with full lifecycle", () => {
			const lines = [
				'{"type":"task.created","runId":"run-1","taskId":"task-1","time":"2026-01-01T00:00:00.000Z"}',
				'{"type":"task.started","runId":"run-1","taskId":"task-1","time":"2026-01-01T00:00:01.000Z"}',
				'{"type":"task.completed","runId":"run-1","taskId":"task-1","time":"2026-01-01T00:00:10.000Z"}',
			];
			const result = reconstructTasksFromLines(lines);
			const task = result.tasks.get("task-1");
			assert.ok(task);
			assert.equal(task.status, "completed");
			assert.equal(task.startedAt, "2026-01-01T00:00:01.000Z");
			assert.equal(task.finishedAt, "2026-01-01T00:00:10.000Z");
		});
	});
});
