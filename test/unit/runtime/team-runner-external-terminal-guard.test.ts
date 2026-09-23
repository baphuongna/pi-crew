import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRunManifest, saveRunManifest, saveRunTasks, updateRunStatus } from "../../../src/state/stores/state-store.ts";
import { externalTerminalDecision } from "../../../src/runtime/team-runner.ts";

type SchedulerCtx = Parameters<typeof externalTerminalDecision>[0];

function makeTeam() {
	return { name: "fast-fix", description: "", roles: [{ name: "executor", agent: "executor" }], source: "test", filePath: "builtin" } as never;
}
function makeWorkflow() {
	return { name: "fast-fix", description: "", source: "test", filePath: "builtin", steps: [] } as never;
}

/**
 * Finding 8 regression (2026-09-23 live battery, run team_20260923174507):
 * a cross-session cancel wrote `run.cancelled` to disk, but the scheduler loop
 * only observed its own in-process signal — it dispatched the next phase,
 * overwrote `cancelled` → `running` → `completed`, and the user's cancel was
 * fully erased (worker + phase continued ~96s post-cancel).
 *
 * externalTerminalDecision() re-reads the manifest at the top of every loop
 * iteration and stops scheduling when an external decision made the run
 * terminal — adopting the on-disk state as truth.
 *
 * Fixture isolation lesson (e81d81a3): ALWAYS create the project marker
 * (`.crew/`) inside the tmp cwd so state stays in the rmSync'd tmpdir.
 */

function makeCtx(cwd: string, manifest: unknown, tasks: unknown[]): SchedulerCtx {
	return {
		manifest,
		tasks,
		input: {},
		workflow: { steps: [] },
		queueIndex: new Map(),
		wfMachine: {},
		pendingUnits: new Map(),
		dispatchedTaskIds: new Set(),
		runController: new AbortController(),
		runtimeKind: "child-process",
		adaptivePlanInjected: false,
		adaptivePlanMissing: false,
		settledMerge: null,
		resultReadCache: undefined,
	} as unknown as SchedulerCtx;
}

describe("externalTerminalDecision (finding 8: external cancel vs scheduler loop)", () => {
	it("returns null while the on-disk run is active (normal scheduling untouched)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f8-active-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
			const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8 active" });
			const ctx = makeCtx(cwd, manifest, []);
			assert.equal(externalTerminalDecision(ctx), null);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("STOPS and adopts on-disk state when an external cancel made the run terminal — the live race", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f8-cancel-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
			const { manifest, tasks } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8 cancel" });
			// Simulate the in-memory loop view: run still "running", next task queued.
			// Then the EXTERNAL decision lands on disk (cancelled) — exactly the
			// cross-session cancel of the live timeline.
			updateRunStatus(manifest, "cancelled", "Cancelled by user request.");
			const decision = externalTerminalDecision(makeCtx(cwd, manifest, tasks));
			assert.ok(decision && decision.kind === "return", "must return a stop decision");
			assert.equal(decision.result.manifest.status, "cancelled");
			assert.equal(decision.result.manifest.runId, manifest.runId);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("adopts the on-disk TASKS as truth (the external decision's view wins)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f8-tasks-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
			const { manifest, tasks } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8 tasks" });
			const cancelled = updateRunStatus(manifest, "cancelled", "external");
			const diskTasks = tasks.map((t) => ({ ...t, status: "cancelled" as const }));
			saveRunTasks(cancelled, diskTasks);
			// in-memory loop still thinks 02 is queued
			const staleTasks = tasks.map((t) => ({ ...t, status: "queued" as const }));
			const decision = externalTerminalDecision(makeCtx(cwd, manifest, staleTasks));
			assert.ok(decision && decision.kind === "return");
			assert.ok(decision.result.tasks.every((t) => t.status === "cancelled"), "on-disk cancelled tasks win over stale queued view");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("treats completed/failed terminal manifests the same as cancelled", () => {
		for (const status of ["completed", "failed"] as const) {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-f8-${status}-`));
			try {
				fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
				const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: `f8 ${status}` });
			// updateRunStatus's state machine refuses running→completed/failed here —
			// but an EXTERNAL writer can put ANY status on disk; simulate that directly.
			saveRunManifest({ ...manifest, status });
				const decision = externalTerminalDecision(makeCtx(cwd, manifest, []));
				assert.ok(decision && decision.kind === "return", `${status} must stop the loop`);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	});
});
