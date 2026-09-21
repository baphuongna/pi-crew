import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkerEventsChannel } from "../../../src/prompt/worker-events-channel.ts";

const ENV = {
	PI_CREW_EVENTS_PATH: "set-later",
	PI_CREW_BROKER_RUN_ID: "run-1",
	PI_CREW_TASK_ID: "task-9",
};

function isIsoString(value: unknown): boolean {
	return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.endsWith("Z");
}

/**
 * Regression (found live 2026-09-21, run team_20260921100246_f2ee9ba752e1b2ad):
 * the channel's DEFAULT appender is a raw O_APPEND writer, NOT event-log.ts's
 * appendEvent — so the channel must stamp `time` itself. Every
 * worker.started/completed of a tmux-surface run was written time-less, and
 * exporting that run produced a bundle the importer rejects wholesale
 * ("events[i].time must be a string" — run-bundle-schema.ts validateEvent).
 */
test("default appender path: emitted events land on disk with an ISO-string `time`", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "wec-time-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const channel = createWorkerEventsChannel({
			env: { ...ENV, PI_CREW_EVENTS_PATH: eventsPath },
			now: () => 1_700_000_000_000,
		});
		assert.equal(channel.emitTerminal("worker.started", { pid: 123 }), true);
		assert.equal(channel.emit("worker.progress", { note: "ok" }), true);
		const lines = readFileSync(eventsPath, "utf-8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.equal(lines.length, 2);
		for (const event of lines) {
			assert.ok(isIsoString(event.time), `event ${event.type} must carry an ISO-string time, got ${String(event.time)}`);
			assert.equal(typeof event.type, "string");
			assert.equal(typeof event.runId, "string");
		}
		// The stamp uses the injected clock (deterministic, not wall time).
		assert.equal(lines[0]?.time, new Date(1_700_000_000_000).toISOString());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("injected appender path: emit() and emitTerminal() both receive events with an ISO-string `time`", () => {
	const written: Record<string, unknown>[] = [];
	const channel = createWorkerEventsChannel({
		env: { ...ENV, PI_CREW_EVENTS_PATH: "/unused" },
		appendEvent: (_p, event) => written.push(event as Record<string, unknown>),
		now: () => 42_000,
	});
	assert.equal(channel.emit("worker.a", {}), true);
	assert.equal(channel.emitTerminal("worker.completed", { result: "done" }), true);
	assert.equal(written.length, 2);
	for (const event of written) {
		assert.ok(isIsoString(event.time), `event ${event.type} must carry an ISO-string time`);
	}
	assert.equal(written[0]?.time, new Date(42_000).toISOString());
	// Retry-after-failure path (queued item flushed later) is stamped too.
	const late: Record<string, unknown>[] = [];
	let failing = true;
	const flaky = createWorkerEventsChannel({
		env: { ...ENV, PI_CREW_EVENTS_PATH: "/unused" },
		appendEvent: (_p, event) => {
			if (failing) throw new Error("EBUSY");
			late.push(event as Record<string, unknown>);
		},
		now: () => 1_000,
	});
	assert.equal(flaky.emit("worker.queued", {}), true);
	failing = false;
	flaky.flush();
	assert.equal(late.length, 1);
	assert.ok(isIsoString(late[0]?.time), "flushed (previously queued) event must carry time");
});

test("import contract: channel-emitted events satisfy run-bundle validateEvent's string requirements", () => {
	const written: Record<string, unknown>[] = [];
	const channel = createWorkerEventsChannel({
		env: { ...ENV, PI_CREW_EVENTS_PATH: "/unused" },
		appendEvent: (_p, event) => written.push(event as Record<string, unknown>),
	});
	channel.emitTerminal("worker.started", { pid: 1 });
	channel.emitTerminal("worker.completed", { result: "x" });
	// Mirrors run-bundle-schema.ts validateEvent: time/type/runId must be strings.
	for (const event of written) {
		for (const field of ["time", "type", "runId"] as const) {
			assert.equal(typeof event[field], "string", `${field} must be a string for ${String(event.type)}`);
		}
	}
});
