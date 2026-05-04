import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyTaskCompletion, formatOutputPreview } from "../../src/runtime/completion-guard.ts";
import type { TeamTaskState, TeamRunManifest, ArtifactDescriptor } from "../../src/state/types.ts";

const makeArtifact = (overrides: Partial<ArtifactDescriptor> & { kind: ArtifactDescriptor["kind"]; producer: string }): ArtifactDescriptor => ({
	path: "/tmp/artifact.txt",
	createdAt: new Date().toISOString(),
	retention: "run",
	...overrides,
});

const emptyManifest: TeamRunManifest = {
	schemaVersion: 1,
	runId: "test-run",
	cwd: "/tmp",
	team: "test",
	goal: "test goal",
	status: "running",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	stateRoot: "/tmp",
	artifactsRoot: "/tmp",
	tasksPath: "/tmp/tasks.json",
	eventsPath: "/tmp/events.jsonl",
	workspaceMode: "single",
	artifacts: [],
};

const baseTask: TeamTaskState = {
	id: "task-1",
	runId: "test-run",
	role: "executor",
	agent: "test-agent",
	title: "Test task",
	status: "completed",
	dependsOn: [],
	cwd: "/tmp",
};

describe("verifyTaskCompletion", () => {
	it("returns green=0 for task with error", () => {
		const result = verifyTaskCompletion(
			{ ...baseTask, error: "something failed" },
			emptyManifest,
		);
		assert.equal(result.greenLevel, 0);
		assert.ok(result.warnings.length > 0);
	});

	it("returns green=0 for task with no artifacts or usage", () => {
		const result = verifyTaskCompletion(baseTask, emptyManifest);
		assert.equal(result.greenLevel, 0);
		assert.ok(result.warnings.some((w) => w.includes("artifacts")));
	});

	it("returns green=1 for task with result artifact only", () => {
		const result = verifyTaskCompletion(
			{
				...baseTask,
				resultArtifact: makeArtifact({ kind: "result", producer: "task-1" }),
			},
			emptyManifest,
		);
		assert.equal(result.greenLevel, 1);
	});

	it("returns green=2 for task with result + transcript artifacts", () => {
		const result = verifyTaskCompletion(
			{
				...baseTask,
				resultArtifact: makeArtifact({ kind: "result", producer: "task-1" }),
				transcriptArtifact: makeArtifact({ kind: "log", producer: "task-1" }),
			},
			emptyManifest,
		);
		assert.equal(result.greenLevel, 2);
	});

	it("returns green=3 for task with result + transcript + run artifacts", () => {
		const manifest: TeamRunManifest = {
			...emptyManifest,
			artifacts: [makeArtifact({ kind: "result", producer: "task-1" })],
		};
		const result = verifyTaskCompletion(
			{
				...baseTask,
				resultArtifact: makeArtifact({ kind: "result", producer: "task-1" }),
				transcriptArtifact: makeArtifact({ kind: "log", producer: "task-1" }),
			},
			manifest,
		);
		assert.equal(result.greenLevel, 3);
	});

	it("warns about zero token usage", () => {
		const result = verifyTaskCompletion(
			{ ...baseTask, usage: { input: 0, output: 0 } },
			emptyManifest,
		);
		assert.ok(result.warnings.some((w) => w.includes("token")));
	});
});

describe("formatOutputPreview", () => {
	it("returns (no output) for undefined", () => {
		assert.equal(formatOutputPreview(undefined), "(no output)");
	});

	it("returns short output as-is", () => {
		assert.equal(formatOutputPreview("hello"), "hello");
	});

	it("truncates long output", () => {
		const long = "a".repeat(300);
		const preview = formatOutputPreview(long);
		assert.ok(preview.endsWith("..."));
		assert.ok(preview.length <= 203);
	});
});
