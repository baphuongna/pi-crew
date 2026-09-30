/**
 * G18 (SDD Buổi-1 WI-3 follow-up): prompt-breakdown artifacts must be INDEXED
 * in the run manifest — pre-execution captures the writeArtifact descriptor
 * into ctx.breakdownArtifact and finalizeTaskResult merges it into
 * manifest.artifacts. Before this wiring the `breakdown` team-tool action
 * could never find breakdown JSONs on real runs (descriptor was discarded,
 * pre-execution.ts:352), even with PI_CREW_PROMPT_BREAKDOWN=1.
 *
 * Cùng chiến lược isolation với post-execution-surface-lost.test.ts: gọi
 * finalizeTaskResult TRỰC TIẾP với TaskExecutionContext tự dựng (success path
 * — có result artifact thật, KHÔNG surfaceLost, để đi qua manifest merge).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { createStartupEvidence } from "../../../../src/runtime/heartbeat/worker-startup.ts";
import { permissionForRole } from "../../../../src/runtime/role-permission.ts";
import { buildTaskPacket } from "../../../../src/runtime/task-packet.ts";
import { finalizeTaskResult, type TaskExecutionResult } from "../../../../src/runtime/task-runner/post-execution.ts";
import type { TaskExecutionContext } from "../../../../src/runtime/task-runner/pre-execution.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

const team = {
	name: "breakdown-index",
	description: "breakdown artifact manifest-index wiring",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
} as never as TeamConfig;

const agent: AgentConfig = {
	name: "worker",
	description: "breakdown index worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

const step = { id: "s", role: "worker", task: "Do the task", source: "builtin" } as never as WorkflowStep;

const tmpDirs: string[] = [];
after(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeFixture() {
	const cwd = mkdtempSync(path.join("/tmp", "pi-crew-breakdown-index-"));
	tmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({
		cwd,
		team,
		workflow: { name: "w", description: "breakdown-index", source: "builtin", filePath: "builtin", steps: [step] },
		goal: "breakdown artifact index regression",
	});
	return { cwd, created };
}

function buildCtx(
	cwd: string,
	created: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	withBreakdown: boolean,
): TaskExecutionContext {
	const manifest = created.manifest;
	const baseTask = created.tasks[0]!;
	assert.ok(baseTask, "fixture must create the workflow task");
	const taskPacket = buildTaskPacket({ manifest, step, taskId: baseTask.id, cwd, worktreePath: undefined });
	const now = new Date();
	const stubArtifact = (kind: ArtifactDescriptor["kind"], rel: string): ArtifactDescriptor => ({
		kind,
		path: path.join(manifest.artifactsRoot, rel),
		createdAt: now.toISOString(),
		producer: baseTask.id,
		retention: "run",
	});
	return {
		input: { manifest, tasks: created.tasks, task: baseTask, step, agent, executeWorkers: true, workspaceId: cwd },
		manifest,
		task: { ...baseTask, taskPacket },
		tasks: created.tasks.map((t) => (t.id === baseTask.id ? { ...t, taskPacket } : t)),
		runtimeKind: "child-process",
		workspace: { cwd },
		worktree: undefined,
		streamBridge: undefined,
		taskPacket,
		dependencyContextText: undefined,
		permissionMode: permissionForRole(baseTask.role),
		skillBlock: undefined,
		skillNames: undefined,
		skillPaths: undefined,
		prompt: "regression prompt",
		promptArtifact: stubArtifact("prompt", `prompts/${baseTask.id}.md`),
		...(withBreakdown
			? { breakdownArtifact: stubArtifact("metadata", `metadata/${baseTask.id}.prompt-breakdown.json`) }
			: {}),
		inputsArtifact: stubArtifact("metadata", `metadata/${baseTask.id}.inputs.json`),
		skillArtifact: undefined,
		coordinationArtifact: stubArtifact("metadata", `metadata/${baseTask.id}.coordination-bridge.md`),
		collectYieldEvents: false,
		collectedJsonEvents: undefined,
		startupEvidence: createStartupEvidence({
			command: "pi",
			startedAt: now,
			finishedAt: now,
			promptSentAt: now,
			promptAccepted: true,
			exitCode: 0,
		}),
	};
}

function makeExecResult(manifest: TeamRunManifest, taskId: string): TaskExecutionResult {
	const rel = `results/${taskId}.txt`;
	const abs = path.join(manifest.artifactsRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, "breakdown-index regression result", "utf-8");
	return {
		resultArtifact: {
			kind: "result",
			path: abs,
			createdAt: new Date().toISOString(),
			producer: taskId,
			retention: "run",
			sizeBytes: Buffer.byteLength("breakdown-index regression result"),
		},
		logArtifact: undefined,
		transcriptArtifact: undefined,
		exitCode: 0,
		error: undefined,
		modelAttempts: [{ model: "test/model", success: true, exitCode: 0 }],
		parsedOutput: { jsonEvents: 0, textEvents: [], finalText: "done" },
		finalStdout: "done",
		transcriptPath: undefined,
		terminalEvidence: [],
		startupEvidence: createStartupEvidence({
			command: "pi",
			startedAt: new Date(),
			finishedAt: new Date(),
			promptSentAt: new Date(),
			promptAccepted: true,
			exitCode: 0,
		}),
	};
}

describe("G18: prompt-breakdown artifact manifest indexing", () => {
	it("finalizeTaskResult merges ctx.breakdownArtifact into manifest.artifacts", async () => {
		const { cwd, created } = makeFixture();
		const ctx = buildCtx(cwd, created, true);
		const execResult = makeExecResult(created.manifest, created.tasks[0]!.id);
		const final = await finalizeTaskResult(ctx, execResult);
		const indexed = final.manifest.artifacts.filter((a) => a.path.endsWith(".prompt-breakdown.json"));
		assert.equal(indexed.length, 1, "breakdown descriptor must be indexed exactly once in manifest.artifacts");
		assert.equal(indexed[0]!.kind, "metadata");
	});

	it("ctx without breakdownArtifact (env off) leaves manifest.artifacts unchanged — no crash, no phantom entry", async () => {
		const { cwd, created } = makeFixture();
		const ctx = buildCtx(cwd, created, false);
		const execResult = makeExecResult(created.manifest, created.tasks[0]!.id);
		const final = await finalizeTaskResult(ctx, execResult);
		const indexed = final.manifest.artifacts.filter((a) => a.path.endsWith(".prompt-breakdown.json"));
		assert.equal(indexed.length, 0, "no breakdown entry when env gate is off");
	});
});
