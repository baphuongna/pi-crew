/**
 * P2-1 (pi 1.0.4 adoption, 2026-10-07): consumer tests for the retry-triage
 * classifier seam in child-executor's model-fallback attempt loop.
 *
 * Drives the REAL runTeamTask public API with PI_TEAMS_MOCK_CHILD_PI=
 * "retryable-failure-then-success" (attempt 1 = silent retryable failure,
 * attempt 2+ = success — same pattern as task-runner-characterization.test.ts
 * scenario 4) plus a FAKE modelRegistry exposing both surfaces:
 *   - chat surface (getAvailable → 2 models → 2-candidate fallback chain)
 *   - classifier surface (getAvailableOfType("classifier") + classify)
 *
 * Contract under test:
 *   - default-off (runtime.classifierEnabled absent) → classify NEVER called,
 *     retry proceeds exactly as before (zero behavior change)
 *   - enabled + classifier answers PERMANENT → queued retry skipped
 *     (1 attempt, task.retry_triage event decision=permanent)
 *   - enabled + classifier answers TRANSIENT → retry proceeds
 *     (2 attempts, task.retry_triage event decision=transient)
 *   - enabled + no credentialed classifier → fallback decision (retry
 *     proceeds) and NO retry_triage event (fallback did not inform a decision)
 *   - helper-level: enabled=false short-circuits before ANY registry access
 *
 * NOTE (worker-env gotcha, knowledge.md 2026-08-15): ambient PI_CREW_* vars
 * from the worker harness are scrubbed per-case so the config-only path is
 * what's under test.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { triageRetryWithClassifier } from "../../../../src/runtime/task-runner/child-executor.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig, WorkflowStep } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Shared fixtures (task-runner-characterization.test.ts pattern) ─────

const team: TeamConfig = {
	name: "retry-triage",
	description: "classifier consumer",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const agent: AgentConfig = {
	name: "worker",
	description: "retry-triage worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function step(): WorkflowStep {
	return { id: "s", role: "worker", task: "Do the task", source: "builtin" };
}

const workflow: WorkflowConfig = { name: "w", description: "triage", source: "builtin", filePath: "builtin", steps: [step()] };

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
	classifierEnabled: string | undefined;
	classifierModel: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
		// Scrub the P2-1 env overrides so config is the only input under test
		// (worker harness may leak PI_CREW_* — knowledge.md 2026-08-15).
		classifierEnabled: process.env.PI_CREW_CLASSIFIER_ENABLED,
		classifierModel: process.env.PI_CREW_CLASSIFIER_MODEL,
	};
}

function setMockEnv(mode: string): void {
	process.env.PI_TEAMS_MOCK_CHILD_PI = mode;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	delete process.env.PI_CREW_CLASSIFIER_ENABLED;
	delete process.env.PI_CREW_CLASSIFIER_MODEL;
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
	if (state.classifierEnabled === undefined) delete process.env.PI_CREW_CLASSIFIER_ENABLED;
	else process.env.PI_CREW_CLASSIFIER_ENABLED = state.classifierEnabled;
	if (state.classifierModel === undefined) delete process.env.PI_CREW_CLASSIFIER_MODEL;
	else process.env.PI_CREW_CLASSIFIER_MODEL = state.classifierModel;
}

function makeFixture() {
	const cwd = createTrackedTempDir("pi-crew-retry-triage-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow, goal: "retry-triage" });
	return { cwd, created };
}

function runTask(result: { manifest: TeamRunManifest; tasks: TeamTaskState[] }, id: string): TeamTaskState {
	const found = result.tasks.find((t) => t.id === id);
	assert.ok(found, `task ${id} must exist in the result`);
	return found;
}

/**
 * Fake registry: 2-model chat chain + a configurable classifier surface.
 * `access` records EVERY property touch so default-off can prove the loop
 * never reached the registry at all.
 */
function fakeRegistry(opts: { classifyAnswer?: boolean; available?: unknown[] } = {}) {
	const access: string[] = [];
	return {
		access,
		getAvailable: () => {
			access.push("getAvailable");
			return [
				{ provider: "openai-codex", id: "gpt-5.5" },
				{ provider: "openai-codex", id: "gpt-5-mini" },
			];
		},
		getAvailableOfType: (type: string) => {
			access.push(`getAvailableOfType:${type}`);
			return type === "classifier" ? (opts.available ?? [{ provider: "opencode", id: "jev-1.13-free" }]) : [];
		},
		classify: async (model: unknown, request: unknown) => {
			access.push("classify");
			assert.ok(model && typeof model === "object", "classify must receive the resolved model object");
			const questions = (request as { questions: Record<string, unknown> }).questions;
			assert.ok(questions.transient, "retry triage must ask the 'transient' bool question");
			return { answers: { transient: opts.classifyAnswer ?? true }, stopReason: "stop" };
		},
	};
}

function mockCounterFile(): string {
	return path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
}

function retryTriagedEvents(eventsPath: string) {
	return readEvents(eventsPath).filter((e) => e.type === "task.retry_triage");
}

/** The helper's event append is fire-and-forget (buffered queue — same
 *  precedent as child-executor's task.model_dropped); poll briefly for the
 *  write to land before asserting. */
async function waitForRetryTriageEvent(eventsPath: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (retryTriagedEvents(eventsPath).length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("[triage-1] default-off: classifierEnabled absent → classify never called, retry proceeds (zero behavior change)", async () => {
	const counterFile = mockCounterFile();
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start */
	}
	const { cwd, created } = makeFixture();
	const prev = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const registry = fakeRegistry({ classifyAnswer: false });
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			modelOverride: "x",
			modelRegistry: registry,
			// NOTE: runtimeConfig intentionally WITHOUT classifierEnabled → default false.
			runtimeConfig: {},
		});
		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "fallback chain must recover exactly as before");
		assert.equal(t.modelAttempts?.length, 2, "both attempts must run (retry NOT gated)");
		assert.equal(registry.access.filter((a) => a === "classify").length, 0, "classify must NEVER be called when the seam is dormant");
		assert.equal(retryTriagedEvents(created.manifest.eventsPath).length, 0, "no retry_triage event when dormant");
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

test("[triage-2] enabled + classifier answers PERMANENT → queued retry skipped (1 attempt, task.retry_triage event)", async () => {
	const counterFile = mockCounterFile();
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start */
	}
	const { cwd, created } = makeFixture();
	const prev = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const registry = fakeRegistry({ classifyAnswer: false });
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			modelOverride: "x",
			modelRegistry: registry,
			runtimeConfig: { classifierEnabled: true },
		});
		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.modelAttempts?.length, 1, "the queued retry must be SKIPPED (permanent verdict)");
		assert.equal(t.modelAttempts?.[0]?.success, false, "the single attempt stays a failure");
		assert.notEqual(t.status, "completed", "task must not complete without the retry");
		assert.equal(registry.access.filter((a) => a === "classify").length, 1, "classify consulted exactly once");
		const triageEvents = retryTriagedEvents(created.manifest.eventsPath);
		assert.equal(triageEvents.length, 1, "one task.retry_triage event");
		assert.equal(triageEvents[0]!.data?.decision, "permanent");
		assert.equal(triageEvents[0]!.data?.classifierModel, "opencode/jev-1.13-free");
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

test("[triage-3] enabled + classifier answers TRANSIENT → retry proceeds and completes (2 attempts, event decision=transient)", async () => {
	const counterFile = mockCounterFile();
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start */
	}
	const { cwd, created } = makeFixture();
	const prev = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const registry = fakeRegistry({ classifyAnswer: true });
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			modelOverride: "x",
			modelRegistry: registry,
			runtimeConfig: { classifierEnabled: true },
		});
		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "transient verdict keeps the fallback chain");
		assert.equal(t.modelAttempts?.length, 2, "both attempts must run");
		assert.equal(registry.access.filter((a) => a === "classify").length, 1, "classify consulted exactly once");
		const triageEvents = retryTriagedEvents(created.manifest.eventsPath);
		assert.equal(triageEvents.length, 1);
		assert.equal(triageEvents[0]!.data?.decision, "transient");
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

test("[triage-4] enabled + no credentialed classifier → fallback (retry proceeds) and NO retry_triage event", async () => {
	const counterFile = mockCounterFile();
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start */
	}
	const { cwd, created } = makeFixture();
	const prev = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const registry = fakeRegistry({ available: [] });
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step(),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
			modelOverride: "x",
			modelRegistry: registry,
			runtimeConfig: { classifierEnabled: true },
		});
		const t = runTask(result, created.tasks[0]!.id);
		assert.equal(t.status, "completed", "unavailable classifier falls back to the pre-existing retry behavior");
		assert.equal(t.modelAttempts?.length, 2, "both attempts must run");
		assert.equal(registry.access.filter((a) => a === "classify").length, 0, "classify unreachable with zero available classifiers");
		assert.equal(retryTriagedEvents(created.manifest.eventsPath).length, 0, "fallback must NOT emit a retry_triage decision event");
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

test("[triage-5] helper contract: enabled=false short-circuits before ANY registry access", async () => {
	let touched = false;
	const boobyTrapped = {
		get availableOfType(): never {
			touched = true;
			throw new Error("registry must not be touched when disabled");
		},
		getAvailableOfType: (): unknown[] => {
			touched = true;
			throw new Error("registry must not be touched when disabled");
		},
		classify: (): never => {
			touched = true;
			throw new Error("classify must not be called when disabled");
		},
	};
	const eventsPath = path.join(os.tmpdir(), `pi-crew-triage5-${process.pid}-${Date.now()}.jsonl`);
	const result = await triageRetryWithClassifier({
		enabled: false,
		modelRegistry: boobyTrapped,
		classifierModel: "opencode/jev-1.13-free",
		failureSummary: "Provider error: api_error",
		failedModel: "openai-codex/gpt-5.5",
		exitCode: 0,
		eventsPath,
		runId: "r",
		taskId: "t",
	});
	assert.equal(touched, false, "disabled gate must not touch the registry");
	assert.deepEqual(result, { proceedWithRetry: true, consulted: false });
});

test("[triage-6] helper contract: classifier answer informs the decision + event fires", async () => {
	const { cwd } = makeFixture();
	try {
		const eventsPath = path.join(cwd, ".crew", "state", "runs", "probe", "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		const registry = fakeRegistry({ classifyAnswer: false });
		const result = await triageRetryWithClassifier({
			enabled: true,
			modelRegistry: registry,
			classifierModel: "opencode/jev-1.13-free",
			failureSummary: "auth_error: permission denied".repeat(300),
			failedModel: "openai-codex/gpt-5.5",
			exitCode: 1,
			eventsPath,
			runId: "run-x",
			taskId: "task-y",
		});
		assert.deepEqual(result, { proceedWithRetry: false, consulted: true });
		await waitForRetryTriageEvent(eventsPath);
		const events = retryTriagedEvents(eventsPath);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.taskId, "task-y");
		assert.equal(events[0]!.data?.decision, "permanent");
		// Failure summary fed to the classifier is capped at 2000 chars.
		const call = registry.access;
		assert.ok(call.includes("classify"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
