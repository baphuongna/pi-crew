/**
 * RT-7 tests: writeProgress dedup cache key stability.
 *
 * Bug: the WeakMap cache was keyed on TeamRunManifest OBJECT IDENTITY, but
 * every writeProgress mutator returns a NEW object (spread) → cache NEVER hit.
 * Fix: key on manifest.runId (stable string). Also hash content once instead
 * of twice per call.
 *
 * These tests verify:
 *   1. The cache is a Map<string,string> keyed on runId (not object identity).
 *   2. Back-to-back calls with DIFFERENT manifest objects (same runId) actually
 *      hit the cache (reuse the existing progress artifact instead of writing).
 *   3. The stored cache value is a valid SHA-256 content hash.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test_resetCap, getWorkerCapCapacity } from "../../src/runtime/scheduling/global-worker-cap.ts";
import {
	__test__cancelPlanTasks,
	__test__lastProgressContentHash,
	__test__writeProgress,
	executeTeamRun,
} from "../../src/runtime/team-runner.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function makeManifest(runId: string, artifactsRoot: string): TeamRunManifest {
	return {
		runId,
		team: "test-team",
		workflow: "default",
		cwd: "/tmp/test-rt7",
		stateRoot: "/tmp/test-rt7/.crew/state",
		artifactsRoot,
		eventsPath: "/tmp/test-rt7/.crew/state/events.jsonl",
		status: "running",
		goal: "test goal",
		summary: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
		tasks: [],
	} as unknown as TeamRunManifest;
}

function makeTask(id: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		stepId: "step-1",
		role: "agent",
		agent: "default",
		status,
		goal: "test",
		taskPacket: { scope: "workspace" },
	} as unknown as TeamTaskState;
}

function makeTmpArtifactsRoot(prefix: string): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const artifactsRoot = path.join(tmpDir, "artifacts");
	fs.mkdirSync(artifactsRoot, { recursive: true });
	return artifactsRoot;
}

// ─── Tests ────────────────────────────────────────────────────────

test("[RT-7] cache is a Map (structural pin — not WeakMap)", () => {
	// WeakMap is not an instance of Map and has no .size. This structural
	// pin fails if the cache type is reverted to WeakMap.
	assert.ok(__test__lastProgressContentHash instanceof Map, "cache should be a Map, not WeakMap");
	assert.equal(typeof __test__lastProgressContentHash.size, "number");
});

test("[RT-7] cache is keyed on runId string, not manifest object identity", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-key-");
	const runId = "rt7-key-test";
	const tasks = [makeTask("task-1", "completed"), makeTask("task-2", "running")];

	const manifestA = makeManifest(runId, artifactsRoot);
	__test__writeProgress(manifestA, tasks, "test-producer");

	// After first call, cache should have an entry for the runId string.
	assert.ok(__test__lastProgressContentHash.has(runId), "cache should have entry for runId string after first writeProgress call");

	// Simulate what mutators do: spread to create a NEW object (same runId).
	const manifestB = { ...manifestA };
	assert.notEqual(manifestA, manifestB, "manifestB should be a different object");
	assert.equal(manifestA.runId, manifestB.runId, "runId should be the same");

	// The cache entry persists because it's keyed on the string runId,
	// not the object identity. With the old WeakMap this would NOT find
	// the entry for manifestB (different object).
	assert.ok(
		__test__lastProgressContentHash.has(manifestB.runId),
		"cache should find entry via runId even with different manifest object",
	);

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

test("[RT-7] cache hits when content is identical (forced same timestamp)", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-hit-");
	const runId = "rt7-hit-test";
	const tasks = [makeTask("task-1", "completed")];

	// writeProgress embeds `new Date().toISOString()` in the rendered content.
	// Two back-to-back calls can straddle a millisecond boundary (writeArtifact
	// file I/O takes ~5ms), so the dedup cache would miss on different
	// timestamps. Mock Date to guarantee identical content → identical hash.
	const fixedMs = 1_735_900_800_000; // 2025-01-03T12:00:00.000Z
	const RealDate = globalThis.Date;
	const MockDate = class extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) {
				super(fixedMs);
			} else {
				super(...(args as [string | number | Date]));
			}
		}
		static now() {
			return fixedMs;
		}
	} as unknown as DateConstructor;
	globalThis.Date = MockDate;

	try {
		// First call: cache miss (empty cache) → writeArtifact creates a new
		// progress artifact descriptor.
		const manifestA = makeManifest(runId, artifactsRoot);
		const result1 = __test__writeProgress(manifestA, tasks, "test-producer");

		// Second call: manifestB is a NEW object (different identity) but same
		// runId. Both calls produce identical content (same timestamp via mock)
		// → identical hash → cache HIT.
		const manifestB = { ...result1 };
		const result2 = __test__writeProgress(manifestB, tasks, "test-producer");
		const progressArtifact2 = result2.artifacts.find((a) => a.kind === "progress");
		assert.ok(progressArtifact2, "second call should produce a progress artifact");

		// RT-7a: cache hit now creates a FRESH descriptor (refreshed createdAt)
		// instead of reusing the stale existing reference. The fresh descriptor
		// is a NEW object (not the same reference) but preserves the immutable
		// fields (path/contentHash/kind).
		const existingInB = manifestB.artifacts.find((a) => a.kind === "progress");
		assert.ok(existingInB, "manifestB should carry the progress artifact from result1");
		assert.notStrictEqual(
			progressArtifact2,
			existingInB,
			"cache hit should create a fresh descriptor (RT-7a), not reuse the stale reference",
		);
		assert.equal(progressArtifact2.path, existingInB.path, "fresh descriptor should preserve path");
		assert.equal(progressArtifact2.contentHash, existingInB.contentHash, "fresh descriptor should preserve contentHash");
		assert.equal(progressArtifact2.kind, existingInB.kind, "fresh descriptor should preserve kind");
	} finally {
		globalThis.Date = RealDate;
	}

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

test("[RT-7] cache stores valid SHA-256 content hash per runId", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-hash-");
	const runId = "rt7-hash-test";

	const manifest = makeManifest(runId, artifactsRoot);
	__test__writeProgress(manifest, [], "test-producer");

	const cachedHash = __test__lastProgressContentHash.get(runId);
	assert.ok(cachedHash, "cached hash should exist after writeProgress call");
	assert.equal(cachedHash!.length, 64, "SHA-256 hex digest should be 64 chars");
	assert.match(cachedHash!, /^[0-9a-f]{64}$/, "should be a valid hex digest");

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

// ─── Mock-Date helper (RT-7a) ──────────────────────

/** Mock global Date to a fixed epoch ms for the duration of `fn`. */
function withFixedDate<T>(fixedMs: number, fn: () => T): T {
	const RealDate = globalThis.Date;
	const MockDate = class extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) {
				super(fixedMs);
			} else {
				super(...(args as [string | number | Date]));
			}
		}
		static now() {
			return fixedMs;
		}
	} as unknown as DateConstructor;
	globalThis.Date = MockDate;
	try {
		return fn();
	} finally {
		globalThis.Date = RealDate;
	}
}

// ─── Mock-env helpers (RT-7b E2E) ─────────────────

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
	};
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
}

/** Build a fuller task fixture for the E2E run (needs graph/stepId/role). */
function makeRunTask(id: string, stepId: string, runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		stepId,
		role: "worker",
		agent: "worker",
		title: id,
		status: "queued",
		dependsOn: [],
		cwd,
		graph: { taskId: id, children: [], dependencies: [], queue: "ready" },
	} as unknown as TeamTaskState;
}

// ─── RT-7a: fresh createdAt on skip-reuse ─────────────────────────

test("[RT-7a] progress descriptor createdAt is fresh (not stale) after a skip-reuse", () => {
	const artifactsRoot = makeTmpArtifactsRoot("rt7-stale-");
	const runId = "rt7-stale-test";
	const tasks = [makeTask("task-1", "completed")];

	// Fix Date so the rendered content (incl. the `Updated:` timestamp) is
	// byte-identical across both calls → the content hash matches → cache HIT
	// on the second call. Both calls therefore render the same timestamp T_now.
	const fixedMs = 1_735_900_800_000; // T_now

	withFixedDate(fixedMs, () => {
		// Call 1: natural write — populates the cache (runId→H) and stamps the
		// descriptor createdAt = T_now.
		const manifest = makeManifest(runId, artifactsRoot);
		const result1 = __test__writeProgress(manifest, tasks, "test-producer");
		const progressAfterFirst = result1.artifacts.find((a) => a.kind === "progress");
		assert.ok(progressAfterFirst, "first call should produce a progress artifact");

		// Simulate a STALE descriptor: the existing descriptor's createdAt is now
		// in the past (as if it had survived from a much earlier write). This is
		// the bug RT-7a fixes — the skip-reuse path used to return THIS stale ref.
		const staleTime = new Date(fixedMs - 60_000).toISOString(); // T0 = 1 min ago
		const manifestB = { ...result1 };
		const staleDescriptor = manifestB.artifacts.find((a) => a.kind === "progress")!;
		staleDescriptor.createdAt = staleTime;

		// Call 2: same content (Date fixed) → cache HIT.
		// BUG: returned the stale descriptor (createdAt = staleTime).
		// FIX (RT-7a): returns a FRESH descriptor (createdAt = T_now).
		const result2 = __test__writeProgress(manifestB, tasks, "test-producer");
		const progressAfterSecond = result2.artifacts.find((a) => a.kind === "progress");
		assert.ok(progressAfterSecond, "second call should produce a progress artifact");

		const nowIso = new Date(fixedMs).toISOString();
		assert.notEqual(progressAfterSecond.createdAt, staleTime, "createdAt must NOT be the stale value after a skip-reuse (RT-7a)");
		assert.equal(
			progressAfterSecond.createdAt,
			nowIso,
			"createdAt should reflect the actual write time (T_now), not the first-write time",
		);
	});

	fs.rmSync(path.dirname(artifactsRoot), { recursive: true, force: true });
});

// ─── RT-7b: cache entry cleared after run completion ──────────────

test("[RT-7b] lastProgressContentHash entry is cleared after run completion", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt7b-cleanup-"));
	const prevEnv = saveMockEnv();
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(2);
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "rt7b-cleanup",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "rt7b-cleanup",
			description: "",
			steps: [{ id: "a", role: "worker", task: "A" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "RT-7b cleanup test" });
		const runId = created.manifest.runId;
		const tasks: TeamTaskState[] = [makeRunTask("01_a", "a", runId, cwd)];
		saveRunTasks(created.manifest, tasks);

		// Before the run, no cache entry for this runId yet.
		assert.equal(__test__lastProgressContentHash.has(runId), false, "no cache entry should exist for runId before the run starts");

		await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 1 },
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		// writeProgress runs unconditionally during the run (executeTeamRunCore),
		// so the entry WAS populated. After the run, the finally block must have
		// cleared it — otherwise the module-level Map leaks one entry per run.
		assert.equal(
			__test__lastProgressContentHash.has(runId),
			false,
			"cache entry must be cleared after run completion (RT-7b) — Map must not leak per-run entries",
		);
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── RT-14: consolidation preserves site-specific logic ──────────

test("[RT-14] cancelPlanTasks cancels only non-terminal tasks and preserves graph mutation", () => {
	const tasks: TeamTaskState[] = [
		{ ...makeTask("queued-1", "queued"), graph: { taskId: "queued-1", queue: "ready", children: [], dependencies: [] } } as never,
		{ ...makeTask("running-1", "running"), graph: { taskId: "running-1", queue: "ready", children: [], dependencies: [] } } as never,
		{
			...makeTask("completed-1", "completed"),
			graph: { taskId: "completed-1", queue: "done", children: [], dependencies: [] },
		} as never,
	];

	const result = __test__cancelPlanTasks(tasks, "Plan approval was cancelled.");

	// Non-terminal tasks (queued/running) are cancelled.
	assert.equal(result[0].status, "cancelled", "queued task should be cancelled");
	assert.equal(result[1].status, "cancelled", "running task should be cancelled");
	assert.equal(result[0].error, "Plan approval was cancelled.", "cancelled task should carry the reason");
	// Graph mutation preserved: queue moved to "done".
	assert.equal(result[0].graph?.queue, "done", "graph queue should be mutated to 'done' for cancelled tasks");
	assert.equal(result[1].graph?.queue, "done", "graph queue should be mutated to 'done' for cancelled tasks");

	// Terminal tasks are left untouched.
	assert.equal(result[2].status, "completed", "completed task should be unchanged");
	assert.equal(result[2].graph?.queue, "done", "terminal task graph should be unchanged");
});

test("[RT-14] both inline cancel sites delegate to cancelNonTerminalTasks (structural pin)", () => {
	const srcPath = path.resolve(import.meta.dirname, "../../src/runtime/team-runner.ts");
	const src = fs.readFileSync(srcPath, "utf-8");

	// cancelPlanTasks now routes through the shared helper.
	const planIdx = src.indexOf("function cancelPlanTasks(");
	assert.ok(planIdx > 0, "cancelPlanTasks should be defined");
	const planBody = src.slice(planIdx, src.indexOf("}", src.indexOf("return cancelNonTerminalTasks", planIdx)));
	assert.match(planBody, /return cancelNonTerminalTasks\(/, "cancelPlanTasks should delegate to cancelNonTerminalTasks (RT-14)");
	assert.match(planBody, /queue: "done"/, "cancelPlanTasks should preserve the graph mutation (queue: 'done')");

	// cancelRunFromSignal now routes through the shared helper too.
	const sigIdx = src.indexOf("async function cancelRunFromSignal(");
	assert.ok(sigIdx > 0, "cancelRunFromSignal should be defined");
	const sigBody = src.slice(sigIdx, sigIdx + 1200);
	assert.match(
		sigBody,
		/cancelNonTerminalTasks\(ctx\.tasks, "cancelled", message/,
		"cancelRunFromSignal should delegate to cancelNonTerminalTasks (RT-14)",
	);
	// Extra logic preserved: terminalEvidence synthesis for running workers +
	// cancelledTaskIds collection.
	assert.match(
		sigBody,
		/buildSyntheticTerminalEvidence\("worker", cancelReason, task\.startedAt\)/,
		"cancelRunFromSignal should preserve terminalEvidence synthesis for running workers",
	);
	assert.match(sigBody, /cancelledTaskIds\.push\(task\.id\)/, "cancelRunFromSignal should preserve cancelledTaskIds collection");
});
