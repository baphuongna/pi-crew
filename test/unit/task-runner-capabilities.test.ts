import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildWorkerCapabilityInventory, type WorkerCapabilityInventory } from "../../src/runtime/task-runner/capabilities.ts";
import { runTeamTask } from "../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

// TODO (task packet 01_01-agent, FIX 1 follow-up):
// FIX 1 relaxes the `!attemptModels[i + 1]` short-circuit in the retry loop
// (src/runtime/task-runner.ts, around line 766) to do a one-shot re-resolve
// via buildConfiguredModelRouting with the failed model as parent. This is
// hard to unit-test in isolation (the loop is inside runTeamTask and uses
// many side effects: modelRegistry, scope gate, async child run, etc.).
//
// An integration assertion belongs in
//   test/integration/model-fallback-chain-e2e.test.ts
// (a different agent owns that file). The two cases to cover are:
//   1. attemptModels exhausted + buildConfiguredModelRouting returns 0 alt
//      candidates  → retry loop breaks (unchanged behavior).
//   2. attemptModels exhausted + buildConfiguredModelRouting returns 1+ alt
//      candidates different from the failed model → retry loop uses the alt
//      on the next iteration.
// Add the integration test there with a mock that returns 1 vs 2 candidates.

const team = { name: "t", description: "", source: "project", filePath: "t", roles: [{ name: "r", agent: "a" }] } satisfies TeamConfig;
const workflow = { name: "w", description: "", source: "project", filePath: "w", steps: [{ id: "s", role: "r", task: "x", model: "step/model" }] } satisfies WorkflowConfig;
const agent = {
	name: "a",
	description: "",
	source: "project",
	filePath: "a",
	systemPrompt: "test",
	model: "agent/default",
	fallbackModels: ["agent/fallback-b", "agent/fallback-a"],
	tools: ["write", "read", "read"],
	extensions: ["pi-crew", "git"],
	systemPromptMode: "append",
	inheritProjectContext: true,
	inheritSkills: true,
} satisfies AgentConfig;

function readCapability(filePath: string): WorkerCapabilityInventory {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorkerCapabilityInventory;
}

test("buildWorkerCapabilityInventory returns stable sorted capability fields", () => {
	const inventory = buildWorkerCapabilityInventory({ taskId: "task-1", role: "executor", agent, runtime: "scaffold", permissionMode: "safe", skillNames: ["safe-bash", "git-master", "safe-bash"], skillPaths: ["/b", "/a"], skillsDisabled: false, modelOverride: "override/model", teamRoleModel: "team/model", stepModel: "step/model" });
	assert.equal(inventory.schemaVersion, 1);
	assert.equal(inventory.taskId, "task-1");
	assert.deepEqual(inventory.tools, ["read", "write"]);
	assert.deepEqual(inventory.extensions, ["git", "pi-crew"]);
	assert.deepEqual(inventory.skills.names, ["git-master", "safe-bash"]);
	assert.deepEqual(inventory.skills.paths, ["/a", "/b"]);
	assert.deepEqual(inventory.model.fallbacks, ["agent/fallback-a", "agent/fallback-b"]);
	assert.equal(inventory.model.requested, "override/model");
	assert.equal(inventory.model.agentDefault, "agent/default");
	assert.equal(inventory.model.teamRole, "team/model");
	assert.equal(inventory.model.step, "step/model");
	assert.deepEqual(inventory.inheritance, { projectContext: true, skills: true, systemPromptMode: "append" });
});

test("runTeamTask writes capability inventory metadata for scaffold runs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-capabilities-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team, workflow, goal: "capabilities" });
		const task = created.tasks[0]!;

		const result = await runTeamTask({ manifest: created.manifest, tasks: created.tasks, task, step: workflow.steps[0]!, agent, executeWorkers: false, runtimeKind: "scaffold", workspaceId: cwd, modelOverride: "override/model", teamRoleModel: "team/model", skillOverride: ["safe-bash"] });

		const relativePath = `metadata/${task.id}.capabilities.json`;
		const capabilityArtifact = result.manifest.artifacts.find((artifact) => artifact.path.replaceAll("\\", "/").endsWith(relativePath));
		assert.ok(capabilityArtifact);
		const inventory = readCapability(path.join(created.manifest.artifactsRoot, relativePath));
		assert.equal(inventory.schemaVersion, 1);
		assert.equal(inventory.taskId, task.id);
		assert.equal(inventory.role, task.role);
		assert.equal(inventory.agent, agent.name);
		assert.equal(inventory.runtime, "scaffold");
		assert.deepEqual(inventory.tools, ["read", "write"]);
		assert.deepEqual(inventory.extensions, ["git", "pi-crew"]);
		assert.equal(inventory.skills.disabled, false);
		assert.ok(inventory.skills.names.includes("safe-bash"));
		assert.equal(inventory.model.requested, "override/model");
		assert.equal(inventory.model.agentDefault, "agent/default");
		assert.equal(inventory.model.teamRole, "team/model");
		assert.equal(inventory.model.step, "step/model");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
