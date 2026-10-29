/**
 * Regression test — pi-crew/resume-disarms-run-budget-enforcement (runtime
 * boundary half).
 *
 * BUG: budget/deadline enforcement is caller-supplied (ExecuteTeamRunInput)
 * rather than manifest-derived, and the resume re-entry (handleResume static
 * path) reconstructed the input WITHOUT re-forwarding the persisted budget
 * fields. enforceRunBudget gates solely on ctx.input.budgetTotal, so a
 * paused-and-resumed budgeted run escaped its spend cap entirely (disarmed —
 * PoC: 4 workers × 15 tokens completed against a 15-token manifest cap, zero
 * budget events, status completed).
 *
 * FIX: executeTeamRun re-arms missing input budget fields from the loaded
 * manifest (manifest-derived enforcement at the runtime boundary — `??=` never
 * overrides caller-supplied values), so EVERY execution of the same run keeps
 * its operator bounds regardless of caller diligence.
 *
 * Test strategy (mirrors team-runner-budget-abort-inflight.test.ts): 4
 * INDEPENDENT parallel tasks via the json-success mock (15 tokens usage each),
 * executed in the EXACT resume shape — manifest persisted with budgetTotal=15
 * + status failed + isResume:true, input WITHOUT budget fields. Pre-fix this
 * completed all 4 tasks (60 tokens, 400% of cap) with zero budget events; with
 * the fix the first settled merge trips the abort threshold (0.95 × 15) and
 * the run fails with run.budget_abort. A control arm differing ONLY in the
 * persisted manifest budget (absent) must still complete — proving enforcement
 * is budget-driven, not an unrelated breakage.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test_resetCap, getWorkerCapCapacity } from "../../../src/runtime/scheduling/global-worker-cap.ts";
import { executeTeamRun } from "../../../src/runtime/team-runner.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";

// ─── Mock env helpers (mirrors team-runner-budget-abort-inflight.test.ts) ──────────

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

function budgetAbortEventCount(eventsPath: string): number {
	if (!fs.existsSync(eventsPath)) return 0;
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.includes('"type":"run.budget_abort"')).length;
}

/** Seed a crashed run for the resume shape: manifest persisted with (optional)
 * budget fields + status failed; tasks queued (what handleResume's reset
 * produces). `taskCount` 4 for the budget arm (abort must prevent full
 * dispatch), 2 for the control (single dispatch wave — multi-wave mock runs
 * hit a PRE-EXISTING run.lock lock-busy task failure at wave ≥2, verified to
 * reproduce on HEAD 6063f377 with the fix reverted: not this fix's concern). */
function seedResumeShapeRun(
	cwd: string,
	budget: { budgetTotal?: number; budgetWarning?: number; budgetAbort?: number } | undefined,
	taskCount: number,
) {
	const stepKeys = ["a", "b", "c", "d"].slice(0, taskCount);
	const team = {
		name: "resume-budget-rearm",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "resume-budget-rearm",
		description: "",
		steps: stepKeys.map((key) => ({ id: key, role: "worker", task: key.toUpperCase() })),
		source: "test",
		filePath: "builtin",
	} as never;
	const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

	const created = createRunManifest({ cwd, team, workflow, goal: "resume budget re-arm" });
	const tasks: TeamTaskState[] = stepKeys.map((key, index) =>
		makeTask(`0${index + 1}_${key}`, key, "worker", "worker", created.manifest.runId, cwd),
	);
	const manifest = {
		...created.manifest,
		status: "failed" as const,
		summary: "simulated crash for resume-budget-rearm",
		...(budget ?? {}),
	};
	saveRunManifest(manifest);
	saveRunTasks(manifest, tasks);
	return { manifest, tasks, team, workflow, agents };
}

test("resume re-arm: budgeted manifest + budget-LESS input (exact handleResume shape) still aborts at the cap", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resume-rearm-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success"); // each task reports 15 tokens usage
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(8); // enough worker slots for 4 parallel tasks
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const { manifest, tasks, team, workflow, agents } = seedResumeShapeRun(
			cwd,
			{
				budgetTotal: 15,
				budgetWarning: 0.8,
				budgetAbort: 0.95,
			},
			4,
		);

		// The EXACT resume shape: input carries NO budget fields (that is the
		// handleResume re-entry bug) — enforcement must come from the manifest.
		// maxConcurrentWorkers 1: STRICTLY sequential waves — the first merge (15
		// tokens) trips the abort before any second wave dispatches. Parallel mock
		// waves contend on the per-run write lock (persistSingleTaskUpdate) — a
		// PRE-EXISTING lock-busy task failure at wave ≥2 (verified to reproduce on
		// HEAD 6063f377 with the fix reverted) would pollute the assertions.
		const result = await executeTeamRun({
			manifest,
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 1 },
			reliability: { autoRetry: false },
			signal: undefined,
			workspaceId: cwd,
			isResume: true,
		});

		// DISARM-REFUTED: the resumed execution must trip the persisted cap —
		// pre-fix this arm completed all 4 tasks (60 tokens vs 15 cap) silently.
		assert.equal(result.manifest.status, "failed", `budgeted resume-shape run must fail at the cap, got: ${result.manifest.status}`);
		const completed = result.tasks.filter((t) => t.status === "completed");
		assert.ok(completed.length >= 1, "the task that tripped the abort must have completed (its merge fired the check)");
		assert.ok(
			completed.length < 4,
			`abort must prevent the full 4-task dispatch (400% of cap). Got: ${JSON.stringify(statusMap(result.tasks))}`,
		);

		// The abort must be loud: exactly one run.budget_abort event naming the cap.
		const abortEvents = budgetAbortEventCount(manifest.eventsPath);
		assert.equal(abortEvents, 1, `expected exactly one run.budget_abort event, got ${abortEvents}`);

		// Disk consistency: the persisted budget survived the run (input→manifest
		// direction never erases the operator's cap).
		const disk = loadRunManifestById(cwd, manifest.runId);
		assert.ok(disk, "run must be loadable from disk");
		assert.equal(disk.manifest.budgetTotal, 15, "persisted budgetTotal must survive the resumed execution");
		assert.equal(disk.manifest.status, "failed");
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume re-arm control: UNBUDGETED manifest + budget-less input completes (no regression for budget-less runs)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resume-rearm-ctrl-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(8);
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		// Identical shape — the ONLY difference is the absent manifest budget.
		// 2 tasks = a single dispatch wave, so the control completes without the
		// pre-existing multi-wave lock-busy artifact.
		const { manifest, tasks, team, workflow, agents } = seedResumeShapeRun(cwd, undefined, 2);

		const result = await executeTeamRun({
			manifest,
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			// Sequential here too — the pre-existing lock-busy artifact hits ANY
			// parallel mock wave (see the budgeted arm's comment).
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 1 },
			reliability: { autoRetry: false },
			signal: undefined,
			workspaceId: cwd,
			isResume: true,
		});

		const controlStatuses = statusMap(result.tasks);
		assert.equal(
			result.manifest.status,
			"completed",
			`budget-less control must complete, got: ${result.manifest.status} — summary: ${result.manifest.summary ?? ""} — tasks: ${JSON.stringify(controlStatuses)} — errors: ${JSON.stringify(result.tasks.filter((t) => t.error).map((t) => ({ id: t.id, error: t.error })))}`,
		);
		assert.equal(result.tasks.filter((t) => t.status === "completed").length, 2, "all control tasks complete");
		assert.equal(budgetAbortEventCount(manifest.eventsPath), 0, "no budget events without a budget");
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
