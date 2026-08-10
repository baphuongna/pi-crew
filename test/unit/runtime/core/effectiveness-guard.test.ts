import assert from "node:assert/strict";
import test from "node:test";
import {
	effectivenessPolicyDecision,
	evaluateRunEffectiveness,
	formatRunEffectivenessLines,
	taskHasEmptyResult,
} from "../../../../src/runtime/effectiveness.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

function manifest(safety: NonNullable<TeamRunManifest["runtimeResolution"]>["safety"] = "trusted"): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run_effective",
		team: "default",
		workflow: "default",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/project/.crew/state/runs/run_effective",
		artifactsRoot: "/tmp/project/.crew/artifacts/run_effective",
		tasksPath: "/tmp/project/.crew/state/runs/run_effective/tasks.json",
		eventsPath: "/tmp/project/.crew/state/runs/run_effective/events.jsonl",
		artifacts: [],
		runtimeResolution: {
			kind: safety === "explicit_dry_run" ? "scaffold" : "child-process",
			requestedMode: safety === "explicit_dry_run" ? "scaffold" : "auto",
			safety,
			available: safety !== "blocked",
			resolvedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

function task(id: string, observed = false): TeamTaskState {
	return {
		id,
		runId: "run_effective",
		role: "executor",
		agent: "executor",
		title: id,
		status: "completed",
		dependsOn: [],
		cwd: "/tmp/project",
		finishedAt: "2026-01-01T00:00:01.000Z",
		resultArtifact: {
			kind: "result",
			path: `/tmp/project/.crew/artifacts/run_effective/results/${id}.txt`,
			createdAt: "2026-01-01T00:00:01.000Z",
			producer: id,
			retention: "run",
		},
		...(observed ? { jsonEvents: 1 } : {}),
	};
}

function taskWithRole(id: string, role: string, observed = false): TeamTaskState {
	return {
		id,
		runId: "run_effective",
		role,
		agent: role,
		title: id,
		status: "completed",
		dependsOn: [],
		cwd: "/tmp/project",
		finishedAt: "2026-01-01T00:00:01.000Z",
		resultArtifact: {
			kind: "result",
			path: `/tmp/project/.crew/artifacts/run_effective/results/${id}.txt`,
			createdAt: "2026-01-01T00:00:01.000Z",
			producer: id,
			retention: "run",
		},
		...(observed ? { jsonEvents: 1 } : {}),
	};
}

test("effectiveness guard warns by default for read-only workers without observed work", () => {
	const summary = evaluateRunEffectiveness({
		manifest: manifest("trusted"),
		tasks: [taskWithRole("01_explore", "explorer")],
		executeWorkers: true,
	});
	assert.equal(summary.severity, "warning");
	assert.deepEqual(summary.noObservedWorkTaskIds, ["01_explore"]);
});

test("effectiveness guard escalates warn to blocked for mutating workers without observed work", () => {
	const summary = evaluateRunEffectiveness({
		manifest: manifest("trusted"),
		tasks: [task("01_exec")],
		executeWorkers: true,
	});
	assert.equal(summary.severity, "blocked");
	assert.deepEqual(summary.noObservedWorkTaskIds, ["01_exec"]);
	assert.equal(effectivenessPolicyDecision(summary)?.action, "block");
});

test("effectiveness guard can block or fail", () => {
	assert.equal(
		evaluateRunEffectiveness({
			manifest: manifest("trusted"),
			tasks: [task("01_exec")],
			executeWorkers: true,
			runtimeConfig: { effectivenessGuard: "block" },
		}).severity,
		"blocked",
	);
	assert.equal(
		evaluateRunEffectiveness({
			manifest: manifest("trusted"),
			tasks: [task("01_exec")],
			executeWorkers: true,
			runtimeConfig: { effectivenessGuard: "fail" },
		}).severity,
		"failed",
	);
});

test("scaffold dry-runs do not trigger effectiveness guard", () => {
	const summary = evaluateRunEffectiveness({
		manifest: manifest("explicit_dry_run"),
		tasks: [task("01_explore")],
		executeWorkers: false,
	});
	assert.equal(summary.severity, "ok");
	assert.equal(summary.workerExecution, "disabled/scaffold");
	assert.match(formatRunEffectivenessLines(summary).join("\n"), /Worker execution: disabled\/scaffold/);
});

test("observed real-worker tasks pass effectiveness guard", () => {
	const summary = evaluateRunEffectiveness({
		manifest: manifest("trusted"),
		tasks: [task("01_exec", true)],
		executeWorkers: true,
		runtimeConfig: { effectivenessGuard: "block" },
	});
	assert.equal(summary.severity, "ok");
	assert.equal(summary.observable, 1);
	assert.deepEqual(summary.noObservedWorkTaskIds, []);
});

// ─── F4: empty-result guard (real-test-2026-08-10 finding) ────────────────
// A child worker absorbed by a rate-limit (429) or model-not-found failure
// still emits transcript/usage events (so "observable activity" = true),
// but its result artifact is an EMPTY file. Such a task has done no real
// work and must not count toward run effectiveness.

function taskWithEmptyResult(id: string, observed = false, sizeBytes = 0): TeamTaskState {
	const base = task(id, observed);
	return {
		...base,
		resultArtifact: base.resultArtifact ? { ...base.resultArtifact, sizeBytes } : undefined,
	};
}

test("taskHasEmptyResult: flags only sizeBytes === 0 with a result artifact", () => {
	assert.equal(taskHasEmptyResult(taskWithEmptyResult("01_exec", true, 0)), true);
	assert.equal(taskHasEmptyResult(taskWithEmptyResult("01_exec", true, 128)), false);
	assert.equal(taskHasEmptyResult(task("01_exec", true)), false); // undefined sizeBytes (legacy) — no false positive
	assert.equal(taskHasEmptyResult({ ...task("01_exec"), resultArtifact: undefined }), false);
});

test("F4: completed task with EMPTY result fails the guard despite observable events", () => {
	const summary = evaluateRunEffectiveness({
		manifest: manifest("trusted"),
		// jsonEvents:1 = "observable activity" per the old heuristic, but the
		// result file is empty (0 bytes) — the 429-absorbed-worker case.
		tasks: [taskWithEmptyResult("01_exec", true, 0)],
		executeWorkers: true,
		runtimeConfig: { effectivenessGuard: "block" },
	});
	assert.equal(summary.severity, "blocked");
	assert.equal(summary.observable, 0);
	assert.deepEqual(summary.noObservedWorkTaskIds, ["01_exec"]);
});

test("F4: non-empty result with observed events still passes", () => {
	const summary = evaluateRunEffectiveness({
		manifest: manifest("trusted"),
		tasks: [taskWithEmptyResult("01_exec", true, 256)],
		executeWorkers: true,
		runtimeConfig: { effectivenessGuard: "block" },
	});
	assert.equal(summary.severity, "ok");
	assert.equal(summary.observable, 1);
	assert.deepEqual(summary.noObservedWorkTaskIds, []);
});
