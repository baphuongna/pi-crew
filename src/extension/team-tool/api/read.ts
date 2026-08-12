/**
 * Extracted `api` operation handlers — read/inspect group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace (mechanical move +
 * re-indent + ctx pass-through). The existing api-ops-coverage test suite
 * guards against drift.
 */

import * as fs from "node:fs";
import { loadConfig } from "../../../config/config.ts";
import { buildAgentDashboard, readAgentOutput } from "../../../runtime/agent-observability.ts";
import { buildCapabilityInventory } from "../../../runtime/capability-inventory.ts";
import { agentOutputPath, readCrewAgentEventsCursor, readCrewAgentStatus, readCrewAgents } from "../../../runtime/crew-agent-records.ts";
import { readForegroundControlStatus, writeForegroundInterruptRequest } from "../../../runtime/foreground-control.ts";
import { probeLiveSessionRuntime } from "../../../runtime/live-session/live-session-runtime.ts";
import { resolveCrewRuntime } from "../../../runtime/model/runtime-resolver.ts";
import { readEvents, readEventsCursor } from "../../../state/event-log/event-log.ts";
import { globMatch } from "../../../utils/glob-match.ts";
import { resolveRealContainedPath } from "../../../utils/safe-paths.ts";
import type { ApiHandlerContext, ApiOperationHandler, ApiPreHandler } from "./handler-context.ts";

function safeReadContainedFile(baseDir: string, filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	let safePath: string;
	try {
		safePath = resolveRealContainedPath(baseDir, filePath);
	} catch {
		return undefined;
	}
	return fs.existsSync(safePath) ? fs.readFileSync(safePath, "utf-8") : undefined;
}

function safeContainedPath(baseDir: string, filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	try {
		return resolveRealContainedPath(baseDir, filePath);
	} catch {
		return undefined;
	}
}

function snapshotHasRunId(snapshot: { values?: unknown }, runId: string): boolean {
	const values = Array.isArray(snapshot.values) ? snapshot.values : [];
	return values.some((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const labels = (value as { labels?: unknown }).labels;
		return labels && typeof labels === "object" && !Array.isArray(labels) && (labels as Record<string, unknown>).runId === runId;
	});
}

function findTaskByIdOrStepId(ctx: ApiHandlerContext, taskId: string | undefined) {
	if (!taskId) return undefined;
	return ctx.loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
}

/** Pre-runId operation (runs before the runId guard): `metrics-snapshot`. */
export const handleMetricsSnapshot: ApiPreHandler = (hctx) => {
	const { cfg, params, ctx, result } = hctx;
	const filter = typeof cfg.filter === "string" ? cfg.filter : undefined;
	const runIdFilter = typeof cfg.runId === "string" ? cfg.runId : params.runId;
	const snapshots = ctx.metricRegistry?.snapshot() ?? [];
	const filtered = snapshots.filter((snapshot) => {
		if (filter && !globMatch(snapshot.name, filter)) return false;
		if (runIdFilter && !snapshotHasRunId(snapshot, runIdFilter)) return false;
		return true;
	});
	return result(JSON.stringify(filtered, null, 2), {
		action: "api",
		status: "ok",
		...(runIdFilter ? { runId: runIdFilter } : {}),
	});
};

/** Pre-runId operation (runs before the runId guard): `inventory`. */
export const handleInventory: ApiPreHandler = (hctx) => {
	const { ctx, result } = hctx;
	const inventory = buildCapabilityInventory(ctx.cwd, ctx.config);
	return result(JSON.stringify(inventory, null, 2), {
		action: "api",
		status: "ok",
	});
};

export const handleReadManifest: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(JSON.stringify(loaded.manifest, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleListTasks: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(JSON.stringify(loaded.tasks, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadTask: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const task = findTaskByIdOrStepId(hctx, taskId);
	if (!task)
		return result(
			paramRequired(
				"API read-task",
				"config.taskId matching a task id or step id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'read-task', taskId: '01_01-agent' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	return result(JSON.stringify(task, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadEvents: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result } = hctx;
	const sinceSeq = typeof cfg.sinceSeq === "number" ? cfg.sinceSeq : undefined;
	const limit = typeof cfg.limit === "number" ? cfg.limit : undefined;
	const payload =
		sinceSeq !== undefined || limit !== undefined
			? readEventsCursor(loaded.manifest.eventsPath, {
					sinceSeq,
					limit,
				})
			: {
					events: readEvents(loaded.manifest.eventsPath),
					nextSeq: undefined,
					total: undefined,
				};
	return result(JSON.stringify(payload, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleRuntimeCapabilities: ApiOperationHandler = async (hctx) => {
	const { ctx, loaded, result } = hctx;
	const loadedConfig = loadConfig(ctx.cwd);
	return result(JSON.stringify(await resolveCrewRuntime(loadedConfig.config), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleProbeLiveSession: ApiOperationHandler = async (hctx) => {
	const { loaded, result } = hctx;
	return result(JSON.stringify(await probeLiveSessionRuntime(), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleListAgents: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(JSON.stringify(readCrewAgents(loaded.manifest), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleGetAgentResult: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
	if (!agent)
		return result(
			paramRequired(
				"API get-agent-result",
				"config.agentId matching an agent id or task id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'get-agent-result', agentId: 'agent-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const task = loaded.tasks.find((item) => item.id === agent.taskId);
	const text = safeReadContainedFile(loaded.manifest.artifactsRoot, task?.resultArtifact?.path) ?? JSON.stringify(agent, null, 2);
	return result(text, {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadAgentStatus: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	const agent = agentId ? readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId) : undefined;
	const status = agent ? (readCrewAgentStatus(loaded.manifest, agent.taskId) ?? agent) : undefined;
	if (!status)
		return result(
			paramRequired(
				"API read-agent-status",
				"config.agentId matching an agent id or task id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'read-agent-status', agentId: 'agent-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	return result(JSON.stringify(status, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadAgentEvents: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	const agents = readCrewAgents(loaded.manifest);
	const agent = agentId ? agents.find((item) => item.id === agentId || item.taskId === agentId) : agents[0];
	if (!agent)
		return result(
			paramRequired(
				"API read-agent-events",
				"config.agentId matching an agent id or task id, or at least one agent in the run",
				"{ action: 'api', runId: 'team_...', config: { operation: 'read-agent-events', agentId: 'agent-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const sinceSeq = typeof cfg.sinceSeq === "number" ? cfg.sinceSeq : undefined;
	const limit = typeof cfg.limit === "number" ? cfg.limit : undefined;
	const cursorPayload = readCrewAgentEventsCursor(loaded.manifest, agent.taskId, { sinceSeq, limit });
	const payload =
		sinceSeq !== undefined || limit !== undefined ? cursorPayload : { path: cursorPayload.path, events: cursorPayload.events };
	return result(JSON.stringify(payload, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadAgentTranscript: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	const agents = readCrewAgents(loaded.manifest);
	const agent = agentId ? agents.find((item) => item.id === agentId || item.taskId === agentId) : agents[0];
	if (!agent)
		return result(
			paramRequired(
				"API read-agent-transcript",
				"config.agentId matching an agent id or task id, or at least one agent in the run",
				"{ action: 'api', runId: 'team_...', config: { operation: 'read-agent-transcript', agentId: 'agent-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const artifactTranscriptPath = safeContainedPath(loaded.manifest.artifactsRoot, agent.transcriptPath);
	const fallbackPath = agentOutputPath(loaded.manifest, agent.taskId);
	const artifactText = artifactTranscriptPath ? (safeReadContainedFile(loaded.manifest.artifactsRoot, artifactTranscriptPath) ?? "") : "";
	const fallbackText = artifactText ? "" : (safeReadContainedFile(loaded.manifest.stateRoot, fallbackPath) ?? "");
	const transcriptPath = artifactText ? artifactTranscriptPath : fallbackPath;
	const text = artifactText || fallbackText;
	return result(text || `(no transcript at ${transcriptPath})`, {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadAgentOutput: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	const agents = readCrewAgents(loaded.manifest);
	const agent = agentId ? agents.find((item) => item.id === agentId || item.taskId === agentId) : agents[0];
	if (!agent)
		return result(
			paramRequired(
				"API read-agent-output",
				"config.agentId matching an agent id or task id, or at least one agent in the run",
				"{ action: 'api', runId: 'team_...', config: { operation: 'read-agent-output', agentId: 'agent-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const maxBytes = typeof cfg.maxBytes === "number" ? cfg.maxBytes : undefined;
	return result(JSON.stringify(readAgentOutput(loaded.manifest, agent.taskId, maxBytes), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleAgentDashboard: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(buildAgentDashboard(loaded.manifest).text, {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleForegroundStatus: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(JSON.stringify(readForegroundControlStatus(loaded.manifest, loaded.tasks), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleForegroundInterrupt: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result } = hctx;
	const reason = typeof cfg.reason === "string" && cfg.reason.trim() ? cfg.reason.trim() : undefined;
	return result(JSON.stringify(writeForegroundInterruptRequest(loaded.manifest, reason), null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleReadHeartbeat: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const task = findTaskByIdOrStepId(hctx, taskId);
	if (!task)
		return result(
			paramRequired(
				"API read-heartbeat",
				"config.taskId matching a task id or step id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'read-heartbeat', taskId: '01_01-agent' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	return result(JSON.stringify(task.heartbeat ?? null, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleDiff: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	const diffArtifacts = loaded.manifest.artifacts.filter((a) => a.kind === "diff" || a.kind === "patch");
	if (diffArtifacts.length === 0) {
		return result(`No diff artifacts found for run ${loaded.manifest.runId}. Diffs are captured in worktree mode.`, {
			action: "api",
			status: "ok",
			runId: loaded.manifest.runId,
			intent: `diff ${loaded.manifest.runId}: no diffs`,
		});
	}
	const parts: string[] = [`Diff artifacts for run ${loaded.manifest.runId}:`];
	for (const artifact of diffArtifacts) {
		const content = safeReadContainedFile(loaded.manifest.artifactsRoot, artifact.path);
		if (content) {
			const display = content.length > 4000 ? content.slice(0, 4000) + "\n... (truncated)" : content;
			parts.push(`\n--- ${artifact.path} ---\n${display}`);
		}
	}
	return result(parts.join("\n"), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
		intent: `diff ${loaded.manifest.runId}`,
	});
};

/** Pre-runId dispatcher map. Consumed by handleApi BEFORE the runId guard. */
export const PRE_RUNID_OPERATIONS: Record<string, ApiPreHandler> = {
	"metrics-snapshot": handleMetricsSnapshot,
	inventory: handleInventory,
};

/** Dispatcher map for the read/inspect group. Consumed by handleApi. */
export const READ_OPERATIONS: Record<string, ApiOperationHandler> = {
	"read-manifest": handleReadManifest,
	"list-tasks": handleListTasks,
	"read-task": handleReadTask,
	"read-events": handleReadEvents,
	"runtime-capabilities": handleRuntimeCapabilities,
	"probe-live-session": handleProbeLiveSession,
	"list-agents": handleListAgents,
	"get-agent-result": handleGetAgentResult,
	"read-agent-status": handleReadAgentStatus,
	"read-agent-events": handleReadAgentEvents,
	"read-agent-transcript": handleReadAgentTranscript,
	"read-agent-output": handleReadAgentOutput,
	"agent-dashboard": handleAgentDashboard,
	"foreground-status": handleForegroundStatus,
	"foreground-interrupt": handleForegroundInterrupt,
	"read-heartbeat": handleReadHeartbeat,
	diff: handleDiff,
};
