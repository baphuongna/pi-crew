import assert from "node:assert/strict";
import test from "node:test";
import { CrewScheduler, type ScheduleChangeEvent, type ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";

/**
 * In-flight guard (2026-09-22, spawn-storm follow-up): the executor dispatches
 * asynchronously and resets lastStatus only on completion, so lastStatus
 * "running" marks the in-flight window. fire() must suppress overlapping
 * dispatches (backpressure) instead of stacking one run per tick — the storm
 * was the extreme case (1ms overflow ticks), but ANY interval shorter than a
 * slow run piles up unbounded without this guard. Forced fires (run-now)
 * bypass it as the explicit escape hatch.
 */

function makeJob(overrides: Partial<ScheduledJob>): ScheduledJob {
	return {
		id: "job-guard",
		name: "guard probe",
		description: "",
		schedule: "100ms",
		scheduleType: "interval",
		intervalMs: 100,
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
		...overrides,
	} as ScheduledJob;
}

test("slow executor + short interval: overlapping fires are skipped, not stacked", async () => {
	const s = new CrewScheduler();
	let dispatches = 0;
	let completions = 0;
	const events: ScheduleChangeEvent[] = [];
	s.start({
		emit: (e) => events.push(e),
		// Emulates the real wiring: dispatch is sync, the run completes
		// asynchronously (150ms) and only then resets lastStatus — every tick
		// inside that window must be suppressed.
		executor: () => {
			dispatches++;
			setTimeout(() => {
				completions++;
				s.update("job-guard", { lastStatus: "success" });
			}, 150);
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	// Measured timeline (interval 100ms, run 150ms, window 540ms):
	//   t=100 fire1 | t=200 SKIP | t=250 done1 → re-arm | t=350 fire2
	//   t=450 SKIP | t=500 done2 | fire3 would land at t=600 (past window).
	//   Unguarded ticks = 5 fires (100..500) — guarded: 2 dispatches.
	s.add(makeJob({}));
	await new Promise((r) => setTimeout(r, 540));
	s.stop();
	assert.equal(dispatches, 2, `guarded scheduler must dispatch per completion, not per tick, got ${dispatches} dispatches`);
	assert.equal(completions, 2, `both dispatched runs should complete, got ${completions}`);
	const skips = events.filter((e) => e.type === "skipped");
	assert.ok(skips.length >= 2, `overlapping ticks must emit skipped events, got ${JSON.stringify(skips)}`);
	assert.ok(skips.every((e) => e.reason.includes("in flight")));
});

test("hung executor (never completes): exactly one dispatch, all later ticks skipped", async () => {
	const s = new CrewScheduler();
	let dispatches = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			dispatches++;
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	s.add(makeJob({}));
	await new Promise((r) => setTimeout(r, 250));
	s.stop();
	assert.equal(dispatches, 1, `hung run must not stack dispatches, got ${dispatches}`);
});

test("forced fire (run-now) bypasses the in-flight guard", async () => {
	const s = new CrewScheduler();
	let dispatches = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			dispatches++;
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	// Seed a hung in-flight window the way fire() does.
	s.add(makeJob({ lastStatus: "running" }));
	// force=true is the run-now path.
	(s as unknown as { fire: (id: string, force?: boolean) => void }).fire("job-guard", true);
	assert.equal(dispatches, 1, "forced fire must dispatch despite running status");
	// Non-forced fire during the same window is suppressed.
	(s as unknown as { fire: (id: string, force?: boolean) => void }).fire("job-guard", false);
	assert.equal(dispatches, 1, "non-forced fire must be suppressed during the in-flight window");
	s.stop();
});
