import * as fs from "node:fs";
import type { AgentConfig } from "../../agents/agent-config.ts";
import type { CrewRuntimeConfig } from "../../config/config.ts";
import { appendEventFireAndForget } from "../../state/event-log/event-log.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { WorkflowStep } from "../../workflows/workflow-config.ts";
import {
	appendCrewAgentEvent,
	appendCrewAgentOutput,
	emptyCrewAgentProgress,
	recordFromTask,
	upsertCrewAgent,
} from "../crew-agent-records.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../heartbeat/worker-heartbeat.ts";
import { createStartupEvidence, type WorkerStartupEvidence } from "../heartbeat/worker-startup.ts";
// Type-only imports (erased at runtime): lane-B U11 contract types. The
// live-session layer OWNS the mitigation/fault taxonomy; this seam only
// threads + surfaces it (Phase-1 interface contract).
import type { LiveSessionEmbeddedMitigations, LiveSessionFault } from "../live-session/embedded-tier.ts";
import { runLiveSessionTask } from "../live-session/live-session-runtime.ts";
import type { ParsedPiJsonOutput } from "../output/pi-json-output.ts";
import { type ProgressEventSummary, shouldAppendProgressEventUpdate } from "../output/progress-event-coalescer.ts";
import { applyAgentProgressEvent, applyUsageToProgress, progressEventSummary, shouldFlushProgressEvent } from "./progress.ts";
import { persistSingleTaskUpdate } from "./state-helpers.ts";

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
	teamRoleFallbackModels?: string[];
	teamRoleThinking?: string;
	isCurrent?: () => boolean;
	/** Workspace where this task run was initiated — used for session-scoped live-agent visibility. */
	workspaceId: string;
	/** Phase 2: Output schema for validating yield data. */
	outputSchema?: unknown;
	/**
	 * U11 (hybrid 2-tier): embedded-tier mitigation knobs, passed by the
	 * hybrid orchestration layer (task-runner/hybrid-tier.ts) ONLY for a task
	 * routed to the embedded tier. Forwarded verbatim to runLiveSessionTask —
	 * the live-session layer keeps every mitigation inert when this is
	 * undefined (lane-B DEFAULT-OFF contract). Never set on the legacy
	 * live-session path.
	 */
	embeddedMitigations?: LiveSessionEmbeddedMitigations;
}

export interface RunLiveTaskOutput {
	task: TeamTaskState;
	tasks: TeamTaskState[];
	startupEvidence: WorkerStartupEvidence;
	exitCode: number | null;
	error?: string;
	/**
	 * U11 fault-signal surfacing (Phase-1 interface contract between the
	 * hybrid-tier orchestration layer and the live-session layer): the
	 * classified fault for a FAILED live attempt. Prefers the fault the
	 * live-session runtime attached (embedded path) and falls back to a
	 * string-shape classifier at this seam (legacy shapes / hand-built
	 * results). `undefined` = the attempt did not fault. `countAsFault`
	 * is the hybrid layer's counting gate (aborted / capacity-rejected are
	 * routing signals, not worker faults).
	 */
	fault?: LiveSessionFault;
	parsedOutput?: ParsedPiJsonOutput;
	resultArtifact: ArtifactDescriptor;
	logArtifact?: ArtifactDescriptor;
	transcriptArtifact?: ArtifactDescriptor;
}

/**
 * U11 fault classification fallback (Phase-1 interface contract). Used only
 * when the live-session runtime did NOT attach a `fault` (embedded path
 * always attaches; legacy results and hand-built test results do not).
 * Ordered most-specific-first because the live-session error strings overlap
 * (the hung-tool message contains both "timeout" and "cooperative abort").
 * `countAsFault` follows the lane-B contract: "aborted" is a routing
 * signal (never counted toward the 2-fault budget), everything else counts.
 */
export function classifyLiveTaskFault(error: string | undefined, stderr: string, exitCode: number | null): LiveSessionFault | undefined {
	const faulted = error !== undefined || (exitCode !== null && exitCode !== 0);
	if (!faulted) return undefined;
	const text = `${error ?? ""}\n${stderr}`;
	if (text.includes("escape hatch")) return { kind: "hung-tool", detail: text, countAsFault: true };
	if (/\babort/i.test(text)) return { kind: "aborted", detail: text, countAsFault: false };
	if (/timed?\s?out|timeout/i.test(text)) return { kind: "response-timeout", detail: text, countAsFault: true };
	if (error !== undefined) return { kind: "session-error", detail: text, countAsFault: true };
	return { kind: "nonzero-exit", detail: text, countAsFault: true };
}

function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => (task.id === updated.id ? updated : task));
}

/**
 * Wave 13 (F2, GAP-1): default cadence (ms) of the live-executor tool
 * heartbeat timer. 30s sits far inside every liveness window that consumes
 * the task heartbeat (watchdog task-heartbeat evidence 5 min, stale-reconciler
 * ACTIVE_EVIDENCE_TTL_MS 5 min, CLAIMED_RUN_HUNG_MS 45 min), costs at most one
 * throttled tasks.json persist per running tool per 30s, and never touches
 * the event log. Fixed constant, NOT env-configurable on purpose (SPEC §3.2):
 * wiring an env kill-switch would require registering
 * PI_CREW_LIVE_HEARTBEAT_MS in src/config/env-vars.ts AND a forwarding
 * decision in src/config/env-allowlist-registry.ts (fail-fast at module
 * load) — both outside this wave's file scope.
 */
export const LIVE_TOOL_HEARTBEAT_INTERVAL_MS = 30_000;

/** Opaque handle for the per-attempt live tool heartbeat timer. */
export interface LiveToolHeartbeatTimer {
	/** Stop the timer and clear its interval. Idempotent. */
	stop(): void;
}

/**
 * Wave 13 (F2, GAP-1) — start the tool heartbeat timer for one live attempt
 * (SPEC §3.2). Every `intervalMs`, IF a tool is currently executing
 * (`isToolInFlight()` — `agentProgress.currentToolStartedAt` set by
 * tool_execution_start, cleared by tool_execution_end), call `touch()`
 * (the heartbeat-only persist, shared 1s throttle with event-driven persists).
 * Idle between tools ⇒ no write. `touch` must NOT append task.progress events
 * so the event log cannot grow from heartbeats.
 *
 * Failure containment (mirrors startWorkerHeartbeatPulse [pulse-3]): a
 * throwing gate/touch is logged and the timer keeps ticking — the heartbeat
 * must never crash the host process. The interval is `unref`'d so it can
 * never hold the event loop open.
 */
export function startLiveToolHeartbeatTimer(opts: {
	intervalMs: number;
	isToolInFlight: () => boolean;
	touch: () => void;
}): LiveToolHeartbeatTimer {
	// Kill-switch shape (interval ≤ 0 ⇒ disabled, no timer) kept so a future
	// env-configurable interval can slot in without touching call sites.
	if (opts.intervalMs <= 0) {
		return {
			stop() {
				// Intentional no-op: a disabled timer (interval ≤ 0) has no handle.
			},
		};
	}
	const timer = setInterval(() => {
		try {
			if (opts.isToolInFlight()) opts.touch();
		} catch (err) {
			logInternalError("task-runner.live-tool-heartbeat", err as Error);
		}
	}, opts.intervalMs);
	timer.unref?.();
	return {
		stop() {
			clearInterval(timer);
		},
	};
}

let armLiveToolHeartbeatTimer: typeof startLiveToolHeartbeatTimer = startLiveToolHeartbeatTimer;

/**
 * @internal Test seam — replace the timer constructor used inside runLiveTask
 * (null = real). Mirrors the loader seams in foreground-watchdog.ts.
 */
export function setLiveToolHeartbeatTimerForTests(starter: typeof startLiveToolHeartbeatTimer | null): void {
	armLiveToolHeartbeatTimer = starter ?? startLiveToolHeartbeatTimer;
}

export async function runLiveTask(input: RunLiveTaskInput): Promise<RunLiveTaskOutput> {
	const { manifest, step, agent, prompt } = input;
	let task = input.task;
	let tasks = input.tasks;
	const transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.jsonl`;
	const isCurrent =
		input.isCurrent ??
		(() => {
			if (input.signal?.aborted) return false;
			const loaded = loadRunManifestById(manifest.cwd, manifest.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
			const currentTask = loaded?.tasks.find((item) => item.id === task.id);
			if (loaded?.manifest.status && loaded.manifest.status !== "running") return false;
			return currentTask ? currentTask.status === "running" : true;
		});
	let lastAgentRecordPersistedAt = 0;
	let lastRunProgressPersistedAt = 0;
	let lastHeartbeatPersistedAt = 0;
	let lastRunProgressSummary: ProgressEventSummary | undefined;
	/**
	 * Wave 13 (F2, GAP-1): heartbeat-only persist, extracted from
	 * persistLiveProgress so the tool heartbeat timer can reuse the EXACT
	 * event-driven path (same 1s throttle via the shared lastHeartbeatPersistedAt,
	 * same persistSingleTaskUpdate write, same isCurrent gate). Touching only
	 * tasks.json — never the event log — so timer ticks cannot inflate it.
	 */
	const touchTaskHeartbeat = (force = false): void => {
		if (!isCurrent()) return;
		const now = Date.now();
		if (!force && now - lastHeartbeatPersistedAt < 1000) return;
		// FIX-2 note: no pid at write time — live-session workers run IN this
		// process (no child pid exists); the watcher PID-gate stays unarmed for
		// live-session tasks (their activity stream is the liveness evidence).
		task = {
			...task,
			heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id)),
		};
		tasks = persistSingleTaskUpdate(manifest, tasks, task);
		lastHeartbeatPersistedAt = now;
	};
	const persistLiveProgress = (event: unknown, force = false): void => {
		if (!isCurrent()) return;
		const now = Date.now();
		if (force || shouldFlushProgressEvent(event) || now - lastAgentRecordPersistedAt >= 500) {
			upsertCrewAgent(manifest, recordFromTask(manifest, task, "live-session"));
			lastAgentRecordPersistedAt = now;
		}
		// Bug #5 fix: also persist heartbeat to tasks.json so heartbeat-watcher can detect live-session activity
		touchTaskHeartbeat(force);
		const summary = progressEventSummary(task, event);
		const decision = shouldAppendProgressEventUpdate({
			previous: lastRunProgressSummary,
			next: summary,
			nowMs: now,
			lastAppendMs: lastRunProgressPersistedAt || undefined,
			minIntervalMs: 1000,
			force,
		});
		if (decision.shouldAppend) {
			// 2.2 caller migration: see task-runner.ts.
			appendEventFireAndForget(manifest.eventsPath, {
				type: "task.progress",
				runId: manifest.runId,
				taskId: task.id,
				data: { ...summary, coalesceReason: decision.reason },
			});
			lastRunProgressSummary = summary;
			lastRunProgressPersistedAt = now;
		}
	};
	const attemptStartedAt = new Date();
	// Apply agent-level maxTurns override if specified (only positive integers)
	const agentMax = agent.maxTurns;
	const effectiveRuntimeConfig =
		agentMax != null && agentMax > 0 && (!input.runtimeConfig?.maxTurns || agentMax < input.runtimeConfig.maxTurns)
			? { ...input.runtimeConfig, maxTurns: agentMax }
			: input.runtimeConfig;
	// Wave 13 (F2, GAP-1): arm the tool heartbeat timer for this attempt. The
	// tick no-ops unless a tool is executing (agentProgress.currentToolStartedAt
	// set by tool_execution_start / cleared by tool_execution_end), so idle gaps
	// between tools write nothing; the shared 1s throttle inside
	// touchTaskHeartbeat bounds disk writes; and the finally below clears the
	// interval on completion, throw AND cancel — no timer leak across attempts.
	const heartbeatTimer = armLiveToolHeartbeatTimer({
		intervalMs: LIVE_TOOL_HEARTBEAT_INTERVAL_MS,
		isToolInFlight: () => task.agentProgress?.currentToolStartedAt !== undefined,
		touch: () => touchTaskHeartbeat(false),
	});
	let liveResult: Awaited<ReturnType<typeof runLiveSessionTask>>;
	try {
		liveResult = await runLiveSessionTask({
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
			teamRoleFallbackModels: input.teamRoleFallbackModels,
			teamRoleThinking: input.teamRoleThinking,
			isCurrent,
			workspaceId: input.workspaceId,
			// U11: embedded-tier mitigation knobs (lane-B contract) — forwarded
			// verbatim; undefined keeps every mitigation inert (legacy path).
			embeddedMitigations: input.embeddedMitigations,
			// Phase 2: Pass output schema for yield validation
			outputSchema: undefined,
			onOutput: (text) => {
				if (!isCurrent()) return;
				appendCrewAgentOutput(manifest, task.id, text);
			},
			onEvent: (event) => {
				if (!isCurrent()) return;
				appendCrewAgentEvent(manifest, task.id, event);
				task = {
					...task,
					agentProgress: applyAgentProgressEvent(task.agentProgress ?? emptyCrewAgentProgress(), event, task.startedAt),
				};
				tasks = updateTask(tasks, task);
				persistLiveProgress(event);
			},
		});
	} finally {
		heartbeatTimer.stop();
	}
	const startupEvidence = createStartupEvidence({
		command: "live-session",
		startedAt: attemptStartedAt,
		finishedAt: new Date(),
		promptSentAt: attemptStartedAt,
		promptAccepted: liveResult.exitCode === 0 && !liveResult.error,
		stderr: liveResult.stderr,
		error: liveResult.error,
		exitCode: liveResult.exitCode,
	});
	const exitCode = liveResult.exitCode;
	const error =
		liveResult.error ||
		(liveResult.exitCode && liveResult.exitCode !== 0
			? liveResult.stderr || `Live session exited with ${liveResult.exitCode}`
			: undefined);
	// U11 (Phase-1 interface contract): surface the classified fault for the
	// hybrid tier's counting gate. Prefer the fault attached by the
	// live-session runtime (embedded path); fall back to the seam classifier
	// for legacy/hand-built result shapes.
	const fault = liveResult.fault ?? classifyLiveTaskFault(liveResult.error, liveResult.stderr, liveResult.exitCode);
	const parsedOutput = {
		finalText: liveResult.stdout,
		textEvents: liveResult.stdout ? [liveResult.stdout] : [],
		jsonEvents: liveResult.jsonEvents,
		usage: liveResult.usage,
	};
	if (liveResult.usage && isCurrent())
		task = {
			...task,
			usage: liveResult.usage,
			agentProgress: applyUsageToProgress(task.agentProgress, liveResult.usage),
		};
	if (liveResult.modelRouting)
		task = {
			...task,
			modelRouting: {
				...liveResult.modelRouting,
				usedAttempt: 0,
			},
		};
	persistLiveProgress({ type: "attempt_finished" }, true);
	const resultArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "result",
		relativePath: `results/${task.id}.txt`,
		content: liveResult.stdout || liveResult.stderr || "(no output)",
		producer: task.id,
	});
	const logArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "log",
		relativePath: `logs/${task.id}.log`,
		content: [
			`runtime=live-session`,
			`finalExitCode=${exitCode ?? "null"}`,
			`jsonEvents=${liveResult.jsonEvents}`,
			liveResult.usage ? `usage=${JSON.stringify(liveResult.usage)}` : "",
			"",
			"STDOUT:",
			liveResult.stdout,
			"",
			"STDERR:",
			liveResult.stderr,
		].join("\n"),
		producer: task.id,
	});
	const transcriptArtifact = fs.existsSync(transcriptPath)
		? writeArtifact(manifest.artifactsRoot, {
				kind: "log",
				relativePath: `transcripts/${task.id}.jsonl`,
				content: fs.readFileSync(transcriptPath, "utf-8"),
				producer: task.id,
			})
		: undefined;
	return {
		task,
		tasks,
		startupEvidence,
		exitCode,
		error: error || undefined,
		fault,
		parsedOutput,
		resultArtifact,
		logArtifact,
		transcriptArtifact,
	};
}
