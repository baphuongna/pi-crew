/**
 * Real-firing tests for the cron branch of CrewScheduler.arm()/disarm().
 *
 * Uses an injectable clock (constructor option `now`) + node:test mock timers
 * (t.mock.timers for setTimeout) — NEVER real 60s sleeps (cron granularity is
 * 1 minute). Red-green provenance: this suite is RED on a7b2d27a (cron jobs
 * were stored but never armed — arm() only handled `interval` and `once`).
 *
 * @see src/runtime/scheduling/scheduler.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CrewScheduler, type ScheduleChangeEvent, type ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";

const T0 = new Date("2026-05-10T10:00:00.000Z"); // a Sunday, 10:00 UTC

function makeCronJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "cron-job",
		name: "cron-test",
		description: "",
		schedule: "*/5 * * * *",
		scheduleType: "cron",
		intervalMs: undefined,
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: T0.toISOString(),
		nextRun: undefined,
		runCount: 0,
		...overrides,
	};
}

interface Harness {
	scheduler: CrewScheduler;
	events: ScheduleChangeEvent[];
	fired: () => number;
	/** Advance the injected clock and the mock timer queue in lockstep. */
	advance: (ms: number) => void;
	job: (id?: string) => ScheduledJob | undefined;
}

function startHarness(t: test.TestContext, job: ScheduledJob, startMs = T0.getTime()): Harness {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let nowMs = startMs;
	let firedCount = 0;
	const events: ScheduleChangeEvent[] = [];
	const scheduler = new CrewScheduler({ now: () => new Date(nowMs) });
	scheduler.start({
		emit: (event) => events.push(event),
		executor: () => {
			firedCount++;
			return "agent-cron";
		},
		finalizer: () => undefined,
	});
	scheduler.add(job);
	return {
		scheduler,
		events,
		fired: () => firedCount,
		advance: (ms) => {
			nowMs += ms;
			t.mock.timers.tick(ms);
		},
		job: (id = job.id) => scheduler.list().find((j) => j.id === id),
	};
}

test("cron job fires at its first nextRunTime occurrence", (t) => {
	const h = startHarness(t, makeCronJob()); // */5 → first occurrence 10:05:00Z

	// Before the occurrence: nothing fires, job stays armed and enabled.
	h.advance(4 * 60_000); // → 10:04
	assert.equal(h.fired(), 0, "must not fire before the first occurrence");
	assert.equal(h.job()?.enabled, true);

	// At the occurrence: exactly one fire.
	h.advance(60_000); // → 10:05
	assert.equal(h.fired(), 1, "cron must fire at the first occurrence");
	assert.equal(h.job()?.lastStatus, "running");
	assert.deepEqual(
		h.events.filter((e) => e.type === "fired"),
		[{ type: "fired", jobId: "cron-job", agentId: "agent-cron", name: "cron-test" }],
	);

	// One minute past the occurrence: still exactly one fire (no double arm).
	h.advance(60_000); // → 10:06
	assert.equal(h.fired(), 1, "an occurrence must fire exactly once — no double-armed timers");
	t.mock.timers.reset();
});

test("after each fire the timer re-arms and job.nextRun advances to the next occurrence", (t) => {
	const h = startHarness(t, makeCronJob()); // */5 → 10:05, 10:10, 10:15…

	h.advance(5 * 60_000); // → 10:05: first fire
	assert.equal(h.fired(), 1);
	assert.equal(h.job()?.nextRun, "2026-05-10T10:10:00.000Z", "nextRun must advance to the next occurrence after firing");
	// Emulate the async run completion (real wiring resets lastStatus in the
	// executor's setImmediate block). The in-flight guard suppresses overlaps,
	// so without this reset the next occurrence would be skipped.
	h.scheduler.update("cron-job", { lastStatus: "success" });

	h.advance(5 * 60_000); // → 10:10: re-armed timer fires the second occurrence
	assert.equal(h.fired(), 2, "re-arm after fire must fire the next occurrence");
	assert.equal(h.job()?.nextRun, "2026-05-10T10:15:00.000Z");
	h.scheduler.update("cron-job", { lastStatus: "success" });

	h.advance(5 * 60_000); // → 10:15: third occurrence, still exactly once each
	assert.equal(h.fired(), 3);
	assert.equal(h.job()?.nextRun, "2026-05-10T10:20:00.000Z");
	t.mock.timers.reset();
});

test("disabling a cron job mid-flight stops all future fires", (t) => {
	const h = startHarness(t, makeCronJob()); // armed for 10:05

	h.advance(3 * 60_000); // → 10:03: still before first occurrence
	h.scheduler.update("cron-job", { enabled: false });

	h.advance(30 * 60_000); // → way past 10:05, 10:10, 10:15…
	assert.equal(h.fired(), 0, "a disabled cron job must never fire via timer");
	assert.equal(h.job()?.enabled, false);

	// Re-enabling arms the NEXT occurrence from the current time (10:33 → 10:35).
	h.scheduler.update("cron-job", { enabled: true });
	h.advance(60_000); // → 10:34
	assert.equal(h.fired(), 0, "re-enable must not fire a past occurrence");
	h.advance(60_000); // → 10:35
	assert.equal(h.fired(), 1, "re-enabled cron fires at the next occurrence only");
	t.mock.timers.reset();
});

test("yearly cron ('0 0 2 2 *') chains short timeouts and does NOT mis-fire on setTimeout 2^31-1ms overflow", (t) => {
	// Target: 2027-02-02T00:00Z — 23,119,200,000 ms away, ~10.8× the 2^31-1 ms
	// setTimeout ceiling. Node clamps delays > 2^31-1 to fire ~immediately, so a
	// naive arm would mis-fire instantly; the fix must chain shorter hops.
	const target = new Date("2027-02-02T00:00:00.000Z").getTime();
	const h = startHarness(t, makeCronJob({ schedule: "0 0 2 2 *", name: "yearly" }));

	// Each hop below crosses the 24.86-day timer ceiling, forcing re-chains.
	h.advance(30 * 86_400_000); // +30d → 2026-06-09
	assert.equal(h.fired(), 0, "must not fire on an overflowed/clamped timeout");
	h.advance(150 * 86_400_000); // +150d → 2026-11-06
	assert.equal(h.fired(), 0);
	h.advance(80 * 86_400_000); // +80d → 2027-01-25
	assert.equal(h.fired(), 0);

	// Land exactly ON the occurrence: fires exactly once.
	const now = new Date("2027-01-25T10:00:00.000Z").getTime();
	h.advance(target - now);
	assert.equal(h.fired(), 1, "fires exactly once at the yearly occurrence");
	assert.equal(h.job()?.nextRun, "2028-02-02T00:00:00.000Z", "nextRun advances to next year");

	// One minute past: no second fire for the same occurrence.
	h.advance(60_000);
	assert.equal(h.fired(), 1);
	t.mock.timers.reset();
});

test("disarm clears pending cron timers cleanly (disable and remove paths)", (t) => {
	const h = startHarness(t, makeCronJob({ id: "gone", schedule: "*/10 * * * *" }));

	// remove() must disarm: no fire, no crash afterwards.
	h.scheduler.remove("gone");
	h.advance(3 * 60 * 60_000);
	assert.equal(h.fired(), 0, "removed job's timer must be cleared");
	assert.equal(h.job("gone"), undefined);

	// disable() must disarm: a second job disabled before its first occurrence.
	h.scheduler.add(makeCronJob({ id: "paused", schedule: "*/10 * * * *" }));
	h.scheduler.update("paused", { enabled: false });
	h.advance(3 * 60 * 60_000);
	assert.equal(h.fired(), 0, "disabled job's pending cron timer must be cleared");
	h.scheduler.stop();
	t.mock.timers.reset();
});

test("uncomputable next occurrence (Feb-29 beyond the 366-day search window) disables the job with lastStatus recorded", (t) => {
	// From 2026-05-10 the next Feb-29 is 2028-02-29 (~660 days out) — outside
	// nextCronDate's 366-day window → error → job disabled + lastStatus error.
	const h = startHarness(t, makeCronJob({ schedule: "0 0 29 2 *", name: "leap-day" }));

	const job = h.job();
	assert.equal(job?.enabled, false, "job must self-disable when no next occurrence is computable");
	assert.equal(job?.lastStatus, "error", "lastStatus must record the failure");

	const errorEvents = h.events.filter((e) => e.type === "error");
	assert.equal(errorEvents.length, 1, "one error event is emitted");
	assert.match((errorEvents[0] as { error: string }).error, /cron/i, "error message must name the cron failure");

	// And it never fires no matter how far time advances.
	h.advance(400 * 86_400_000);
	assert.equal(h.fired(), 0);
	t.mock.timers.reset();
});
