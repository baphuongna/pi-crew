import * as fs from "node:fs";
import type { AgentConfig } from "../../agents/agent-config.ts";
import type { CrewRuntimeConfig } from "../../config/config.ts";
import { writeArtifact } from "../../state/artifact-store.ts";
import {
	appendEventFireAndForget,
} from "../../state/event-log.ts";
import type {
	ArtifactDescriptor,
	TeamRunManifest,
	TeamTaskState,
} from "../../state/types.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import { persistSingleTaskUpdate } from "./state-helpers.ts";
import type { WorkflowStep } from "../../workflows/workflow-config.ts";
import { appendCrewAgentEvent, appendCrewAgentOutput, emptyCrewAgentProgress, recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../worker-heartbeat.ts";
import { createStartupEvidence, type WorkerStartupEvidence } from "../worker-startup.ts";
import { runLiveSessionTask } from "../live-session-runtime.ts";
import { shouldAppendProgressEventUpdate, type ProgressEventSummary } from "../progress-event-coalescer.ts";
import { applyAgentProgressEvent, applyUsageToProgress, progressEventSummary, shouldFlushProgressEvent } from "./progress.ts";
import type { ParsedPiJsonOutput } from "../pi-json-output.ts";

export interface RunLiveTaskInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	task: TeamTaskState;
	step: WorkflowStep;
	agent: AgentConfig;
	prompt: string;
	signal?: AbortSignal;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	modelOverride?: string;
	teamRoleModel?: string;
	isCurrent?: () => boolean;
	/** Workspace where this task run was initiated — used for session-scoped live-agent visibility. */
	workspaceId: string;
	/** Phase 2: Output schema for validating yield data. */
	outputSchema?: unknown;
}

export interface RunLiveTaskOutput {
	task: TeamTaskState;
	tasks: TeamTaskState[];
	startupEvidence: WorkerStartupEvidence;
	exitCode: number | null;
	error?: string;
	parsedOutput?: ParsedPiJsonOutput;
	resultArtifact: ArtifactDescriptor;
	logArtifact?: ArtifactDescriptor;
	transcriptArtifact?: ArtifactDescriptor;
}

function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => task.id === updated.id ? updated : task);
}

export async function runLiveTask(input: RunLiveTaskInput): Promise<RunLiveTaskOutput> {
	const { manifest, step, agent, prompt } = input;
	let task = input.task;
	let tasks = input.tasks;
	const transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.jsonl`;
	const isCurrent = input.isCurrent ?? (() => {
		if (input.signal?.aborted) return false;
		const loaded = loadRunManifestById(manifest.cwd, manifest.runId);
		const currentTask = loaded?.tasks.find((item) => item.id === task.id);
		if (loaded?.manifest.status && loaded.manifest.status !== "running") return false;
		return currentTask ? currentTask.status === "running" : true;
	});
	let lastAgentRecordPersistedAt = 0;
	let lastRunProgressPersistedAt = 0;
	let lastHeartbeatPersistedAt = 0;
	let lastRunProgressSummary: ProgressEventSummary | undefined;
	const persistLiveProgress = (event: unknown, force = false): void => {
		if (!isCurrent()) return;
		const now = Date.now();
		if (force || shouldFlushProgressEvent(event) || now - lastAgentRecordPersistedAt >= 500) {
			upsertCrewAgent(manifest, recordFromTask(manifest, task, "live-session"));
			lastAgentRecordPersistedAt = now;
		}
		// Bug #5 fix: also persist heartbeat to tasks.json so heartbeat-watcher can detect live-session activity
		if (force || now - lastHeartbeatPersistedAt >= 1000) {
			task = {
				...task,
				heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id)),
			};
			tasks = persistSingleTaskUpdate(manifest, tasks, task);
			lastHeartbeatPersistedAt = now;
		}
		const summary = progressEventSummary(task, event);
		const decision = shouldAppendProgressEventUpdate({ previous: lastRunProgressSummary, next: summary, nowMs: now, lastAppendMs: lastRunProgressPersistedAt || undefined, minIntervalMs: 1000, force });
		if (decision.shouldAppend) {
			// 2.2 caller migration: see task-runner.ts.
			appendEventFireAndForget(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, taskId: task.id, data: { ...summary, coalesceReason: decision.reason } });
			lastRunProgressSummary = summary;
			lastRunProgressPersistedAt = now;
		}
	};
	const attemptStartedAt = new Date();
	// Apply agent-level maxTurns override if specified (only positive integers)
	const agentMax = agent.maxTurns;
	const effectiveRuntimeConfig = (agentMax != null && agentMax > 0 &&
		(!input.runtimeConfig?.maxTurns || agentMax < input.runtimeConfig.maxTurns))
		? { ...input.runtimeConfig, maxTurns: agentMax }
		: input.runtimeConfig;
	const liveResult = await runLiveSessionTask({
		manifest,
		task,
		step,
		agent,
		prompt,
		signal: input.signal,
		transcriptPath,
		runtimeConfig: effectiveRuntimeConfig,
		parentContext: input.parentContext,
		parentModel: input.parentModel,
		modelRegistry: input.modelRegistry,
		modelOverride: input.modelOverride,
		teamRoleModel: input.teamRoleModel,
		isCurrent,
		workspaceId: input.workspaceId,
		// Phase 2: Pass output schema for yield validation
		outputSchema: undefined,
		onOutput: (text) => {
			if (!isCurrent()) return;
			appendCrewAgentOutput(manifest, task.id, text);
		},
		onEvent: (event) => {
			if (!isCurrent()) return;
			appendCrewAgentEvent(manifest, task.id, event);
			task = { ...task, agentProgress: applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt) };
			tasks = updateTask(tasks, task);
			persistLiveProgress(event);
		},
	});
	const startupEvidence = createStartupEvidence({ command: "live-session", startedAt: attemptStartedAt, finishedAt: new Date(), promptSentAt: attemptStartedAt, promptAccepted: liveResult.exitCode === 0 && !liveResult.error, stderr: liveResult.stderr, error: liveResult.error, exitCode: liveResult.exitCode });
	const exitCode = liveResult.exitCode;
	const error = liveResult.error || (liveResult.exitCode && liveResult.exitCode !== 0 ? liveResult.stderr || `Live session exited with ${liveResult.exitCode}` : undefined);
	const parsedOutput = { finalText: liveResult.stdout, textEvents: liveResult.stdout ? [liveResult.stdout] : [], jsonEvents: liveResult.jsonEvents, usage: liveResult.usage };
	if (liveResult.usage && isCurrent()) task = { ...task, usage: liveResult.usage, agentProgress: applyUsageToProgress(task.agentProgress, liveResult.usage) };
	persistLiveProgress({ type: "attempt_finished" }, true);
	const resultArtifact = writeArtifact(manifest.artifactsRoot, { kind: "result", relativePath: `results/${task.id}.txt`, content: liveResult.stdout || liveResult.stderr || "(no output)", producer: task.id });
	const logArtifact = writeArtifact(manifest.artifactsRoot, { kind: "log", relativePath: `logs/${task.id}.log`, content: [`runtime=live-session`, `finalExitCode=${exitCode ?? "null"}`, `jsonEvents=${liveResult.jsonEvents}`, liveResult.usage ? `usage=${JSON.stringify(liveResult.usage)}` : "", "", "STDOUT:", liveResult.stdout, "", "STDERR:", liveResult.stderr].join("\n"), producer: task.id });
	const transcriptArtifact = fs.existsSync(transcriptPath) ? writeArtifact(manifest.artifactsRoot, { kind: "log", relativePath: `transcripts/${task.id}.jsonl`, content: fs.readFileSync(transcriptPath, "utf-8"), producer: task.id }) : undefined;
	return { task, tasks, startupEvidence, exitCode, error: error || undefined, parsedOutput, resultArtifact, logArtifact, transcriptArtifact };
}
