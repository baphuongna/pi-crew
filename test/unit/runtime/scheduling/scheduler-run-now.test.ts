/**
 * Unit tests for CrewScheduler.runNow (dashboard "run now" foundation).
 * @see src/runtime/scheduling/scheduler.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CrewScheduler, type ScheduleChangeEvent, type ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-1",
		name: "nightly",
		description: "",
		schedule: "5m",
		scheduleType: "interval",
		intervalMs: 300_000,
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
		...overrides,
	};
}

test("runNow returns ok:false for an unknown job id", () => {
	const s = new CrewScheduler();
	s.start({ emit: () => undefined, executor: () => "agent-1", finalizer: () => undefined });
	const out = s.runNow("nope");
	assert.equal(out.ok, false);
	if (!out.ok) assert.ok(out.error.includes("nope"));
});

test("runNow returns ok:false when the scheduler has no executor (not started)", () => {
	const s = new CrewScheduler();
	s.add(makeJob());
	const out = s.runNow("job-1");
	assert.equal(out.ok, false);
	if (!out.ok) assert.ok(out.error.includes("not running"));
});

test("runNow reuses the executor callback and emits fired + finalizes", () => {
	const s = new CrewScheduler();
	const events: ScheduleChangeEvent[] = [];
	const executedJobs: ScheduledJob[] = [];
	let finalized: string | undefined;
	s.start({
		emit: (event) => events.push(event),
		executor: (job) => {
			executedJobs.push(job);
			return "agent-now";
		},
		finalizer: (jobId) => {
			finalized = jobId;
		},
	});
	s.add(makeJob({ enabled: true }));

	const out = s.runNow("job-1");

	assert.equal(out.ok, true);
	assert.equal(executedJobs.length, 1, "executor invoked exactly once");
	assert.equal(executedJobs[0]?.id, "job-1");
	assert.deepEqual(
		events.filter((e) => e.type === "fired"),
		[{ type: "fired", jobId: "job-1", agentId: "agent-now", name: "nightly" }],
	);
	assert.equal(finalized, "job-1");
	assert.equal(s.list()[0]?.lastStatus, "running");
});

test("runNow force-fires a DISABLED job (explicit user action bypasses enabled gate)", () => {
	const s = new CrewScheduler();
	let fired = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			fired++;
			return "agent-x";
		},
		finalizer: () => undefined,
	});
	s.add(makeJob({ enabled: false }));

	const out = s.runNow("job-1");
	assert.equal(out.ok, true);
	assert.equal(fired, 1);
});

test("timer-driven fire still respects the enabled gate (no force regression)", async () => {
	const s = new CrewScheduler();
	let fired = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			fired++;
			return "agent-y";
		},
		finalizer: () => undefined,
	});
	// Enabled short-interval job → timer fires; disabled twin → never armed.
	s.add(makeJob({ id: "job-on", enabled: true, intervalMs: 5 }));
	s.add(makeJob({ id: "job-off", enabled: false, intervalMs: 5 }));
	await new Promise((r) => setTimeout(r, 40));
	s.stop();

	const onJob = s.list().find((j) => j.id === "job-on");
	const offJob = s.list().find((j) => j.id === "job-off");
	assert.ok(fired > 0, "enabled job's timer must fire");
	assert.equal(onJob?.lastStatus, "running");
	assert.equal(offJob?.lastStatus, undefined, "disabled job must never fire via timer");
});

// ── review round 1, MAJOR-3: run-now on a once job consumes it ───────────

test("runNow on a scheduled ONCE job fires once and self-disables — no second fire at the scheduled time", async () => {
	const s = new CrewScheduler();
	let fired = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			fired++;
			return "agent-once";
		},
		finalizer: () => undefined,
	});
	// One-shot 30ms in the future — the timer-driven path would fire it there.
	s.add(
		makeJob({
			id: "once-1",
			schedule: new Date(Date.now() + 30).toISOString(),
			scheduleType: "once",
			intervalMs: undefined,
		}),
	);

	const out = s.runNow("once-1");
	assert.equal(out.ok, true);
	assert.equal(fired, 1, "run-now fires immediately");
	assert.equal(s.list()[0]?.enabled, false, "once job is consumed (mirrors the timer path's self-disable)");

	// Wait PAST the scheduled time: the still-armed timer must NOT fire again.
	await new Promise((r) => setTimeout(r, 90));
	s.stop();
	assert.equal(fired, 1, "a one-shot must never execute twice");
});

test("runNow on a once job emits the updated(self-disable) event after the fired event", () => {
	const s = new CrewScheduler();
	const events: ScheduleChangeEvent[] = [];
	s.start({
		emit: (event) => events.push(event),
		executor: () => "agent-once",
		finalizer: () => undefined,
	});
	s.add(
		makeJob({
			id: "once-2",
			schedule: new Date(Date.now() + 60_000).toISOString(),
			scheduleType: "once",
			intervalMs: undefined,
		}),
	);
	events.length = 0; // drop the `added` event

	s.runNow("once-2");

	const types = events.map((e) => e.type);
	assert.equal(types[0], "updated", "fire() marks running first");
	assert.equal(types[1], "fired");
	const disable = events[events.length - 1];
	assert.equal(disable.type, "updated", "run-now closes with the self-disable update");
	if (disable.type === "updated") assert.equal(disable.job.enabled, false);
});
