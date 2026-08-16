/**
 * bug-026 sub-issue B — ENOSPC surfacing integration tests.
 *
 * Drives runTeamTask's child-process branch via the mock child pi (same
 * pattern as child-executor-spawn-budget-config.test.ts). The mock's
 * fallback mode returns `{ exitCode: 1, stderr: "[MOCK] failure: <name>" }`,
 * so a mock name containing the errno reproduces the 2026-08-15 incident
 * shape: the errno only ever surfaces inside a stderr string, never as a
 * raw errno object in the parent.
 *
 * Covers both hook points in child-executor.ts:
 *  - per-attempt stamp (single non-retryable attempt), and
 *  - the post-loop E2 modelExhausted rewrite (errno must survive the
 *    "All N model candidates exhausted … Last failure: …" message).
 * Plus the task.failed event carrying data.failureCause (post-execution.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { invalidateConfigCache } from "../../../../src/config/config.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

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
	steps: [{ id: "s", role: "r", task: "fs errno test" }],
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

const twoModelRegistry = {
	getAvailable: () => [
		{ provider: "test", id: "m1" },
		{ provider: "test", id: "m2" },
	],
};

/** Same env-scoped mock activation pattern as child-executor-spawn-budget-config.test.ts. */
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

/** Run one task under a mock and return (failed task record, parsed events.jsonl lines). */
async function runMockTask(
	cwd: string,
	mock: string,
	modelRegistry: unknown,
): Promise<{ task: TeamTaskState; events: Array<Record<string, unknown>> }> {
	const created = createRunManifest({ cwd, team, workflow, goal: "fs errno surfacing" });
	const task = created.tasks[0]!;
	const result = await runTeamTask({
		manifest: created.manifest,
		tasks: created.tasks,
		task,
		step: workflow.steps[0]!,
		agent,
		executeWorkers: true,
		runtimeKind: "child-process",
		workspaceId: cwd,
		modelRegistry,
	});
	const failed = result.tasks.find((t) => t.id === task.id)!;
	const events = fs
		.readFileSync(created.manifest.eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	return { task: failed, events };
}

test("bug-026 B: ENOSPC in child stderr → task record carries failureCause=enospc", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fs-errno-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		invalidateConfigCache();
		await withMockEnv("ENOSPC: no space left on device, write", async () => {
			const { task, events } = await runMockTask(cwd, "ENOSPC: no space left on device, write", twoModelRegistry);
			assert.equal(task.status, "failed");
			assert.equal(task.failureCause, "enospc", "task record must carry failureCause=enospc");
			assert.match(task.error ?? "", /ENOSPC/);
			// The terminal failure event must surface the classified cause.
			const failedEvent = events.find((event) => event.type === "task.failed");
			assert.ok(failedEvent, "task.failed event must be emitted");
			assert.deepEqual((failedEvent as { data?: { failureCause?: string } }).data, { failureCause: "enospc" });
		});
	} finally {
		invalidateConfigCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("bug-026 B: failureCause survives the E2 modelExhausted rewrite", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fs-errno-e2-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		invalidateConfigCache();
		// Retryable (rate limit) + ENOSPC → the 2-model chain is fully tried,
		// then the E008 modelExhausted rewrite replaces the task error. The
		// errno embedded in "Last failure: …" must still be classified.
		const mock = "rate limit ENOSPC: no space left on device, write";
		await withMockEnv(mock, async () => {
			const { task, events } = await runMockTask(cwd, mock, twoModelRegistry);
			assert.equal(task.status, "failed");
			assert.ok((task.modelAttempts?.length ?? 0) >= 2, "fallback chain must have been exercised");
			assert.match(task.error ?? "", /model candidates exhausted/);
			assert.equal(task.failureCause, "enospc", "failureCause must survive the modelExhausted rewrite");
			const failedEvent = events.find((event) => event.type === "task.failed");
			assert.ok(failedEvent, "task.failed event must be emitted");
			assert.deepEqual((failedEvent as { data?: { failureCause?: string } }).data, { failureCause: "enospc" });
		});
	} finally {
		invalidateConfigCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("bug-026 B: non-fs mock failure → no failureCause on the task record", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fs-errno-clean-"));
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		invalidateConfigCache();
		// "retryable-failure" mock → rate-limit stderr, no errno anywhere.
		await withMockEnv("retryable-failure", async () => {
			const { task, events } = await runMockTask(cwd, "retryable-failure", twoModelRegistry);
			assert.equal(task.status, "failed");
			assert.equal(task.failureCause, undefined, "non-fs failures must not carry a fs failureCause");
			const failedEvent = events.find((event) => event.type === "task.failed");
			assert.ok(failedEvent);
			assert.equal((failedEvent as { data?: { failureCause?: string } }).data, undefined);
		});
	} finally {
		invalidateConfigCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
