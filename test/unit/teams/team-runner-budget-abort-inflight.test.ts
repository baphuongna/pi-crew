/**
 * RT-NEW-2 regression test: budget abort must NOT clobber in-flight tasks
 * to "skipped".
 *
 * BUG: enforceRunBudget did `markBlocked(tasks)` + `saveRunTasksAsync` +
 * return WITHOUT draining `ctx.pendingUnits` first. In-flight tasks are still
 * "queued" in ctx.tasks (streaming dispatch never sets "running"), so
 * markBlocked maps queued→skipped. Team resume never re-queues skipped tasks
 * → permanent work loss.
 *
 * FIX: enforceRunBudget now routes through the shared terminaliseRunWithDrain
 * helper (extracted verbatim from handleFailedTask): drain pendingUnits +
 * merge settled results under withRunLock BEFORE markBlocked, so in-flight
 * tasks become completed/cancelled — never skipped.
 *
 * Test strategy: 4 INDEPENDENT parallel tasks using the json-success mock
 * (15 tokens usage each). budgetTotal=15 → abort threshold = 0.95*15 = 14.25;
 * the first settled task's merge (15 tokens) triggers the budget abort while
 * the other tasks are still in-flight (in ctx.pendingUnits). With the fix,
 * the in-flight tasks are drained+merged (completed) or cancelled — never
 * skipped. Without the fix, they are clobbered to "skipped".
 *
 * NOTE on timing: the exact completed/cancelled split depends on whether each
 * in-flight worker settles before drain aborts the controller. The assertion
 * targets the INVARIANT that holds in every outcome: NO task is skipped
 * (in-flight tasks are completed-or-cancelled), and the run is failed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test_resetCap, getWorkerCapCapacity } from "../../../src/runtime/scheduling/global-worker-cap.ts";
import { executeTeamRun } from "../../../src/runtime/team-runner.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";

// ─── Mock env helpers ──────────────────────────────────────────────

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
	maxWorkers: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
		maxWorkers: process.env.PI_CREW_MAX_WORKERS,
	};
}

function setMockEnv(mock: string): void {
	process.env.PI_TEAMS_MOCK_CHILD_PI = mock;
	process.env.PI_CREW_ALLOW_MOCK = "1";
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
	if (state.maxWorkers === undefined) delete process.env.PI_CREW_MAX_WORKERS;
	else process.env.PI_CREW_MAX_WORKERS = state.maxWorkers;
}

// ─── Task fixture helpers ──────────────────────────────────────────

function makeTask(id: string, stepId: string, role: string, agent: string, runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		stepId,
		role,
		agent,
		title: id,
		status: "queued",
		dependsOn: [],
		cwd,
		graph: {
			taskId: id,
			children: [],
			dependencies: [],
			queue: "ready",
		},
	};
}

function statusMap(tasks: TeamTaskState[]): Record<string, TeamTaskState["status"]> {
	const map: Record<string, TeamTaskState["status"]> = {};
	for (const t of tasks) map[t.id] = t.status;
	return map;
}

// ─── Test ──────────────────────────────────────────────────────────

// NOTE (2026-08-15): this test is timing-sensitive under heavy external load.
// It passed 4/4 standalone runs but failed ONCE in the full suite while the
// host was at loadavg ~11 (parallel vitest + rust build). The failure mode
// (tripped task ends "cancelled" instead of "completed") is a drain-timing
// artifact, not a code regression — if it fails, FIRST check host load and
// re-run this file standalone before bisecting.

test("[RT-NEW-2] budget abort drains in-flight tasks — NO task is skipped", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rtnew2-budget-inflight-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success"); // each task reports 15 tokens usage
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(8); // enough worker slots for 4 parallel tasks
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "rtnew2-budget-inflight",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// 4 INDEPENDENT tasks — all ready at once, dispatched as a parallel batch.
		const workflow = {
			name: "rtnew2-budget-inflight",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B" },
				{ id: "c", role: "worker", task: "C" },
				{ id: "d", role: "worker", task: "D" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "RT-NEW-2 budget inflight test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd),
			makeTask("03_c", "c", "worker", "worker", created.manifest.runId, cwd),
			makeTask("04_d", "d", "worker", "worker", created.manifest.runId, cwd),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 4 },
			reliability: { autoRetry: false },
			// budgetTotal=15 → abort threshold = 0.95*15 = 14.25. The first
			// settled task's merge (15 tokens) trips the abort while the other
			// tasks are still in-flight.
			budgetTotal: 15,
			budgetAbort: 0.95,
			budgetWarning: 0.8,
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// INVARIANT (core RT-NEW-2 fix): NO task is skipped. In-flight tasks are
		// drained+merged (completed) or cancelled — never markBlocked→skipped.
		// Without the fix, the in-flight siblings would be clobbered to
		// "skipped" by markBlocked+saveRunTasksAsync.
		const skippedIds = result.tasks.filter((t) => t.status === "skipped").map((t) => t.id);
		assert.equal(
			skippedIds.length,
			0,
			`no in-flight task should be skipped (RT-NEW-2 fix). Got skipped: [${skippedIds.join(", ")}]. ` +
				`All tasks: ${JSON.stringify(sm)}`,
		);

		// All tasks reach a terminal, re-queueable state — none is lost/dropped
		// (left "queued"/"running") and none is clobbered to "skipped".
		// completed = drained+merged settled result; failed/cancelled = in-flight
		// worker aborted by drainPendingUnits (re-queueable — same as RT-1).
		// skipped is the ONLY forbidden state (resume never re-queues it).
		for (const t of result.tasks) {
			assert.ok(
				t.status === "completed" || t.status === "failed" || t.status === "cancelled",
				`task ${t.id} should be completed/failed/cancelled (re-queueable, never skipped), got "${t.status}"`,
			);
		}

		// The first settled task must be completed (its merge tripped the abort).
		assert.equal(sm["01_a"], "completed", "the task that tripped the budget abort should be completed");

		// Run should be marked failed.
		assert.equal(result.manifest.status, "failed", "run should be failed after budget abort");

		// Disk consistency: no task clobbered to "skipped" on disk either.
		const diskState = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(diskState, "run should be loadable from disk");
		const diskSkipped = diskState!.tasks.filter((t) => t.status === "skipped");
		assert.equal(diskSkipped.length, 0, `no task should be skipped on disk. Got: ${JSON.stringify(statusMap(diskState!.tasks))}`);
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
