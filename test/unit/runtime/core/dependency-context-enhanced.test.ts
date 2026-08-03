import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { DependencyContextEntry } from "../../../../src/runtime/task-output-context.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext } from "../../../../src/runtime/task-output-context.ts";
import { writeArtifact } from "../../../../src/state/stores/artifact-store.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "test",
	source: "builtin",
	filePath: "test.team.md",
	roles: [
		{ name: "explorer", agent: "explorer" },
		{ name: "executor", agent: "executor" },
	],
};

function makeTasks(runId: string, cwd: string, overrides?: Partial<TeamTaskState>): { explorer: TeamTaskState; executor: TeamTaskState } {
	const explorer: TeamTaskState = {
		id: "01_explore",
		runId,
		stepId: "explore",
		role: "explorer",
		agent: "explorer",
		title: "Explore",
		status: "completed",
		dependsOn: [],
		cwd,
		...overrides,
	};
	const executor: TeamTaskState = {
		id: "02_execute",
		runId,
		stepId: "execute",
		role: "executor",
		agent: "executor",
		title: "Execute",
		status: "queued",
		dependsOn: ["explore"],
		cwd,
	};
	return { explorer, executor };
}

test("structured results extracted from JSON result output", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-structured-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			goal: "structured",
		});
		const jsonContent = JSON.stringify({
			files: ["a.ts", "b.ts"],
			summary: "found 2 files",
		});
		const resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: "results/01_explore.json",
			producer: "01_explore",
			content: jsonContent,
		});
		const { explorer, executor } = makeTasks(manifest.runId, cwd, {
			resultArtifact,
		});
		const step = { id: "execute", role: "executor", task: "do" };
		const ctx = collectDependencyOutputContext({ ...manifest }, [explorer, executor], executor, step);
		assert.equal(ctx.dependencies.length, 1);
		const dep = ctx.dependencies[0]!;
		assert.equal(dep.taskId, "01_explore");
		assert.deepEqual(dep.structuredResults, {
			files: ["a.ts", "b.ts"],
			summary: "found 2 files",
		});
		assert.equal(dep.resultSummary, jsonContent);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("structured results undefined for non-JSON output", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-nonjson-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, goal: "nonjson" });
		const resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: "results/01_explore.md",
			producer: "01_explore",
			content: "# Markdown output\n\nSome text.",
		});
		const { explorer, executor } = makeTasks(manifest.runId, cwd, {
			resultArtifact,
		});
		const step = { id: "execute", role: "executor", task: "do" };
		const ctx = collectDependencyOutputContext({ ...manifest }, [explorer, executor], executor, step);
		assert.equal(ctx.dependencies[0]?.structuredResults, undefined);
		assert.match(ctx.dependencies[0]!.resultSummary, /Markdown output/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifacts produced lists task artifacts from manifest", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-artifacts-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			goal: "artifacts",
		});
		const resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: "results/01_explore.txt",
			producer: "01_explore",
			content: "done",
		});
		const logArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "log",
			relativePath: "logs/01_explore.log",
			producer: "01_explore",
			content: "log output",
		});
		const updatedManifest = {
			...manifest,
			artifacts: [resultArtifact, logArtifact],
		};
		const { explorer, executor } = makeTasks(manifest.runId, cwd, {
			resultArtifact,
		});
		const step = { id: "execute", role: "executor", task: "do" };
		const ctx = collectDependencyOutputContext(updatedManifest, [explorer, executor], executor, step);
		const artifacts = ctx.dependencies[0]?.artifactsProduced;
		assert.ok(artifacts);
		assert.equal(artifacts.length, 2);
		assert.ok(artifacts.some((a) => a.includes("results")));
		assert.ok(artifacts.some((a) => a.includes("logs")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("usage aggregates token counts and duration from task state", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-usage-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, goal: "usage" });
		const resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: "results/01_explore.txt",
			producer: "01_explore",
			content: "done",
		});
		const { explorer, executor } = makeTasks(manifest.runId, cwd, {
			resultArtifact,
			usage: { input: 1500, output: 800 },
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:00:05.000Z",
		});
		const step = { id: "execute", role: "executor", task: "do" };
		const ctx = collectDependencyOutputContext({ ...manifest }, [explorer, executor], executor, step);
		const usage = ctx.dependencies[0]?.usage;
		assert.ok(usage);
		assert.equal(usage.inputTokens, 1500);
		assert.equal(usage.outputTokens, 800);
		assert.equal(usage.durationMs, 5000);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("backward compatible — entries without new fields produce undefined", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-backcompat-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			goal: "backcompat",
		});
		const { explorer, executor } = makeTasks(manifest.runId, cwd);
		// Explorer has no resultArtifact, no usage, no startedAt/finishedAt
		const step = { id: "execute", role: "executor", task: "do" };
		const ctx = collectDependencyOutputContext({ ...manifest }, [explorer, executor], executor, step);
		assert.equal(ctx.dependencies.length, 1);
		const dep = ctx.dependencies[0]!;
		assert.equal(dep.taskId, "01_explore");
		assert.equal(dep.resultSummary, "");
		assert.equal(dep.structuredResults, undefined);
		assert.equal(dep.artifactsProduced, undefined);
		assert.equal(dep.usage, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("render includes structured results, artifacts, and usage when present", () => {
	const entry: DependencyContextEntry = {
		taskId: "01_explore",
		role: "explorer",
		status: "completed",
		resultSummary: "Exploration complete",
		structuredResults: { files: 3, hasTests: true },
		artifactsProduced: ["results/01_explore.txt", "logs/01_explore.log"],
		usage: { inputTokens: 100, outputTokens: 50, durationMs: 2000 },
	};
	const rendered = renderDependencyOutputContext({
		dependencies: [entry],
		sharedReads: [],
	});
	assert.match(rendered, /Structured results:/);
	assert.match(rendered, /files.*3/);
	assert.match(rendered, /Artifacts produced:/);
	assert.match(rendered, /results\/01_explore\.txt/);
	assert.match(rendered, /100 input tokens/);
	assert.match(rendered, /50 output tokens/);
	assert.match(rendered, /2000ms/);
});
