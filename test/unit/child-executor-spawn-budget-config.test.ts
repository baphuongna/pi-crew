/**
 * PR-C7 — RT-6 + RT-8 (pi-crew v0.9.56).
 *
 * RT-6: child-executor spawn-budget auto-compute must use the CONFIGURED
 * retry policy's `maxAttempts` (from `reliability.retryPolicy.maxAttempts`,
 * up to 10), NOT the hard-coded `DEFAULT_RETRY_POLICY.maxAttempts` (3). The
 * bug silently halved the spawn budget relative to the real retry ceiling
 * wrapped by `executeWithRetry` in team-runner.ts.
 *
 * RT-8: the two in-place mutation sites (`task.pendingSteers = []` and
 * `task.lifetimeUsage = {…}`) must spread before mutating so the
 * immutable-snapshot invariant (the same `TeamTaskState` object may already
 * be referenced by the `tasks` array / snapshots) is preserved.
 *
 * See docs/AUDIT-2026-07-30.md (### RT-6, ### RT-8) +
 * docs/TEST-STRATEGY-2026-07-30.md.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { invalidateConfigCache, loadConfig } from "../../src/config/config.ts";
import { DEFAULT_RETRY_POLICY } from "../../src/runtime/recovery/retry-executor.ts";
import { computeSpawnBudgetMax, resolveConfiguredMaxAttempts } from "../../src/runtime/task-runner/child-executor.ts";
import { runTeamTask, type SpawnBudget } from "../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team = {
	name: "t",
	description: "",
	source: "project",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} satisfies TeamConfig;
const workflow = {
	name: "w",
	description: "",
	source: "project",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "budget test", model: "x" }],
} satisfies WorkflowConfig;
const agent = {
	name: "a",
	description: "",
	source: "project",
	filePath: "a",
	systemPrompt: "test",
	tools: ["read"],
	extensions: [],
	systemPromptMode: "append",
	inheritProjectContext: false,
	inheritSkills: false,
} satisfies AgentConfig;

/** 3-model registry → buildConfiguredModelRouting produces 3 candidates. */
const modelRegistry = {
	getAvailable: () => [
		{ provider: "test", id: "m1" },
		{ provider: "test", id: "m2" },
		{ provider: "test", id: "m3" },
	],
};

/**
 * Drive runTeamTask's child-process branch via the mock child pi (same pattern
 * as spawn-budget.test.ts). Parameterized so RT-6 can use "retryable-failure"
 * (force all model candidates to fail) and RT-8 can use "json-success"
 * (succeed + emit usage).
 */
function withMockEnv<T>(mock: string, fn: () => Promise<T>): Promise<T> {
	const prevExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	const prevCrewRole = process.env.PI_CREW_ROLE;
	const prevTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = mock;
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	return fn().finally(() => {
		if (prevExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = prevExecute;
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
		if (prevCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = prevCrewRole;
		if (prevTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = prevTeamsRole;
	});
}

/** Write a project `.crew/config.json` setting reliability.retryPolicy.maxAttempts. */
function writeReliabilityConfig(cwd: string, maxAttempts: number): void {
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "config.json"), JSON.stringify({ reliability: { retryPolicy: { maxAttempts } } }), "utf-8");
}

// ─── RT-6: pure spawn-budget formula uses configured maxAttempts ───

test("RT-6: computeSpawnBudgetMax uses configured maxAttempts (not default 3)", () => {
	// 3 model candidates × (10 + 1) = 33. With the bug (DEFAULT_RETRY_POLICY=3)
	// this would have been 3 × (3 + 1) = 12 — silently halving the retry ceiling.
	assert.equal(computeSpawnBudgetMax(3, 10), 33, "3 candidates × (maxAttempts 10 + 1) must equal 33, not the default-based 12");
	// Sanity: the default-based value is the distinct lower bound the bug produced.
	assert.equal(computeSpawnBudgetMax(3, DEFAULT_RETRY_POLICY.maxAttempts), 12);
	// Single candidate edge case.
	assert.equal(computeSpawnBudgetMax(1, 10), 11);
});

test("RT-6: resolveConfiguredMaxAttempts reads reliability.retryPolicy.maxAttempts from project config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt6-cfg-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		writeReliabilityConfig(cwd, 10);
		invalidateConfigCache();
		// Confirm the merged config actually surfaces maxAttempts=10 (project
		// config is the base; user config does not override reliability here).
		assert.equal(loadConfig(cwd).config.reliability?.retryPolicy?.maxAttempts, 10);
		assert.equal(resolveConfiguredMaxAttempts(cwd), 10, "resolveConfiguredMaxAttempts must read the configured 10, not the default 3");
	} finally {
		invalidateConfigCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RT-6: resolveConfiguredMaxAttempts falls back to DEFAULT_RETRY_POLICY when config is unset", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt6-nocfg-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		invalidateConfigCache();
		assert.equal(
			resolveConfiguredMaxAttempts(cwd),
			DEFAULT_RETRY_POLICY.maxAttempts,
			"missing retryPolicy must fall back to the default",
		);
	} finally {
		invalidateConfigCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── RT-6: integration — runTeamTask spawn budget honors configured maxAttempts ───

test("RT-6: runTeamTask auto-computes spawn budget from configured retryPolicy.maxAttempts=10", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt6-int-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		writeReliabilityConfig(cwd, 10);
		invalidateConfigCache();
		// Sanity: the helper that feeds the spawn-budget math reads 10 here.
		assert.equal(resolveConfiguredMaxAttempts(cwd), 10);

		await withMockEnv("retryable-failure", async () => {
			const created = createRunManifest({ cwd, team, workflow, goal: "rt-6 spawn budget config" });
			const task = created.tasks[0]!;
			// max=0 → auto-compute inside runChildProcessTask.
			const spawnBudget: SpawnBudget = { count: 0, max: 0 };

			await runTeamTask({
				manifest: created.manifest,
				tasks: created.tasks,
				task,
				step: workflow.steps[0]!,
				agent,
				executeWorkers: true,
				runtimeKind: "child-process",
				workspaceId: cwd,
				modelOverride: "x",
				modelRegistry,
				spawnBudget,
			});

			// 3 candidates × (10 + 1) = 33. The buggy code (hard-coded
			// DEFAULT_RETRY_POLICY.maxAttempts=3) produced 3 × (3+1) = 12.
			assert.equal(
				spawnBudget.max,
				33,
				`auto-computed spawn budget must use configured maxAttempts=10 (3×11=33), got ${spawnBudget.max}`,
			);
		});
	} finally {
		invalidateConfigCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── RT-8: immutable-snapshot invariant — input task is not mutated ───

test("RT-8: runTeamTask does not mutate the input task object (immutable-snapshot invariant)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt8-imm-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		await withMockEnv("json-success", async () => {
			const created = createRunManifest({ cwd, team, workflow, goal: "rt-8 immutability" });
			const task = created.tasks[0]!;
			// Pre-populate mutable fields so a regression (in-place mutation
			// reaching back through the shallow spread) would be observable.
			task.lifetimeUsage = { input: 7, output: 4, cacheWrite: 2 };
			task.pendingSteers = ["pre-existing-steer"];
			// Freeze + deep snapshot: the input task object must be structurally
			// unchanged after the run (all updates land on spread copies).
			const inputSnapshot = structuredClone(task);
			Object.freeze(task);

			const result = await runTeamTask({
				manifest: created.manifest,
				tasks: created.tasks,
				task,
				step: workflow.steps[0]!,
				agent,
				executeWorkers: true,
				runtimeKind: "child-process",
				workspaceId: cwd,
				modelOverride: "x",
			});

			// The input task must be byte-for-byte unchanged.
			assert.deepEqual(task, inputSnapshot, "input task must NOT be mutated in place (immutable-snapshot invariant)");

			// And the result task must reflect the run's updates (usage parsed
			// from the json-success mock transcript) — proving the executor
			// produced changes on copies rather than the frozen input.
			const resultTask = result.tasks.find((t) => t.id === task.id);
			assert.ok(resultTask, "result must contain the task");
			assert.ok(resultTask!.usage, "result task must carry parsed usage (update on a copy)");
			assert.notDeepEqual(
				resultTask!.lifetimeUsage,
				task.lifetimeUsage,
				"result task lifetimeUsage must differ from the untouched input",
			);
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── RT-8: structural guard — the two sites spread before mutating ───
//
// The pendingSteers (onSpawn) and lifetimeUsage (onJsonEvent) mutation sites
// live inside runWorker callbacks that the synchronous mock child pi does not
// drive (onSpawn never fires in mock mode; json-success emits message_end
// without a `message.role` so the lifetimeUsage branch is skipped). Execution-
// driven coverage of these exact sites is impractical, so — following the same
// "structural source-contract test" strategy used by
// task-runner-characterization.test.ts for the R3 listener-leak contract — we
// lock that the buggy in-place forms are gone and the spread forms are present.

test("RT-8: child-executor spreads before mutating pendingSteers/lifetimeUsage (source contract)", () => {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(testDir, "..", "..", "src", "runtime", "task-runner", "child-executor.ts"), "utf-8");
	// Buggy in-place forms must be absent (these are the exact patterns the fix
	// removed — their presence would re-introduce the invariant violation).
	assert.ok(!src.includes("task.pendingSteers = [];"), "RT-8: pendingSteers must be cleared via spread, not in-place mutation");
	assert.ok(!src.includes("task.lifetimeUsage = {"), "RT-8: lifetimeUsage must be accumulated via spread, not in-place mutation");
	// Fixed spread forms must be present.
	assert.ok(src.includes("{ ...task, pendingSteers: [] }"), "RT-8: pendingSteers clear must use the spread form");
	assert.ok(src.includes("...task,") && src.includes("lifetimeUsage: {"), "RT-8: lifetimeUsage accumulation must use the spread form");
});
