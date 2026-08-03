import assert from "node:assert/strict";
import test from "node:test";
import { recordFromTask } from "../../../../src/runtime/crew-agent-records.ts";
import { taskStatusToAgentStatus } from "../../../../src/runtime/crew-agent-runtime.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

test("skipped tasks are terminal non-queued agent records", () => {
	assert.equal(taskStatusToAgentStatus("skipped"), "cancelled");
});

test("crew agent records expose model and usage for UI/status", () => {
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: "team_test",
		team: "fast-fix",
		workflow: "fast-fix",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		cwd: process.cwd(),
		stateRoot: process.cwd(),
		artifactsRoot: process.cwd(),
		tasksPath: "tasks.json",
		eventsPath: "events.jsonl",
		artifacts: [],
	};
	const task: TeamTaskState = {
		id: "01",
		runId: manifest.runId,
		role: "explorer",
		agent: "explorer",
		title: "explore",
		status: "completed",
		dependsOn: [],
		cwd: process.cwd(),
		modelAttempts: [{ model: "openai-codex/gpt-5.5", success: true, exitCode: 0 }],
		modelRouting: {
			requested: "gpt-5.5",
			resolved: "openai-codex/gpt-5.5",
			fallbackChain: ["openai-codex/gpt-5.5"],
			usedAttempt: 0,
		},
		usage: { input: 10, output: 5, cacheRead: 20 },
	};
	const record = recordFromTask(manifest, task, "child-process");
	assert.equal(record.model, "openai-codex/gpt-5.5");
	assert.deepEqual(record.routing, {
		requested: "gpt-5.5",
		resolved: "openai-codex/gpt-5.5",
		fallbackChain: ["openai-codex/gpt-5.5"],
		usedAttempt: 0,
	});
	assert.deepEqual(record.usage, { input: 10, output: 5, cacheRead: 20 });
});
