/**
 * bug-026 sub-issue A regression tests: stderr-only result artifact must
 * FAIL the task instead of marking it "completed".
 *
 * Root cause: when a worker payload is corrupted/empty, the child-executor
 * result fallback chain (child-executor.ts, sibling-owned — NOT edited here)
 * persists session-log stderr noise as the result artifact, and the
 * completion path validated artifact EXISTENCE, not USABILITY.
 *
 * Fix under test: finalizeTaskResult (src/runtime/task-runner/post-execution.ts)
 * applies a TWO-GATE rule before the status assignment:
 *   gate 1 — parsedOutput.finalText AND finalStdout both trimmed-empty;
 *   gate 2 — persisted artifact is empty/'(no output)'/whitespace OR
 *            isStderrOnlyResult(content) is true (strict log-noise shape).
 *
 * Strategy: call finalizeTaskResult DIRECTLY with a hand-built
 * TaskExecutionContext (unit isolation — no child-process mock needed; the
 * manifest fixture reuses the createRunManifest pattern from
 * task-runner-characterization.test.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
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
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Fixtures ───────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "bug026a",
	description: "stderr-only result regression",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const agent: AgentConfig = {
	name: "worker",
	description: "regression worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

const step: WorkflowStep = { id: "s", role: "worker", task: "Do the task", source: "builtin" };

/** The exact noise shape of the corrupted evidence artifact (run team_20260815144514). */
const EVIDENCE_STDERR_NOISE = [
	"[oc-go] hidden 40 model(s) from /model by visibility config",
	"[pi-qwen-mm] [core] [stderr] /home/bom/.cache/uv/archive-v0/x/pydantic_settings/sources/utils.py:47: IncompleteFieldDefinitionWarning: Field 'lifespan' has an incomplete definition.",
	"[pi-qwen-mm] [core] [stderr]   warnings.warn(",
	"[pi-qwen-mm] [core] [stderr] 2026-08-15 21:49:02,986 WARNING system tool missing — install: apt install blender",
	"[pi-qwen-mm] [core] [mcp] handshake complete with uvx",
	"[pi-qwen-mm] [core] [stderr] 2026-08-15 21:49:02,994 INFO Processing request of type ListToolsRequest",
	"[pi-qwen-mm] registered 7 tool(s) from 1 capability(ies)",
	"[pi-qwen-mm] disposed 1 MCP client(s)",
].join("\n");

function makeFixture() {
	const cwd = createTrackedTempDir("pi-crew-bug026a-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({
		cwd,
		team,
		workflow: { name: "w", description: "bug026a", source: "builtin", filePath: "builtin", steps: [step] },
		goal: "bug-026 sub-issue A regression",
	});
	return { cwd, created };
}

function buildCtx(cwd: string, created: { manifest: TeamRunManifest; tasks: TeamTaskState[] }): TaskExecutionContext {
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
		input: {
			manifest,
			tasks: created.tasks,
			task: baseTask,
			step,
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		},
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

interface ExecOpts {
	resultContent: string;
	/** Point the resultArtifact descriptor at a path that is NOT written (unreadable-artifact case). */
	skipArtifactWrite?: boolean;
	finalText?: string;
	finalStdout?: string;
}

function makeExecResult(manifest: TeamRunManifest, taskId: string, opts: ExecOpts): TaskExecutionResult {
	const rel = `results/${taskId}.txt`;
	const abs = path.join(manifest.artifactsRoot, rel);
	if (!opts.skipArtifactWrite) {
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, opts.resultContent, "utf-8");
	}
	return {
		resultArtifact: {
			kind: "result",
			path: abs,
			createdAt: new Date().toISOString(),
			producer: taskId,
			retention: "run",
			sizeBytes: Buffer.byteLength(opts.resultContent),
		},
		logArtifact: undefined,
		transcriptArtifact: undefined,
		exitCode: 0,
		error: undefined,
		modelAttempts: [{ model: "test/model", success: true, exitCode: 0 }],
		parsedOutput: { jsonEvents: 0, textEvents: [], finalText: opts.finalText ?? "" },
		finalStdout: opts.finalStdout ?? "",
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

// ─── Tests ──────────────────────────────────────────────────────────

describe("finalizeTaskResult — stderr-only result gate (bug-026 A)", () => {
	it("1. regression: evidence-shaped stderr-only artifact + empty finalText/stdout → failed, exit 1, marker error, attention trail", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(
				ctx,
				makeExecResult(created.manifest, taskId, { resultContent: EVIDENCE_STDERR_NOISE }),
			);
			const t = result.tasks.find((x) => x.id === taskId);
			assert.ok(t, "task must exist in result");
			assert.equal(t.status, "failed", "stderr-only result artifact must fail the task");
			assert.match(t.error ?? "", /empty-or-stderr-only-result/, "error must carry the failureCause marker");
			assert.equal(t.exitCode, 1, "exitCode must be bumped to 1");
			const last = t.modelAttempts?.at(-1);
			assert.ok(last, "modelAttempts must survive");
			assert.equal(last!.success, false, "last model attempt must be marked unsuccessful");
			assert.match(last!.error ?? "", /empty-or-stderr-only-result/);

			// Observability: task.output_validation event + output-validation.json artifact.
			const events = readEvents(created.manifest.eventsPath);
			const ov = events.filter((e) => e.type === "task.output_validation");
			assert.ok(ov.length >= 1, "must emit task.output_validation");
			assert.equal(ov.at(-1)!.data?.failureCause, "empty-or-stderr-only-result");
			assert.ok(
				events.some((e) => e.type === "task.failed"),
				"must emit task.failed (not task.completed)",
			);
			assert.ok(!events.some((e) => e.type === "task.completed"), "must NOT emit task.completed");
			const ovJsonPath = path.join(created.manifest.artifactsRoot, "metadata", `${taskId}.output-validation.json`);
			assert.ok(fs.existsSync(ovJsonPath), "output-validation.json must be persisted");
			assert.match(fs.readFileSync(ovJsonPath, "utf-8"), /empty-or-stderr-only-result/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("2. legitimate short result 'OK done.' via finalText → completed, gate not tripped", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(
				ctx,
				makeExecResult(created.manifest, taskId, { resultContent: "OK done.", finalText: "OK done." }),
			);
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "completed");
			assert.equal(t.error, undefined);
			assert.equal(t.exitCode, 0);
			assert.equal(t.modelAttempts?.at(-1)?.success, true, "successful attempt must stay successful");
			const events = readEvents(created.manifest.eventsPath);
			assert.ok(
				events.some((e) => e.type === "task.completed"),
				"must emit task.completed",
			);
			assert.ok(!events.some((e) => e.type === "task.failed"));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("3. empty finalText/stdout but artifact holds real content 'OK done.' → completed (gate 2 miss)", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId, { resultContent: "OK done." }));
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "completed", "real content in the artifact must complete the task");
			assert.equal(t.error, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("4. empty everything + '(no output)' artifact → failed with marker", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(ctx, makeExecResult(created.manifest, taskId, { resultContent: "(no output)" }));
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "failed", "'(no output)' artifact with empty stdout/finalText must fail");
			assert.match(t.error ?? "", /empty-or-stderr-only-result/);
			assert.equal(t.exitCode, 1);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("5. safety: unreadable artifact (path missing on disk) → completed (read errors never auto-fail)", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(
				ctx,
				makeExecResult(created.manifest, taskId, { resultContent: EVIDENCE_STDERR_NOISE, skipArtifactWrite: true }),
			);
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "completed", "artifact read error must NOT auto-fail the task");
			assert.equal(t.error, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("6. safety: real stdout present ('done via stdout') + stderr-only artifact → completed (gate 1 miss)", async () => {
		const { cwd, created } = makeFixture();
		try {
			const ctx = buildCtx(cwd, created);
			const taskId = created.tasks[0]!.id;
			const result = await finalizeTaskResult(
				ctx,
				makeExecResult(created.manifest, taskId, { resultContent: EVIDENCE_STDERR_NOISE, finalStdout: "done via stdout" }),
			);
			const t = result.tasks.find((x) => x.id === taskId)!;
			assert.equal(t.status, "completed", "non-empty stdout is an authoritative source — gate 1 must block auto-fail");
			assert.equal(t.error, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
