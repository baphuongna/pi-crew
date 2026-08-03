import assert from "node:assert/strict";
import test from "node:test";
import {
	effectivenessPolicyDecision,
	evaluateRunEffectiveness,
	formatRunEffectivenessLines,
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
