/**
 * Characterization tests for runTeamTask (CORE-5).
 *
 * PURPOSE: Lock CURRENT behavior of the `runTeamTask` god function
 * (`src/runtime/task-runner.ts`, ~1215 LOC, ~145-1360) BEFORE the Sprint 5
 * CORE-5 refactor (split into `task-runner/child-executor.ts` +
 * `pre/post-execution.ts`; `live-executor.ts` is already extracted).
 * After refactor, these same tests must still pass — any failure indicates a
 * behavioral regression.
 *
 * These tests assert CURRENT behavior, even if it has known quirks. They are
 * NOT bug fixes — they are a Phase 0 safety net.
 *
 * Strategy: call the `runTeamTask` PUBLIC API directly (the unit under
 * refactor), driving the child-process branch via `PI_TEAMS_MOCK_CHILD_PI`
 * (same pattern as CORE-4's team-runner-characterization.test.ts) and the
 * scaffold branch via `executeWorkers:false`. Assert on the returned task
 * status, modelAttempts, artifacts, verification evidence, and the
 * events.jsonl stream.
 *
 * Branches covered (per task-runner.ts layout):
 *   - Cancel-before-start early return (:~241)
 *   - Child-process branch (:~414-879) — happy path, model fallback, guards
 *   - Scaffold branch (:~993-1006)
 *   - Shared pre-step (:~145-398) + post-execution (:~1010-1360)
 *
 * SKIPPED (cannot be driven reliably with the synchronous mock — see per-
 * scenario notes): real wall-clock timeout, external-abort mid-task, and the
 * live-session yield path (requires a real live Pi session). For those, the
 * R3 risk (listener/timeout leak) is locked via a structural source-contract
 * test — the same fallback strategy used by task-runner-prestep-guard.test.ts
 * and child-pi-steer-backpressure.test.ts when execution-driven coverage is
 * impractical.
 *
 * Commit under test: c782c6d (pi-crew v0.9.51, pre-CORE-5-refactor).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { runTeamTask } from "../../src/runtime/task-runner.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig, WorkflowStep } from "../../src/workflows/workflow-config.ts";

// ─── Shared fixtures ────────────────────────────────────────────────

const team: TeamConfig = {
	name: "char-core5",
	description: "characterization",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const agent: AgentConfig = {
	name: "worker",
	description: "characterization worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

/** A default single-step workflow; callers spread in step overrides. */
function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
	return { id: "s", role: "worker", task: "Do the task", source: "builtin", ...overrides };
}

function workflowOf(steps: WorkflowStep[]): WorkflowConfig {
	return { name: "w", description: "char", source: "builtin", filePath: "builtin", steps };
}

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

function setMockEnv(mode: string | undefined): void {
	if (mode === undefined) {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		delete process.env.PI_CREW_ALLOW_MOCK;
	} else {
		process.env.PI_TEAMS_MOCK_CHILD_PI = mode;
		process.env.PI_CREW_ALLOW_MOCK = "1";
	}
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
}

/** Create a temp workspace + manifest + the default task. */
function makeFixture(opts: { workflow: WorkflowConfig; goal?: string } = { workflow: workflowOf([step()]) }) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-core5-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow: opts.workflow, goal: opts.goal ?? "characterization" });
	return { cwd, created };
}

/** Find the run task (the one created from the workflow step) in the result. */
function runTask(result: { manifest: TeamRunManifest; tasks: TeamTaskState[] }, id: string): TeamTaskState {
	const t = result.tasks.find((x) => x.id === id);
	assert.ok(t, `task ${id} must exist in result`);
	return t!;
}

/** Event-type tally for quick assertions. */
function eventTypes(eventsPath: string): string[] {
	return readEvents(eventsPath).map((e) => e.type);
}

// ─── Scenario 1: Cancel before start ───────────────────────────────

test("[char-core5-1] cancel-before-start: pre-aborted signal → task cancelled, no spawn, no task.* events", async () => {
	const { cwd, created } = makeFixture({ workflow: workflowOf([step()]), goal: "cancel" });
	try {
		// A pre-aborted run-level signal triggers the early return at the top of
		// runTeamTask, BEFORE any state is persisted or a worker is spawned.
		const controller = new AbortController();
		controller.abort({ code: "leader_interrupted", message: "leader cancelled run" });

		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: created.tasks[0]!.stepId ? step() : step(),
			agent,
			executeWorkers: true,
			signal: controller.signal,
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		// Lock: status flips to cancelled with the signal's reason surfaced.
		assert.equal(t.status, "cancelled", "pre-aborted signal must cancel the task");
		assert.equal(t.error, "leader_interrupted: leader cancelled run");
		assert.ok(t.finishedAt, "cancelled task must set finishedAt");

		// Lock: the early return happens BEFORE artifact writes — no worker
		// artifacts (prompt/result/...) are appended to the manifest.
		assert.equal(result.manifest.artifacts.length, 0, "cancel-before-start must not write any artifacts");

		// Lock: the early return happens BEFORE the task.started event append —
		// no task.* lifecycle events are emitted for a pre-aborted task. (The
		// events file itself exists because createRunManifest wrote run.created.)
		const types = eventTypes(created.manifest.eventsPath);
		assert.ok(!types.includes("task.started"), "must NOT emit task.started on cancel-before-start");
		assert.ok(!types.some((ty) => ty.startsWith("task.")), `must NOT emit any task.* event, got: ${types.join(",")}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 2: Child-process happy path ──────────────────────────

test("[char-core5-2] child-process happy path: mock exit 0 + JSON output → completed, result artifact written", async () => {
	const { cwd, created } = makeFixture({ workflow: workflowOf([step()]), goal: "happy" });
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true, // resolves runtimeKind to "child-process"
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "child-process mock success must complete the task");
		assert.equal(t.error, undefined);
		assert.ok(t.finishedAt, "completed task must set finishedAt");

		// Lock: exactly one model attempt, marked successful (no fallback used).
		assert.ok(t.modelAttempts && t.modelAttempts.length === 1, "happy path records exactly 1 model attempt");
		assert.equal(t.modelAttempts![0]!.success, true);
		assert.equal(t.modelAttempts![0]!.exitCode, 0);

		// Lock: a result artifact (.txt for child-process) is written and
		// linked on the task.
		assert.ok(t.resultArtifact, "task must carry a resultArtifact descriptor");
		assert.ok(
			t.resultArtifact!.path.replaceAll("\\", "/").endsWith("results/01_s.txt"),
			`child-process result artifact path must be results/01_s.txt, got: ${t.resultArtifact!.path}`,
		);
		assert.ok(fs.existsSync(t.resultArtifact!.path), "result artifact file must exist on disk");

		// Lock: the task.completed terminal event is emitted.
		const types = eventTypes(created.manifest.eventsPath);
		assert.ok(types.includes("task.started"), "must emit task.started");
		assert.ok(types.includes("task.completed"), "must emit task.completed");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 3: Child-process yield contract EXCLUDED ─────────────

test("[char-core5-3] yield-exclusion: child-process task with NO submit_result stays completed (not needs_attention)", async () => {
	// CURRENT behavior: the yield-based completion contract only applies to
	// live-session workers (collectYieldEvents = runtimeKind !== "child-process").
	// Child-process workers have no submit_result tool, so a child worker that
	// produces valid output WITHOUT calling submit_result must complete normally
	// — it must NOT be marked needs_attention for "no yield". The CORE-5
	// refactor must preserve this exclusion, or every child worker would flip
	// to needs_attention.
	const { cwd, created } = makeFixture({ workflow: workflowOf([step()]), goal: "yield-exclusion" });
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		// The json-success mock never emits a submit_result event, yet the task
		// completes — proving the yield gate is skipped for child-process.
		assert.equal(t.status, "completed", "child-process must not flag needs_attention for missing submit_result");

		const types = eventTypes(created.manifest.eventsPath);
		assert.ok(
			!types.includes("task.needs_attention"),
			"child-process must NOT emit task.needs_attention for a no-submit_result run",
		);
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 4: Model fallback chain ──────────────────────────────

test("[char-core5-4] model-fallback: retryable failure on attempt 1 → attempt 2 succeeds → modelAttempts has 2 entries", async () => {
	// Mock `retryable-failure-then-success`: invocation #1 returns a silent
	// retryable failure (exit 0, message_end errorMessage matching the
	// retryable pattern, no real text); invocation #2+ returns json-success.
	// With a 2-model registry, buildConfiguredModelRouting produces 2 candidates
	// so the failed attempt #1 routes to candidate #2 and succeeds.
	const counterFile = path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start */
	}
	const { cwd, created } = makeFixture({ workflow: workflowOf([step()]), goal: "fallback" });
	const prev = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
	};
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			// Force a bogus model that is filtered out, leaving the registry
			// candidates as the fallback chain.
			modelOverride: "x",
			modelRegistry,
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "fallback chain must recover and complete");

		// Lock: exactly 2 attempts recorded — fail then succeed.
		assert.ok(t.modelAttempts && t.modelAttempts.length === 2, `expected 2 attempts, got ${t.modelAttempts?.length}`);
		const [first, second] = t.modelAttempts!;
		assert.equal(first.success, false, "first attempt must be a failure");
		assert.match(first.error ?? "", /provider[_ ]?error/i, "first attempt error must be retryable");
		assert.equal(second.success, true, "second attempt must succeed");
		assert.ok(!second.error, "second attempt must have no error");

		// Lock: the two attempts used DIFFERENT models (the chain rotated).
		assert.notEqual(first.model, second.model, "fallback chain must rotate to a different model");

		// Lock: modelRouting reflects the fallback (usedAttempt=1, resolved=2nd model).
		assert.ok(t.modelRouting, "task must carry modelRouting");
		assert.equal(t.modelRouting!.usedAttempt, 1, "usedAttempt must point at the successful attempt");
		assert.equal(t.modelRouting!.resolved, second.model);
		assert.deepEqual(t.modelRouting!.fallbackChain, ["openai-codex/gpt-5.5", "openai-codex/gpt-5-mini"]);
	} finally {
		restoreMockEnv(prev);
		try {
			fs.unlinkSync(counterFile);
		} catch {
			/* fine if already gone */
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 5: Mutation guard — warn mode (default) ──────────────

test("[char-core5-5] mutation-guard(warn): executor role, no mutation tool call → completed + needs_attention activity + task.attention event", async () => {
	// CURRENT behavior (default mutationGuardMode="warn"): an implementation-
	// style role (executor) that completes WITHOUT an observed mutation tool
	// call keeps status="completed" but flips agentProgress.activityState to
	// "needs_attention" and emits a task.attention event with reason
	// "completion_guard". The task is NOT failed (warn is advisory).
	const { cwd, created } = makeFixture({
		workflow: workflowOf([step({ role: "executor", task: "Implement feature X" })]),
		goal: "mutation-warn",
	});
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step({ role: "executor", task: "Implement feature X" }),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		// warn mode: status stays completed.
		assert.equal(t.status, "completed", "warn mode must not fail the task");
		// but the activity state flags attention.
		assert.equal(t.agentProgress?.activityState, "needs_attention", "warn mode must flag needs_attention activity");

		const attention = readEvents(created.manifest.eventsPath).filter((e) => e.type === "task.attention");
		assert.ok(attention.length >= 1, "must emit at least one task.attention event");
		const guardAttention = attention.find((e) => e.data?.reason === "completion_guard");
		assert.ok(guardAttention, "must emit a task.attention with reason=completion_guard");
		assert.equal(guardAttention!.data?.activityState, "needs_attention");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 6: Mutation guard — fail mode ────────────────────────

test("[char-core5-6] mutation-guard(fail): completionMutationGuard='fail' → task failed, exit 1, last attempt marked failed", async () => {
	// CURRENT behavior (mutationGuardMode="fail"): the same no-mutation
	// completion flips the task to FAILED, sets a structured error, bumps
	// exitCode to 1, and rewrites the last modelAttempt to success=false.
	const { cwd, created } = makeFixture({
		workflow: workflowOf([step({ role: "executor", task: "Implement feature X" })]),
		goal: "mutation-fail",
	});
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step({ role: "executor", task: "Implement feature X" }),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			runtimeConfig: { completionMutationGuard: "fail" },
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "failed", "fail mode must fail the task");
		assert.match(t.error ?? "", /Completion mutation guard failed/i);
		assert.equal(t.exitCode, 1, "fail mode must bump exitCode to 1");

		// Lock: the last modelAttempt is rewritten to success=false with the guard error.
		const last = t.modelAttempts?.at(-1);
		assert.ok(last, "must have modelAttempts");
		assert.equal(last!.success, false, "fail mode must mark the last attempt unsuccessful");
		assert.ok(last!.error && /Completion mutation guard failed/i.test(last!.error), "last attempt error must carry the guard message");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 7: Verification contract (step.verify) ───────────────

test("[char-core5-7] verification-contract: step.verify=true → requiredGreenLevel 'targeted', satisfied on completed child task", async () => {
	// CURRENT behavior: defaultVerificationContract maps step.verify=true to
	// requiredGreenLevel="targeted" with commands=[]. Because the standard
	// buildTaskPacket path ALWAYS yields commands=[], the command-execution
	// block in runTeamTask is skipped; verification falls back to base
	// evidence, which infers observedGreenLevel from task success
	// (allowManualEvidence=true → inferred level = required level). So a
	// completed child task with verify=true yields satisfied=true at the
	// "targeted" level. (The "commands run and pass" sub-path is unreachable
	// via runTeamTask's task packet — commands are never populated there — so
	// this characterizes the actually-reachable behavior.)
	const { cwd, created } = makeFixture({
		workflow: workflowOf([step({ verify: true })]),
		goal: "verify",
	});
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step({ verify: true }),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed");
		assert.ok(t.verification, "task must carry verification evidence");
		assert.equal(t.verification!.requiredGreenLevel, "targeted", "step.verify=true → requiredGreenLevel 'targeted'");
		assert.equal(t.verification!.observedGreenLevel, "targeted", "completed task infers observed=targeted");
		assert.equal(t.verification!.satisfied, true, "completed task satisfies the targeted contract");
		// Lock: no commands were actually executed (commands array stays empty
		// in the standard path — characterize this so a refactor that suddenly
		// runs commands is caught).
		assert.equal(t.verification!.commands.length, 0, "standard task packet yields no executed verification commands");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 8: Scaffold branch ───────────────────────────────────

test("[char-core5-8] scaffold-branch: executeWorkers=false → completed, .md result, verification skipped with scaffold note", async () => {
	// CURRENT behavior: the scaffold branch writes a placeholder .md result,
	// never spawns a worker, and the verification block notes "Safe scaffold
	// mode; verification commands were not executed." with requiredGreenLevel
	// from the default contract (none, since step.verify is unset).
	const { cwd, created } = makeFixture({ workflow: workflowOf([step()]), goal: "scaffold" });
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: false,
			runtimeKind: "scaffold",
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "scaffold run completes without a worker");
		assert.ok(t.resultArtifact, "scaffold writes a result artifact");
		assert.ok(
			t.resultArtifact!.path.replaceAll("\\", "/").endsWith("results/01_s.md"),
			`scaffold result artifact is a .md placeholder, got: ${t.resultArtifact!.path}`,
		);
		// No model attempts in scaffold mode (no worker spawn).
		assert.ok(!t.modelAttempts || t.modelAttempts.length === 0, "scaffold must not record model attempts");

		assert.ok(t.verification, "scaffold task carries verification evidence");
		assert.equal(t.verification!.requiredGreenLevel, "none");
		assert.match(
			t.verification!.notes ?? "",
			/Safe scaffold mode/i,
			"scaffold verification note must state commands were not executed",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 9: Mutation guard — 'off' disables the guard ─────────

test("[char-core5-9] mutation-guard(off): completionMutationGuard='off' → no completion_guard attention (guard disabled)", async () => {
	// CURRENT behavior: mutationGuardMode="off" short-circuits
	// evaluateCompletionMutationGuard entirely (the ternary yields undefined),
	// so an executor role that completes without a mutation tool call emits NO
	// task.attention event with reason=completion_guard.
	//
	// NOTE: the json-success mock output also fails the executor *output-format*
	// validation (a SEPARATE concern emitting task.output_validation), so we
	// assert specifically on the completion_guard attention event — the
	// mutation guard's signature — rather than on activityState, which the
	// output validator may independently set. This isolates the guard opt-out
	// so a refactor can't silently re-enable it.
	const { cwd, created } = makeFixture({
		workflow: workflowOf([step({ role: "executor", task: "Implement feature X" })]),
		goal: "mutation-off",
	});
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step({ role: "executor", task: "Implement feature X" }),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			runtimeConfig: { completionMutationGuard: "off" },
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "off mode keeps the task completed");
		const guardAttention = readEvents(created.manifest.eventsPath).filter(
			(e) => e.type === "task.attention" && e.data?.reason === "completion_guard",
		);
		assert.equal(guardAttention.length, 0, "off mode must NOT emit a completion_guard attention event");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 10: Read-only role never trips the mutation guard ────

test("[char-core5-10] mutation-guard(read-only): analyst role with no mutation → completed, no completion_guard attention", async () => {
	// CURRENT behavior: the mutation guard only fires for MUTATING_ROLES
	// (executor, test-engineer). A read-only role that produces output without
	// mutations completes cleanly — no completion_guard attention event.
	//
	// We use the `analyst` role specifically because it is read-only
	// (READ_ONLY_ROLES) AND has no role-specific output-format pattern, so the
	// only possible mutation-guard signal is the guard itself. This pins the
	// role classification so the guard isn't accidentally widened.
	const { cwd, created } = makeFixture({
		workflow: workflowOf([step({ role: "analyst", task: "Analyze the codebase" })]),
		goal: "mutation-readonly",
	});
	const prev = saveMockEnv();
	setMockEnv("json-success");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step({ role: "analyst", task: "Analyze the codebase" }),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		});

		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed");
		assert.notEqual(t.agentProgress?.activityState, "needs_attention", "read-only analyst must stay clear of any attention");
		const guardAttention = readEvents(created.manifest.eventsPath).filter(
			(e) => e.type === "task.attention" && e.data?.reason === "completion_guard",
		);
		assert.equal(guardAttention.length, 0, "read-only role must not emit a completion_guard attention event");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 11 (structural, R3): timeout + external-abort listener lifecycle ──

test("[char-core5-11] abort-lifecycle (R3 source-contract): timeout handle + external-abort listener are cleaned up in finally", () => {
	// WHY STRUCTURAL: the wall-clock timeout (taskTimeoutMs) and external
	// run-level abort both interrupt runWorker mid-spawn. The PI_TEAMS_MOCK
	// mock returns synchronously, so neither a real timeout nor a mid-task
	// external abort can be driven reliably at the unit level (aborting after
	// runTeamTask returns is too late; the mock never awaits anything the
	// signal can interrupt). This mirrors the fallback strategy in
	// task-runner-prestep-guard.test.ts and child-pi-steer-backpressure.test.ts.
	//
	// The CORE-5 roadmap flags this as risk R3: "CORE-5 timeout/listener leak
	// → assert externalAbortListener removed". The W2 fix deliberately removes
	// the listener in a finally block because { once: true } only auto-removes
	// when the listener FIRES — if the timeout fires first, the listener
	// leaks onto the long-lived run-level signal. We lock the structural
	// contract that the finally cleanup exists, so the child-executor.ts
	// extraction must carry it forward.
	//
	// POST-CORE-5 NOTE: this branch moves into task-runner/child-executor.ts.
	// When it does, update the `readFileSync` path below to the new location —
	// the cleanup-in-finally CONTRACT must still hold there. (This is a Phase-0
	// source-contract pin on the CURRENT task-runner.ts location, not an
	// execution test; it is expected to be relocated, not deleted.)
	const src = readFileSync("src/runtime/task-runner.ts", "utf-8");

	// 1. The timeout controller is created and armed only when taskTimeoutMs > 0.
	assert.match(src, /taskTimeoutMs\s*=\s*input\.runtimeConfig\?\.taskTimeoutMs/, "taskTimeoutMs is read from runtimeConfig");
	assert.match(src, /if\s*\(taskTimeoutMs\s*>\s*0\s*&&\s*!timeoutController\.signal\.aborted\)/, "setTimeout is guarded by taskTimeoutMs > 0");

	// 2. The external-abort listener links input.signal → timeoutController,
	//    registered with { once: true }.
	assert.match(src, /externalAbortListener\s*=\s*\(\)\s*=>\s*timeoutController\.abort/, "externalAbortListener links the run signal to the timeout controller");
	assert.match(src, /input\.signal\.addEventListener\(\s*["']abort["']\s*,\s*externalAbortListener\s*,\s*\{\s*once:\s*true\s*\}\s*\)/, "listener registered with { once: true }");

	// 3. R3 — the finally block MUST clear the timeout AND remove the listener.
	//    (clearTimeout + removeEventListener). Lock both, in that the finally
	//    block contains them.
	assert.match(src, /if\s*\(timeoutHandle\)\s*clearTimeout\(timeoutHandle\)/, "finally must clearTimeout(timeoutHandle)");
	assert.match(
		src,
		/if\s*\(externalAbortListener\s*&&\s*input\.signal\)\s*\{[\s\S]*?input\.signal\.removeEventListener\(\s*["']abort["']\s*,\s*externalAbortListener\s*\)/,
		"finally must removeEventListener('abort', externalAbortListener) — R3 listener-leak fix",
	);

	// 4. The listener is removed REGARDLESS of whether the timeout fired, i.e.
	//    the removeEventListener sits inside the same finally as the runWorker
	//    await. Confirm removeEventListener comes after the runWorker call and
	//    inside the try/finally wrapping the for-loop body.
	const listenerRegisterIdx = src.indexOf("input.signal.addEventListener(");
	const removeIdx = src.indexOf("input.signal.removeEventListener(");
	assert.ok(listenerRegisterIdx > 0 && removeIdx > listenerRegisterIdx, "removeEventListener must come after addEventListener");
});

// ─── Scenarios explicitly NOT covered here (documented for the refactor) ──
//
// The following were considered and deliberately SKIPPED because they cannot
// be driven reliably with the synchronous PI_TEAMS_MOCK_CHILD_PI mock, OR are
// already locked elsewhere. They are listed so the CORE-5 refactor author
// knows the gap and can add execution-driven coverage if a better seam appears:
//
// • Real wall-clock timeout (taskTimeoutMs fires) → task failed:
//     The mock returns before the timeout can fire. Locked structurally in
//     [char-core5-11] (R3). A reliable execution test would require a mock
//     that hangs until the signal aborts, which child-pi.ts does not provide.
//
// • External run-level abort mid-task → task cancelled:
//     Same synchronous-mock limitation. Aborting input.signal after
//     runTeamTask returns is a no-op; aborting before the call is caught by
//     the cancel-before-start early return. Locked structurally in [char-core5-11].
//
// • Live-session yield (no submit_result → needs_attention):
//     The live-session branch delegates to runLiveTask → runLiveSessionTask,
//     which needs a real live Pi session. collectYieldEvents is false for
//     child-process, so the child-process yield-exclusion is locked in
//     [char-core5-3] instead.
//
// • Pre-step script guard (F-02):
//     Already exhaustively covered by test/unit/task-runner-prestep-guard.test.ts
//     (predicate logic + source-contract placement + event registration).
