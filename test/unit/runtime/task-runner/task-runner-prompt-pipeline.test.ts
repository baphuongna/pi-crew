import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildWorkerPromptPipeline, type WorkerPromptPipelineArtifact } from "../../../../src/runtime/task-runner/prompt-pipeline.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
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
	steps: [{ id: "s", role: "r", task: "x" }],
} satisfies WorkflowConfig;
const agent = {
	name: "a",
	description: "",
	source: "project",
	filePath: "a",
	systemPrompt: "test",
} satisfies AgentConfig;

function readJson(filePath: string): WorkerPromptPipelineArtifact {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorkerPromptPipelineArtifact;
}

test("runTeamTask writes stable prompt pipeline metadata for scaffold runs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prompt-pipeline-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "pipeline",
		});
		const task = created.tasks[0]!;

		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task,
			step: workflow.steps[0]!,
			agent,
			executeWorkers: false,
			runtimeKind: "scaffold",
			workspaceId: cwd,
		});

		const relativePath = `metadata/${task.id}.prompt-pipeline.json`;
		const pipelineArtifact = result.manifest.artifacts.find((artifact) => artifact.path.replaceAll("\\", "/").endsWith(relativePath));
		assert.ok(pipelineArtifact);
		const pipeline = readJson(path.join(created.manifest.artifactsRoot, relativePath));
		assert.equal(pipeline.schemaVersion, 1);
		assert.equal(pipeline.taskId, task.id);
		assert.deepEqual(
			pipeline.stages.map((stage) => stage.name),
			[
				"task-packet-built",
				"dependency-context-collected",
				"skills-rendered-or-disabled",
				"capability-inventory-recorded",
				"coordination-bridge-attached",
				"prompt-rendered",
				"prompt-artifact-written",
			],
		);
		assert.deepEqual(pipeline.stages[0]?.references, [`metadata/${task.id}.task-packet.json`]);
		assert.deepEqual(pipeline.stages[1]?.references, [`metadata/${task.id}.inputs.json`]);
		assert.deepEqual(pipeline.stages[3]?.references, [`metadata/${task.id}.capabilities.json`]);
		assert.deepEqual(pipeline.stages[4]?.references, [`metadata/${task.id}.coordination-bridge.md`]);
		assert.deepEqual(pipeline.stages[6]?.references, [`prompts/${task.id}.md`]);
		assert.equal(pipeline.stages[2]?.details?.disabled, false);
		assert.equal(typeof pipeline.stages[2]?.details?.skillInstructionCount, "number");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("prompt pipeline records disabled skills without a skill artifact reference", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prompt-pipeline-disabled-"));
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "pipeline disabled skills",
		});
		const task = created.tasks[0]!;

		await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task,
			step: workflow.steps[0]!,
			agent,
			executeWorkers: false,
			runtimeKind: "scaffold",
			workspaceId: cwd,
			skillOverride: false,
		});

		const pipeline = readJson(path.join(created.manifest.artifactsRoot, `metadata/${task.id}.prompt-pipeline.json`));
		assert.deepEqual(pipeline.stages[2]?.references, []);
		assert.equal(pipeline.stages[2]?.details?.disabled, true);
		assert.equal(pipeline.stages[2]?.details?.skillInstructionCount, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("prompt pipeline omits artifact references outside the artifacts root", () => {
	const artifactsRoot = path.join(os.tmpdir(), "pi-crew-artifacts-root");
	const pipeline = buildWorkerPromptPipeline({
		artifactsRoot,
		taskId: "task-1",
		inputsArtifact: {
			kind: "metadata",
			path: path.join(`${artifactsRoot}-sibling`, "task-1.inputs.json"),
			createdAt: "2026-05-05T00:00:00.000Z",
			producer: "test",
			retention: "run",
		},
		coordinationArtifact: {
			kind: "metadata",
			path: path.join(artifactsRoot, "metadata", "task-1.coordination-bridge.md"),
			createdAt: "2026-05-05T00:00:00.000Z",
			producer: "test",
			retention: "run",
		},
		capabilityArtifact: {
			kind: "metadata",
			path: path.join(artifactsRoot, "metadata", "task-1.capabilities.json"),
			createdAt: "2026-05-05T00:00:00.000Z",
			producer: "test",
			retention: "run",
		},
		promptArtifact: {
			kind: "prompt",
			path: path.join(artifactsRoot, "prompts", "task-1.md"),
			createdAt: "2026-05-05T00:00:00.000Z",
			producer: "test",
			retention: "run",
		},
		skillInstructionCount: 0,
		skillsDisabled: true,
	});

	assert.deepEqual(pipeline.stages[1]?.references, ["metadata/task-1.inputs.json"]);
	assert.deepEqual(pipeline.stages[3]?.references, ["metadata/task-1.capabilities.json"]);
	assert.deepEqual(pipeline.stages[4]?.references, ["metadata/task-1.coordination-bridge.md"]);
	assert.deepEqual(pipeline.stages[6]?.references, ["prompts/task-1.md"]);
});
