import assert from "node:assert/strict";
import test from "node:test";
import { CrewScheduler, type ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";

/**
 * Regression (2026-09-22 spawn storm, root-caused via .crew/audit/prune.jsonl):
 * arm()'s interval branch used setInterval(fire, intervalMs). Node timers are
 * 32-bit — a LEGAL long interval (90d = 7,776,000,000 ms > 2^31-1) overflows
 * and Node silently sets the delay to 1ms ("TimeoutOverflowWarning … Timeout
 * duration was set to 1"). With no in-flight guard in fire(), one registered
 * 90-day interval job fired every millisecond and dispatched a run per tick:
 * ~104 garbage runs, 50+ node processes, machine thrash — stopped only by
 * job removal + pkill. The once branch had the same overflow via "+30d"
 * (2.59e9 ms > 2^31-1). Both now use armCron's clamped chained-hop treatment.
 */

function makeJob(overrides: Partial<ScheduledJob>): ScheduledJob {
	return {
		id: "job-storm",
		name: "storm probe",
		description: "",
		schedule: "7776000000ms",
		scheduleType: "interval",
		intervalMs: 7_776_000_000,
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
		...overrides,
	} as ScheduledJob;
}

test("interval overflow: a 90-day interval job must NOT fire within a short window (was: every 1ms)", async () => {
	const s = new CrewScheduler();
	let fires = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			fires++;
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	s.add(makeJob({}));
	await new Promise((r) => setTimeout(r, 250));
	assert.equal(fires, 0, `overflow interval fired ${fires}× in 250ms — the 1ms hot loop is back`);
	s.stop();
});

test("normal short intervals still fire", async () => {
	const s = new CrewScheduler();
	let fires = 0;
	// Emulate the real wiring (lifecycle-handlers): dispatch is sync, but the
	// run completes asynchronously and only then resets lastStatus — required
	// since the in-flight guard suppresses fires while lastStatus === "running".
	s.start({
		emit: () => undefined,
		executor: () => {
			fires++;
			setImmediate(() => s.update("job-storm", { lastStatus: "success" }));
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	s.add(makeJob({ schedule: "30ms", intervalMs: 30 }));
	await new Promise((r) => setTimeout(r, 120));
	assert.ok(fires >= 2, `short interval should fire repeatedly, got ${fires}`);
	s.stop();
});

test("once overflow: a '+30d' once job (delay > 2^31-1) must not fire prematurely and self-disables on arrival", async () => {
	const s = new CrewScheduler();
	let fires = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			fires++;
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	const target = new Date(Date.now() + 2_590_000_000).toISOString(); // +30d, overflows 32-bit
	s.add(makeJob({ schedule: target, scheduleType: "once" }));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(fires, 0, "far-future once job fired prematurely — overflow is back");
	const job = s.list().find((j) => j.id === "job-storm");
	assert.equal(job?.enabled, true, "job must stay enabled while awaiting its far-future time");
	s.stop();
});

test("normal near-future once job fires exactly once and self-disables", async () => {
	const s = new CrewScheduler();
	let fires = 0;
	s.start({
		emit: () => undefined,
		executor: () => {
			fires++;
			return "agent-1";
		},
		finalizer: () => undefined,
	});
	const target = new Date(Date.now() + 40).toISOString();
	s.add(makeJob({ schedule: target, scheduleType: "once" }));
	await new Promise((r) => setTimeout(r, 250));
	assert.equal(fires, 1, `once job must fire exactly once, got ${fires}`);
	assert.equal(s.list().find((j) => j.id === "job-storm")?.enabled, false, "once job must self-disable after firing");
	s.stop();
});
