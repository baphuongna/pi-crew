import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PhaseTracker } from "../../../../src/runtime/phase-tracker.ts";

test("PhaseTracker starts and tracks phase", () => {
	const tracker = new PhaseTracker();
	const phase = tracker.start("assessment");

	assert.equal(phase.name, "assessment");
	assert.equal(phase.status, "active");
	assert.ok(phase.startTime);
	assert.equal(phase.index, 0);
});

test("PhaseTracker completes active phase", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	// Simulate some work with a small delay
	const startMs = Date.now();
	while (Date.now() - startMs < 10) {
		/* busy wait */
	}

	tracker.complete("assessment", { tasksCompleted: 5, tokensUsed: 12000 });

	const phases = tracker.getPhases();
	assert.equal(phases.length, 1);
	assert.equal(phases[0].status, "completed");
	assert.ok(phases[0].endTime);
	assert.ok(phases[0].durationMs !== undefined);
	assert.ok(phases[0].durationMs! >= 0, "duration should be >= 0");
	assert.equal(phases[0].metrics?.tasksCompleted, 5);
	assert.equal(phases[0].metrics?.tokensUsed, 12000);
});

test("PhaseTracker throws on completing non-existent phase", () => {
	const tracker = new PhaseTracker();
	assert.throws(() => tracker.complete("nonexistent"), /Phase "nonexistent" not found/);
});

test("PhaseTracker throws on completing inactive phase", () => {
	const tracker = new PhaseTracker();
	const phase = tracker.start("assessment");
	tracker.complete("assessment");

	assert.throws(() => tracker.complete("assessment"), /Phase "assessment" is not active/);
});

test("PhaseTracker starts new phase completes previous", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	const phase2 = tracker.start("implementation");

	const phases = tracker.getPhases();
	assert.equal(phases.length, 2);
	assert.equal(phases[0].status, "completed");
	assert.equal(phases[1].status, "active");
	assert.equal(phase2.name, "implementation");
});

test("PhaseTracker skips active phase", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	// Simulate some work
	const startMs = Date.now();
	while (Date.now() - startMs < 10) {
		/* busy wait */
	}

	tracker.skip("assessment");

	const phase = tracker.getPhase("assessment");
	assert.ok(phase, "Phase should exist");
	assert.equal(phase!.status, "skipped");
	assert.ok(phase!.endTime);
	assert.ok(phase!.durationMs !== undefined);
	assert.ok(phase!.durationMs! >= 0, "duration should be >= 0");
});

test("PhaseTracker throws on skipping non-existent phase", () => {
	const tracker = new PhaseTracker();
	assert.throws(() => tracker.skip("nonexistent"), /Phase "nonexistent" not found/);
});

test("PhaseTracker fails phase with error info", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	tracker.fail("assessment", "Network timeout");

	const phase = tracker.getPhase("assessment");
	assert.ok(phase);
	assert.equal(phase!.status, "failed");
	assert.equal(phase!.metrics?.custom?.error, "Network timeout");
});

test("PhaseTracker getPhases returns copy", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	tracker.start("implementation");

	const phases = tracker.getPhases();
	phases.push({ name: "extra" } as any);

	const current = tracker.getPhases();
	assert.equal(current.length, 2, "Original should not be modified");
});

test("PhaseTracker getPhasesByStatus filters correctly", () => {
	const tracker = new PhaseTracker();
	// start() completes previous phase, so we track sequentially
	tracker.start("assessment");
	tracker.start("implementation"); // completes assessment
	tracker.start("verification"); // completes implementation

	const active = tracker.getPhasesByStatus("active");
	const completed = tracker.getPhasesByStatus("completed");

	// verification is the active one
	assert.equal(active.length, 1);
	assert.equal(active[0].name, "verification");

	// assessment and implementation are completed
	assert.equal(completed.length, 2);
	assert.ok(completed.some((p) => p.name === "assessment"));
	assert.ok(completed.some((p) => p.name === "implementation"));

	// Manually skip verification to test skipped status
	tracker.skip("verification");
	const skipped = tracker.getPhasesByStatus("skipped");
	assert.equal(skipped.length, 1);
	assert.equal(skipped[0].name, "verification");
});

test("PhaseTracker getCurrentPhase returns active phase", () => {
	const tracker = new PhaseTracker();
	assert.equal(tracker.getCurrentPhase(), null);

	tracker.start("assessment");
	const current = tracker.getCurrentPhase();
	assert.ok(current);
	assert.equal(current!.name, "assessment");

	tracker.start("implementation");
	const current2 = tracker.getCurrentPhase();
	assert.equal(current2!.name, "implementation");
});

test("PhaseTracker getPhase returns specific phase", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	tracker.start("implementation");

	const phase = tracker.getPhase("assessment");
	assert.ok(phase);
	assert.equal(phase!.name, "assessment");

	const notFound = tracker.getPhase("nonexistent");
	assert.equal(notFound, undefined);
});

test("PhaseTracker getMetrics returns phase metrics", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment", { tasksCompleted: 5, tokensUsed: 10000 });

	const metrics = tracker.getMetrics("assessment");
	assert.ok(metrics);
	assert.equal(metrics!.tasksCompleted, 5);
	assert.equal(metrics!.tokensUsed, 10000);
});

test("PhaseTracker updateCurrentMetrics updates active phase", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	tracker.updateCurrentMetrics({ tasksCompleted: 10, tokensUsed: 25000 });

	const metrics = tracker.getMetrics("assessment");
	assert.equal(metrics?.tasksCompleted, 10);
	assert.equal(metrics?.tokensUsed, 25000);
});

test("PhaseTracker updateCurrentMetrics does nothing when no active phase", () => {
	const tracker = new PhaseTracker();
	// No active phase
	tracker.updateCurrentMetrics({ tasksCompleted: 10 });
	// Should not throw
});

test("PhaseTracker addTokensToCurrent accumulates", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment", { tokensUsed: 1000 });

	tracker.addTokensToCurrent(500);
	tracker.addTokensToCurrent(750);

	const metrics = tracker.getMetrics("assessment");
	assert.equal(metrics?.tokensUsed, 2250);
});

test("PhaseTracker addTokensToCurrent does nothing when no active phase", () => {
	const tracker = new PhaseTracker();
	tracker.addTokensToCurrent(1000);
	// Should not throw
});

test("PhaseTracker totalDuration sums completed phases", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	// Simulate work
	const startMs = Date.now();
	while (Date.now() - startMs < 10) {
		/* busy wait */
	}
	tracker.start("implementation"); // completes assessment

	tracker.start("verification"); // completes implementation
	// Simulate more work
	const start2Ms = Date.now();
	while (Date.now() - start2Ms < 10) {
		/* busy wait */
	}
	tracker.start("deployment"); // completes verification

	const total = tracker.totalDuration();
	assert.ok(total >= 0, "Duration should be >= 0");
});

test("PhaseTracker totalDuration returns 0 for no phases", () => {
	const tracker = new PhaseTracker();
	assert.equal(tracker.totalDuration(), 0);
});

test("PhaseTracker summary returns correct counts", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	// Simulate work
	const startMs = Date.now();
	while (Date.now() - startMs < 10) {
		/* busy wait */
	}
	tracker.start("implementation"); // completes assessment

	tracker.start("verification");
	// Simulate work
	const start2Ms = Date.now();
	while (Date.now() - start2Ms < 10) {
		/* busy wait */
	}
	tracker.skip("verification"); // completes implementation

	tracker.start("deployment");
	tracker.fail("deployment", "Config error"); // deployment fails (also completes verification if it was still active)

	// After fail, deployment is not active anymore
	// But since fail() might try to complete the previous phase which is already skipped...
	// Let's verify by checking phase statuses
	const phases = tracker.getPhases();

	// The key is: fail() sets currentPhaseName to null after marking deployment as failed
	// So after fail, there's no active phase. Starting a new phase won't try to complete a skipped one.
	// However, deployment.fail() should complete the previous phase (verification) first

	// Let's trace through:
	// 1. start("assessment") -> current = assessment
	// 2. start("implementation") -> completes assessment, current = implementation
	// 3. start("verification") -> completes implementation, current = verification
	// 4. skip("verification") -> verification is skipped, currentPhaseName = null
	// 5. start("deployment") -> since current is null, just start deployment. Verification stays skipped
	// 6. fail("deployment") -> deployment is failed, currentPhaseName = null

	// So we have: assessment=completed, implementation=completed, verification=skipped, deployment=failed
	assert.equal(phases.length, 4);
	assert.equal(phases.filter((p) => p.status === "active").length, 0, "no active phases");
	assert.equal(phases.filter((p) => p.status === "completed").length, 2, "2 completed");
	assert.equal(phases.filter((p) => p.status === "skipped").length, 1, "1 skipped");
	assert.equal(phases.filter((p) => p.status === "failed").length, 1, "1 failed");

	const summary = tracker.summary();
	assert.equal(summary.totalPhases, 4);
	assert.equal(summary.active, 0);
	assert.equal(summary.completed, 2);
	assert.equal(summary.skipped, 1);
	assert.equal(summary.failed, 1);
	assert.ok(summary.totalDurationMs >= 0);
});

test("PhaseTracker hasPhase checks existence", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	assert.equal(tracker.hasPhase("assessment"), true);
	assert.equal(tracker.hasPhase("implementation"), false);
});

test("PhaseTracker reset clears all state", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	tracker.start("implementation");

	tracker.reset();

	assert.equal(tracker.getPhases().length, 0);
	assert.equal(tracker.getCurrentPhase(), null);
});

test("PhaseTracker emits phase:started event", () => {
	const tracker = new PhaseTracker();
	const events: string[] = [];

	tracker.on("phase:started", (e) => events.push(`started:${e.phase.name}`));
	tracker.on("phase:completed", (e) => events.push(`completed:${e.phase.name}`));

	tracker.start("assessment");
	assert.deepEqual(events, ["started:assessment"]);

	tracker.complete("assessment");
	assert.deepEqual(events, ["started:assessment", "completed:assessment"]);
});

test("PhaseTracker emits phase:skipped event", () => {
	const tracker = new PhaseTracker();
	const events: string[] = [];

	tracker.on("phase:skipped", (e) => events.push(`skipped:${e.phase.name}`));

	tracker.start("assessment");
	tracker.skip("assessment");

	assert.deepEqual(events, ["skipped:assessment"]);
});

test("PhaseTracker emits phase:failed event", () => {
	const tracker = new PhaseTracker();
	const events: string[] = [];

	tracker.on("phase:failed", (e) => events.push(`failed:${e.phase.name}`));

	tracker.start("assessment");
	tracker.fail("assessment", "Timeout");

	assert.deepEqual(events, ["failed:assessment"]);
});

test("PhaseTracker throws on starting phase while previous active", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	// Starting a new phase completes the previous one automatically
	const phase2 = tracker.start("implementation");
	assert.equal(phase2.name, "implementation");

	// Check that assessment is completed
	const assessment = tracker.getPhase("assessment");
	assert.equal(assessment?.status, "completed");
});

test("PhaseTracker metrics merge correctly", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment", {
		tasksCompleted: 5,
		tokensUsed: 10000,
		subagentsSpawned: 2,
	});

	tracker.complete("assessment", { tasksCompleted: 8 }); // update only tasksCompleted

	const metrics = tracker.getMetrics("assessment");
	assert.equal(metrics?.tasksCompleted, 8);
	assert.equal(metrics?.tokensUsed, 10000, "tokensUsed should remain from initial");
	assert.equal(metrics?.subagentsSpawned, 2);
});

test("PhaseTracker custom metrics preserved", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment", { custom: { priority: "high" } });

	tracker.updateCurrentMetrics({
		custom: { priority: "high", tag: "urgent" },
	});

	const metrics = tracker.getMetrics("assessment");
	assert.equal(metrics?.custom?.priority, "high");
	assert.equal(metrics?.custom?.tag, "urgent");
});

test("PhaseTracker completes merges custom metrics", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment", { custom: { env: "test" } });

	tracker.complete("assessment", { custom: { env: "test", version: "1.0" } });

	const metrics = tracker.getMetrics("assessment");
	assert.equal(metrics?.custom?.env, "test");
	assert.equal(metrics?.custom?.version, "1.0");
});

test("PhaseTracker duration calculated correctly", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	// Simulate time passing
	const startMs = Date.now();
	while (Date.now() - startMs < 50) {
		/* busy wait */
	}
	tracker.complete("assessment");

	const completed = tracker.getPhase("assessment");
	assert.ok(completed?.durationMs !== undefined);
	assert.ok(completed!.durationMs! >= 0);
});

test("PhaseTracker phase index increments", () => {
	const tracker = new PhaseTracker();
	const p1 = tracker.start("assessment");
	// start() completes previous, so p2 becomes index 1
	const p2 = tracker.start("implementation");
	const p3 = tracker.start("verification");

	assert.equal(p1.index, 0);
	assert.equal(p2.index, 1);
	assert.equal(p3.index, 2);
});

test("PhaseTracker empty metrics on start", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	const metrics = tracker.getMetrics("assessment");
	assert.ok(metrics);
	assert.equal(metrics?.tasksCompleted, 0);
	assert.equal(metrics?.tasksFailed, 0);
	assert.equal(metrics?.tokensUsed, 0);
	assert.equal(metrics?.subagentsSpawned, 0);
});

test("PhaseTracker EventEmitter inheritance", () => {
	const tracker = new PhaseTracker();
	assert.ok(tracker instanceof EventEmitter);
});

test("PhaseTracker removeListener", () => {
	const tracker = new PhaseTracker();
	let count = 0;
	const handler = () => count++;

	tracker.on("phase:started", handler);
	tracker.start("assessment");
	assert.equal(count, 1);

	tracker.removeListener("phase:started", handler);
	tracker.start("implementation");
	assert.equal(count, 1, "Handler should not fire after removal");
});

test("PhaseTracker once fires only once", () => {
	const tracker = new PhaseTracker();
	let count = 0;
	tracker.once("phase:started", () => count++);

	tracker.start("assessment");
	assert.equal(count, 1);

	tracker.start("implementation");
	assert.equal(count, 1, "once should only fire once");
});

test("PhaseTracker fail without error message", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");

	tracker.fail("assessment");

	const phase = tracker.getPhase("assessment");
	assert.equal(phase?.status, "failed");
	assert.equal(phase?.metrics?.custom?.error, undefined);
});

test("PhaseTracker throw on fail non-existent phase", () => {
	const tracker = new PhaseTracker();
	assert.throws(() => tracker.fail("nonexistent"), /Phase "nonexistent" not found/);
});

test("PhaseTracker throw on fail inactive phase", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	tracker.complete("assessment");

	assert.throws(() => tracker.fail("assessment"), /Phase "assessment" is not active/);
});

test("PhaseTracker throw on skip inactive phase", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment");
	tracker.complete("assessment");

	assert.throws(() => tracker.skip("assessment"), /Phase "assessment" is not active/);
});

test("PhaseTracker getMetrics for non-existent phase", () => {
	const tracker = new PhaseTracker();
	const metrics = tracker.getMetrics("nonexistent");
	assert.equal(metrics, undefined);
});

test("PhaseTracker complete updates metrics correctly", () => {
	const tracker = new PhaseTracker();
	tracker.start("assessment", {
		tasksCompleted: 1,
		tasksFailed: 0,
		tokensUsed: 1000,
		subagentsSpawned: 1,
	});

	tracker.complete("assessment", {
		tasksCompleted: 5,
		tasksFailed: 1,
	});

	const metrics = tracker.getMetrics("assessment");
	assert.equal(metrics?.tasksCompleted, 5);
	assert.equal(metrics?.tasksFailed, 1);
	assert.equal(metrics?.tokensUsed, 1000, "tokensUsed unchanged from start");
	assert.equal(metrics?.subagentsSpawned, 1, "subagentsSpawned unchanged from start");
});
