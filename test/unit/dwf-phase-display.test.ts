import assert from "node:assert/strict";
import test from "node:test";
import type { TeamEvent } from "../../src/state/event-log/event-log.ts";
import { renderProgressPane } from "../../src/ui/dashboard-panes/progress-pane.ts";
import { extractDwfPhaseState, renderDwfPhaseLines } from "../../src/ui/dwf-phase-display.ts";
import type { RunUiSnapshot } from "../../src/ui/snapshot-types.ts";

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function phaseStarted(phase: string, seq = 0): TeamEvent {
	return {
		time: "2026-06-23T00:00:00Z",
		type: "dwf.phase_started",
		runId: "run",
		data: { phase },
		metadata: { seq, provenance: "test" },
	};
}

function phaseCompleted(phase: string, seq = 0): TeamEvent {
	return {
		time: "2026-06-23T00:00:00Z",
		type: "dwf.phase_completed",
		runId: "run",
		data: { phase },
		metadata: { seq, provenance: "test" },
	};
}

function taskEvent(seq = 0): TeamEvent {
	return {
		time: "2026-06-23T00:00:00Z",
		type: "task.completed",
		runId: "run",
		taskId: "t1",
		metadata: { seq, provenance: "test" },
	};
}

// ---------------------------------------------------------------------------
// Test 1: phase state tracking from event sequence
// ---------------------------------------------------------------------------

test("extractDwfPhaseState: tracks current + completed phases from event sequence", () => {
	const events = [phaseStarted("Scan", 1), phaseCompleted("Scan", 2), phaseStarted("Plan", 3)];
	const state = extractDwfPhaseState(events);
	assert.ok(state, "expected non-null state for a DWF run");
	assert.equal(state!.currentPhase, "Plan");
	assert.equal(state!.phases.length, 2);
	assert.equal(state!.phases[0]?.name, "Scan");
	assert.equal(state!.phases[0]?.status, "completed");
	assert.equal(state!.phases[1]?.name, "Plan");
	assert.equal(state!.phases[1]?.status, "running");
});

test("extractDwfPhaseState: all completed when every phase is closed", () => {
	const events = [phaseStarted("Scan", 1), phaseCompleted("Scan", 2), phaseStarted("Plan", 3), phaseCompleted("Plan", 4)];
	const state = extractDwfPhaseState(events);
	assert.equal(state!.currentPhase, null);
	assert.equal(state!.phases[0]?.status, "completed");
	assert.equal(state!.phases[1]?.status, "completed");
});

test("extractDwfPhaseState: single running phase", () => {
	const events = [phaseStarted("Scan", 1)];
	const state = extractDwfPhaseState(events);
	assert.equal(state!.currentPhase, "Scan");
	assert.equal(state!.phases.length, 1);
	assert.equal(state!.phases[0]?.status, "running");
});

test("extractDwfPhaseState: recovers a phase whose started event scrolled off", () => {
	// Only the completed event for "Scan" is visible (started scrolled off window).
	const events = [phaseCompleted("Scan", 2), phaseStarted("Plan", 3)];
	const state = extractDwfPhaseState(events);
	assert.equal(state!.phases.length, 2);
	assert.equal(state!.phases[0]?.name, "Scan");
	assert.equal(state!.phases[0]?.status, "completed");
	assert.equal(state!.phases[1]?.name, "Plan");
	assert.equal(state!.phases[1]?.status, "running");
	assert.equal(state!.currentPhase, "Plan");
});

test("extractDwfPhaseState: phase started but completion scrolled off is pending", () => {
	// "Scan" started; its completion scrolled off; "Plan" started after.
	const events = [phaseStarted("Scan", 1), phaseStarted("Plan", 3), phaseCompleted("Plan", 4)];
	const state = extractDwfPhaseState(events);
	const scan = state!.phases.find((p) => p.name === "Scan");
	assert.equal(scan?.status, "pending");
	const plan = state!.phases.find((p) => p.name === "Plan");
	assert.equal(plan?.status, "completed");
	assert.equal(state!.currentPhase, null);
});

// ---------------------------------------------------------------------------
// Test 2: render output has correct markers
// ---------------------------------------------------------------------------

test("renderDwfPhaseLines: emits correct Unicode markers per status", () => {
	const state = {
		phases: [
			{ name: "Scan", status: "completed" as const },
			{ name: "Plan", status: "running" as const },
			{ name: "Review", status: "pending" as const },
		],
		currentPhase: "Plan",
	};
	const lines = renderDwfPhaseLines(state);
	assert.ok(lines.some((line) => line.includes("✓ Phase: Scan")));
	assert.ok(lines.some((line) => line.includes("▶ Phase: Plan")));
	assert.ok(lines.some((line) => line.includes("⏸ Phase: Review")));
});

test("renderDwfPhaseLines: emits ASCII fallback markers when requested", () => {
	const state = {
		phases: [
			{ name: "Scan", status: "completed" as const },
			{ name: "Plan", status: "running" as const },
			{ name: "Review", status: "pending" as const },
		],
		currentPhase: "Plan",
	};
	const lines = renderDwfPhaseLines(state, { ascii: true });
	assert.ok(lines.some((line) => line.includes("[v] Phase: Scan")));
	assert.ok(lines.some((line) => line.includes("[>] Phase: Plan")));
	assert.ok(lines.some((line) => line.includes("[ ] Phase: Review")));
});

test("renderDwfPhaseLines: emits grouping header only for multiple phases", () => {
	const multi = renderDwfPhaseLines({
		phases: [
			{ name: "Scan", status: "running" as const },
			{ name: "Plan", status: "completed" as const },
		],
		currentPhase: "Scan",
	});
	assert.ok(multi.some((line) => line.includes("DWF Phases")));

	const single = renderDwfPhaseLines({
		phases: [{ name: "Scan", status: "running" as const }],
		currentPhase: "Scan",
	});
	assert.ok(!single.some((line) => line.includes("DWF Phases")));
});

// ---------------------------------------------------------------------------
// Test 3: non-DWF runs unaffected (no phase display)
// ---------------------------------------------------------------------------

test("extractDwfPhaseState: returns null when no dwf.phase_* events", () => {
	const events = [taskEvent(1), taskEvent(2)];
	assert.equal(extractDwfPhaseState(events), null);
	assert.equal(extractDwfPhaseState([]), null);
});

test("renderProgressPane: no DWF phase lines for a non-DWF snapshot", () => {
	const snapshot: RunUiSnapshot = {
		runId: "run",
		cwd: process.cwd(),
		fetchedAt: 0,
		signature: "s",
		manifest: {
			schemaVersion: 1,
			runId: "run",
			cwd: process.cwd(),
			team: "t",
			workflow: "w",
			goal: "g",
			status: "running",
			createdAt: "",
			updatedAt: "",
			stateRoot: "",
			artifactsRoot: "",
			tasksPath: "",
			eventsPath: "",
			artifacts: [],
			workspaceMode: "single",
		},
		tasks: [],
		agents: [],
		progress: { total: 0, completed: 0, running: 0, failed: 0, queued: 0 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [taskEvent(1)],
		recentOutputLines: [],
	};
	const lines = renderProgressPane(snapshot);
	assert.ok(!lines.some((line) => line.includes("DWF Phases")));
	assert.ok(!lines.some((line) => line.includes("Phase: ")));
});

test("renderProgressPane: renders DWF phase markers when phase state is present", () => {
	const snapshot: RunUiSnapshot = {
		runId: "run",
		cwd: process.cwd(),
		fetchedAt: 0,
		signature: "s",
		manifest: {
			schemaVersion: 1,
			runId: "run",
			cwd: process.cwd(),
			team: "t",
			workflow: "w",
			goal: "g",
			status: "running",
			createdAt: "",
			updatedAt: "",
			stateRoot: "",
			artifactsRoot: "",
			tasksPath: "",
			eventsPath: "",
			artifacts: [],
			workspaceMode: "single",
		},
		tasks: [],
		agents: [],
		progress: { total: 0, completed: 0, running: 0, failed: 0, queued: 0 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		dwfPhaseState: extractDwfPhaseState([phaseStarted("Scan", 1), phaseCompleted("Scan", 2), phaseStarted("Plan", 3)]),
		recentEvents: [],
		recentOutputLines: [],
	};
	const lines = renderProgressPane(snapshot);
	assert.ok(lines.some((line) => line.includes("✓ Phase: Scan")));
	assert.ok(lines.some((line) => line.includes("▶ Phase: Plan")));
	// Phase markers appear before the recent-events log section.
	const planIdx = lines.findIndex((l) => l.includes("▶ Phase: Plan"));
	assert.ok(planIdx >= 0, "expected Plan marker line to be present");
});
