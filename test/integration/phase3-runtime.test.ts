import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildPiSpawnOptions, runChildPi } from "../../src/runtime/child-pi.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext } from "../../src/runtime/task-output-context.ts";
import { readCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import { writeArtifact } from "../../src/state/artifact-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "phase3",
	description: "phase3",
	source: "builtin",
	filePath: "phase3.team.md",
	roles: [{ name: "explorer", agent: "explorer" }, { name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "phase3",
	description: "phase3",
	source: "builtin",
	filePath: "phase3.workflow.md",
	steps: [
		{ id: "explore", role: "explorer", task: "Explore" },
		{ id: "plan", role: "planner", task: "Plan", dependsOn: ["explore"], reads: ["context.md"] },
	],
};

test("child Pi spawn options hide Windows console windows", () => {
	const options = buildChildPiSpawnOptions("/tmp/project", { PATH: process.env.PATH ?? "" });
	assert.equal(options.windowsHide, true);
	assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

test("child Pi runtime writes JSONL transcript callbacks", async () => {
	const previous = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-child-transcript-"));
	const transcriptPath = path.join(dir, "transcript.jsonl");
	const events: unknown[] = [];
	try {
		const result = await runChildPi({ cwd: dir, task: "hello", agent: { name: "mock", description: "mock", source: "builtin", filePath: "mock.md", systemPrompt: "mock" }, transcriptPath, onJsonEvent: (event) => events.push(event) });
		assert.equal(result.exitCode, 0);
		assert.equal(events.length, 2);
		assert.match(fs.readFileSync(transcriptPath, "utf-8"), /message_end/);
	} finally {
		if (previous === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child Pi runtime ignores observer callback failures", async () => {
	const previous = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-child-callback-failure-"));
	try {
		const result = await runChildPi({
			cwd: dir,
			task: "hello",
			agent: { name: "mock", description: "mock", source: "builtin", filePath: "mock.md", systemPrompt: "mock" },
			onJsonEvent: () => { throw new Error("observer write failed"); },
			onStdoutLine: () => { throw new Error("output write failed"); },
		});
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /Mock JSON success/);
	} finally {
		if (previous === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("dependency output context injects prior task output and shared reads", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-output-context-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "phase3" });
		const resultArtifact = writeArtifact(manifest.artifactsRoot, { kind: "result", relativePath: "results/01_explore.md", producer: "01_explore", content: "Exploration output" });
		fs.mkdirSync(path.join(manifest.artifactsRoot, "shared"), { recursive: true });
		fs.writeFileSync(path.join(manifest.artifactsRoot, "shared", "context.md"), "Shared context", "utf-8");
		const updatedTasks = tasks.map((task) => task.stepId === "explore" ? { ...task, status: "completed" as const, resultArtifact } : task);
		const plan = updatedTasks.find((task) => task.stepId === "plan")!;
		const ctx = collectDependencyOutputContext(manifest, updatedTasks, plan, workflow.steps[1]!);
		const rendered = renderDependencyOutputContext(ctx);
		assert.match(rendered, /Exploration output/);
		assert.match(rendered, /Shared context/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("crew agent records mirror task agents", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-records-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "phase3" });
		assert.deepEqual(readCrewAgents(manifest), []);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
