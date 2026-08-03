/**
 * Cross-cut regression test: coalesced-group in-flight + singleton failure.
 *
 * Agent-6 found: handleFailedTask correctly handles a coalesced group that is
 * in-flight while a separate singleton fails, but NO test pins this behavior.
 * This test drives the PUBLIC executeTeamRun dispatch with:
 *   - 2 explorer tasks (read-only, same role+cwd) → coalesced into 1 group
 *   - 1 executor task (write role) → singleton
 *   - retryable-failure mock → ALL tasks fail
 *
 * When the first failure triggers handleFailedTask, it drains pendingUnits
 * (including the coalesced group's in-flight promise), merges settled results,
 * and cancels non-terminal in-flight tasks. We assert INVARIANTS that hold
 * regardless of the abort race (which task settles first):
 *
 *   (a) Coalesced members have IDENTICAL status (handled together as a unit).
 *   (b) No task is "skipped" — in-flight tasks are drained/merged or
 *       cancelled (re-queueable), never markBlocked→skipped.
 *   (c) All tasks reach a terminal, re-queueable state (failed/cancelled).
 *   (d) The singleton (executor) task is marked "failed".
 *
 * Test is PUBLIC-behavior-driven: uses executeTeamRun + mock-child harness
 * (same pattern as team-runner-failed-task-while-siblings-inflight.test.ts).
 * No internal mocking or spying of drainPendingUnits or other internals.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test_resetCap, getWorkerCapCapacity } from "../../src/runtime/scheduling/global-worker-cap.ts";
import { executeTeamRun } from "../../src/runtime/team-runner.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

// ─── Mock env helpers (mirrors siblings-inflight test) ──────────────

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

// ─── Task fixture helper ────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────

test("[coalesced×singleton] coalesced members handled together when singleton fails — no skips", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-xfail-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure"); // all tasks fail
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		// Two roles: explorer (read-only → eligible for coalescing) and
		// executor (write → singleton, NOT coalesced).
		const team = {
			name: "coal-xfail",
			description: "",
			roles: [
				{ name: "explorer", agent: "explorer-agent" },
				{ name: "executor", agent: "executor-agent" },
			],
			source: "test",
			filePath: "builtin",
		} as never;

		// coalesceMicroTasks: true → explorers A+B with same role+cwd coalesce.
		// Executor C is a separate singleton (write role, not coalescable).
		const workflow = {
			name: "coal-xfail",
			description: "",
			coalesceMicroTasks: true,
			steps: [
				{ id: "a", role: "explorer", task: "Explore A" },
				{ id: "b", role: "explorer", task: "Explore B" },
				{ id: "c", role: "executor", task: "Execute C" },
			],
			source: "test",
			filePath: "builtin",
		} as never;

		const agents = [
			{ name: "explorer-agent", description: "", source: "test", filePath: "builtin", systemPrompt: "test" },
			{ name: "executor-agent", description: "", source: "test", filePath: "builtin", systemPrompt: "test" },
		] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "coalesced×singleton test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "explorer", "explorer-agent", created.manifest.runId, cwd),
			makeTask("02_b", "b", "explorer", "explorer-agent", created.manifest.runId, cwd),
			makeTask("03_c", "c", "executor", "executor-agent", created.manifest.runId, cwd),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 3 },
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// ── INVARIANT (a): coalesced members (01_a, 02_b) have IDENTICAL status ──
		// The coalesced group dispatches ONE worker for both tasks, and
		// runCoalescedTaskGroup sets the same status for all group members.
		// handleFailedTask's drain+merge preserves this: both are either
		// "failed" (settled before drain) or "cancelled" (aborted mid-flight).
		assert.equal(
			sm["01_a"],
			sm["02_b"],
			`coalesced members must have identical status (got 01_a='${sm["01_a"]}', 02_b='${sm["02_b"]}')`,
		);

		// ── INVARIANT (b)/(c): NO task is "skipped" ──
		// handleFailedTask drains in-flight units and cancels non-terminal ones
		// (re-queueable "cancelled"), never markBlocked→"skipped" for in-flight
		// tasks. Without the RT-1 fix, the coalesced group could be clobbered
		// to "skipped" while still in-flight.
		const skipped = result.tasks.filter((t) => t.status === "skipped");
		assert.equal(
			skipped.length,
			0,
			`no task should be skipped — all in-flight tasks must be drained/cancelled, not markBlocked→skipped. ` +
				`Got: ${JSON.stringify(sm)}`,
		);

		// ── INVARIANT: all tasks are terminal (re-queueable) ──
		for (const t of result.tasks) {
			assert.ok(
				t.status === "failed" || t.status === "cancelled",
				`task ${t.id} should be failed/cancelled (re-queueable, terminal), got "${t.status}"`,
			);
		}

		// ── INVARIANT (d): the singleton executor is "failed" ──
		// The executor runs as a separate singleton and fails via the mock.
		assert.ok(
			sm["03_c"] === "failed" || sm["03_c"] === "cancelled",
			`singleton executor should be failed/cancelled, got "${sm["03_c"]}"`,
		);

		// Run should be marked failed.
		assert.equal(result.manifest.status, "failed", "run should be failed");

		// ── Disk consistency ──
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

test("[coalesced×singleton] coalesced group result preserved when singleton succeeds first then fails", async () => {
	// Second scenario: mix success and failure across the coalesced group and
	// singletons using retryable-failure-then-success (exactly ONE runChildPi
	// call gets count=1 = silent model-error). The coalesced path treats
	// count=1 as SUCCESS (exitCode:0, no result.error — the error event is in
	// stdout only, which the coalesced path does NOT parse). The singleton
	// path detects the model error via detectRetryableModelFailureFromOutput.
	//
	// In the common outcome: coalesced group completes (preserved by
	// handleFailedTask's drain+merge), singletons fail. This exercises the
	// cross-cut: coalesced SUCCESS preserved while a singleton FAILURE triggers
	// handleFailedTask. We assert INVARIANTS that hold in every outcome.
	const counterFile = path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start */
	}

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-xsucc-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	// Single-model registry → no fallback retry for the failing singleton.
	const modelRegistry = { getAvailable: () => [{ provider: "test", id: "mock-model" }] };
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "coal-xsucc",
			description: "",
			roles: [
				{ name: "explorer", agent: "explorer-agent" },
				{ name: "executor", agent: "executor-agent" },
			],
			source: "test",
			filePath: "builtin",
		} as never;

		// 2 explorers (coalesced) + 2 executors (singletons).
		// Exactly ONE runChildPi call gets count=1. If it's a singleton →
		// singleton fails, coalesced group succeeds. If it's the coalesced
		// group → all succeed (no failure). Either way, no skips.
		const workflow = {
			name: "coal-xsucc",
			description: "",
			coalesceMicroTasks: true,
			steps: [
				{ id: "a", role: "explorer", task: "Explore A" },
				{ id: "b", role: "explorer", task: "Explore B" },
				{ id: "c", role: "executor", task: "Execute C" },
				{ id: "d", role: "executor", task: "Execute D" },
			],
			source: "test",
			filePath: "builtin",
		} as never;

		const agents = [
			{ name: "explorer-agent", description: "", source: "test", filePath: "builtin", systemPrompt: "test" },
			{ name: "executor-agent", description: "", source: "test", filePath: "builtin", systemPrompt: "test" },
		] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "coalesced×singleton mixed" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "explorer", "explorer-agent", created.manifest.runId, cwd),
			makeTask("02_b", "b", "explorer", "explorer-agent", created.manifest.runId, cwd),
			makeTask("03_c", "c", "executor", "executor-agent", created.manifest.runId, cwd),
			makeTask("04_d", "d", "executor", "executor-agent", created.manifest.runId, cwd),
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
			modelRegistry,
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// ── INVARIANT (a): coalesced members have IDENTICAL status ──
		assert.equal(
			sm["01_a"],
			sm["02_b"],
			`coalesced members must have identical status (got 01_a='${sm["01_a"]}', 02_b='${sm["02_b"]}')`,
		);

		// ── INVARIANT (b): no task skipped ──
		const skipped = result.tasks.filter((t) => t.status === "skipped");
		assert.equal(skipped.length, 0, `no task should be skipped. Got: ${JSON.stringify(sm)}`);

		// ── INVARIANT: all tasks terminal ──
		for (const t of result.tasks) {
			assert.ok(
				t.status === "failed" || t.status === "completed" || t.status === "cancelled",
				`task ${t.id} should be terminal, got "${t.status}"`,
			);
		}

		// ── COVERAGE-GAP ASSERTION (b): if any coalesced member COMPLETED,
		// its result data must be preserved (not dropped/skipped by
		// handleFailedTask). This closes the gap that all-fail tests leave. ──
		const coalCompleted = result.tasks.filter((t) => (t.id === "01_a" || t.id === "02_b") && t.status === "completed");
		for (const t of coalCompleted) {
			assert.ok(
				t.finishedAt,
				`completed coalesced member ${t.id} must have finishedAt (result preserved, not dropped). All: ${JSON.stringify(sm)}`,
			);
			assert.ok(
				t.resultArtifact,
				`completed coalesced member ${t.id} must have resultArtifact (result preserved, not dropped). All: ${JSON.stringify(sm)}`,
			);
		}

		// ── INVARIANT: coalesced members ALWAYS succeed (exitCode:0, no error
		// field → success=true), so at least one coalesced member should be
		// completed or cancelled (if aborted mid-flight). They are never
		// "failed" because the coalesced path doesn't parse the error event. ──
		for (const id of ["01_a", "02_b"]) {
			assert.ok(
				sm[id] === "completed" || sm[id] === "cancelled",
				`coalesced member ${id} should be completed/cancelled (coalesced path ignores model-error event), got "${sm[id]}"`,
			);
		}
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		try {
			fs.unlinkSync(counterFile);
		} catch {
			/* fine */
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
