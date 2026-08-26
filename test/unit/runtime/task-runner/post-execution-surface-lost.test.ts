/**
 * S2-T11 regression: `surfaceLost` trong TaskExecutionResult phải kết thúc
 * task ở needs_attention (không phải failed/completed) và KHÔNG chạy các gate
 * yield/mutation/empty-output — một pane chết mà không có worker.completed
 * là mất worker, không phải "kết quả rỗng".
 *
 * Cùng chiến lược isolation với post-execution-stderr-only.test.ts: gọi
 * finalizeTaskResult TRỰC TIẾP với TaskExecutionContext tự dựng.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { createStartupEvidence } from "../../../../src/runtime/heartbeat/worker-startup.ts";
import { permissionForRole } from "../../../../src/runtime/role-permission.ts";
import { buildTaskPacket } from "../../../../src/runtime/task-packet.ts";
import { finalizeTaskResult, type TaskExecutionResult } from "../../../../src/runtime/task-runner/post-execution.ts";
import type { TaskExecutionContext } from "../../../../src/runtime/task-runner/pre-execution.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

// WorkflowStep/TeamConfig sống ở module khác — cast nhẹ cho fixture.
const team = {
	name: "surface-lost",
	description: "mux-surface degrade finalize",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
} as never as TeamConfig;

const agent: AgentConfig = {
	name: "worker",
	description: "degrade finalize worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

const step = { id: "s", role: "worker", task: "Do the task", source: "builtin" } as never as WorkflowStep;

function makeFixture() {
	const cwd = mkdtempSync(path.join("/tmp", "pi-crew-surface-lost-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({
		cwd,
		team,
		workflow: { name: "w", description: "surface-lost", source: "builtin", filePath: "builtin", steps: [step] },
		goal: "mux-surface degrade terminalisation",
	});
	return { cwd, created };
}

function buildCtx(cwd: string, created: { manifest: TeamRunManifest; tasks: TeamTaskState[] }): TaskExecutionContext {
	const manifest = created.manifest;
	const baseTask = created.tasks[0]!;
	assert.ok(baseTask, "fixture must create the workflow task");
	const taskPacket = buildTaskPacket({ manifest, step, taskId: baseTask.id, cwd, worktreePath: undefined });
	const now = new Date();
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
		promptArtifact: {
			kind: "prompt",
			path: path.join(manifest.artifactsRoot, `prompts/${baseTask.id}.md`),
			createdAt: now.toISOString(),
			producer: baseTask.id,
			retention: "run",
		},
		inputsArtifact: {
			kind: "metadata",
			path: path.join(manifest.artifactsRoot, `metadata/${baseTask.id}.inputs.json`),
			createdAt: now.toISOString(),
			producer: baseTask.id,
			retention: "run",
		},
		skillArtifact: {
			kind: "metadata",
			path: path.join(manifest.artifactsRoot, `skills/${baseTask.id}.md`),
			createdAt: now.toISOString(),
			producer: baseTask.id,
			retention: "run",
		},
		coordinationArtifact: {
			kind: "metadata",
			path: path.join(manifest.artifactsRoot, `metadata/${baseTask.id}.coordination-bridge.md`),
			createdAt: now.toISOString(),
			producer: baseTask.id,
			retention: "run",
		},
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

function makeSurfaceLostExecResult(taskId: string): TaskExecutionResult {
	return {
		logArtifact: undefined,
		transcriptArtifact: undefined,
		exitCode: null,
		error: undefined,
		modelAttempts: [{ model: "test/model", success: false, exitCode: null }],
		parsedOutput: undefined,
		finalStdout: "",
		rawFinalText: undefined,
		transcriptPath: undefined,
		terminalEvidence: [],
		startupEvidence: createStartupEvidence({
			command: "pi",
			startedAt: new Date(),
			finishedAt: new Date(),
			promptSentAt: new Date(),
			promptAccepted: false,
			exitCode: null,
		}),
		surfaceLost: {
			taskId,
			paneId: "%9",
			cause: "pane-closed",
			exitReason: "pane-closed",
			ts: new Date().toISOString(),
		},
	};
}

describe("finalizeTaskResult — surfaceLost degrade terminalisation (S2-T11)", () => {
	it("needs_attention + diagnostics.surfaceLost + event task.surface_lost; KHÔNG có result artifact giả", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeSurfaceLostExecResult(taskId));
			const task = result.tasks.find((x) => x.id === taskId);
			assert.ok(task);
			assert.equal(task.status, "needs_attention");
			assert.equal(task.error, undefined);
			assert.equal(task.exitCode, null);
			const lostDiag = (task.diagnostics as { surfaceLost?: { cause?: string } }).surfaceLost;
			assert.equal(lostDiag?.cause, "pane-closed");
			assert.equal(
				task.resultArtifact === undefined || task.resultArtifact === null,
				true,
				"phải để trống resultArtifact — không fabricate '(no output)'",
			);

			const events = readEvents(result.manifest.eventsPath).map((event) => event.type);
			assert.ok(events.includes("task.surface_lost"), events.join(","));
			assert.ok(!events.includes("task.completed"), "chưa hoàn thành thì không được phát task.completed");
			assert.ok(!events.includes("task.failed"), "mất pane KHÔNG phải task failure");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
