import type { AgentConfig } from "../../agents/agent-config.ts";
import type { CrewReliabilityConfig, CrewRuntimeConfig } from "../../config/types.ts";
import { appendEventAsync } from "../../state/event-log/event-log.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import { loadRunManifestById, saveRunTasksAsync, updateRunStatus } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import type { WorkflowStep } from "../../workflows/workflow-config.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../heartbeat/worker-heartbeat.ts";
import type { CrewRuntimeMode } from "../model/runtime-resolver.ts";
import type { RetryPolicy } from "../recovery/retry-executor.ts";
import { DEFAULT_RETRY_POLICY, executeWithRetry } from "../recovery/retry-executor.ts";
import { permissionForRole } from "../role-permission.ts";
import { runWorker } from "../run-worker.ts";
import { sanitizeTaskText } from "../task-packet.ts";
import { splitCoalescedOutput } from "../task-runner/output-splitter.ts";
import { mergeArtifacts } from "../team-runner-artifacts.ts";
import { buildWorkspaceTree } from "../workspace-tree.ts";

export interface CoalescedTaskGroupInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	groupTasks: TeamTaskState[];
	step: WorkflowStep;
	agent: AgentConfig;
	signal?: AbortSignal;
	executeWorkers: boolean;
	runtimeKind?: CrewRuntimeMode;
	workspaceId: string;
	onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
	teamRole?: unknown;
	perTaskRuntime?: CrewRuntimeMode;
	/** RT-5: runtime config for maxTurns, graceTurns, taskTimeoutMs (mirror singleton). */
	runtimeConfig?: CrewRuntimeConfig;
	/** RT-5: reliability config for autoRetry + retryPolicy (mirror singleton). */
	reliability?: CrewReliabilityConfig;
}

export interface CoalescedTaskGroupResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	taskIds: string[];
	rawOutput: string;
	success: boolean;
}

export async function runCoalescedTaskGroup(input: CoalescedTaskGroupInput): Promise<CoalescedTaskGroupResult> {
	const { manifest, groupTasks, step, agent, signal, executeWorkers } = input;
	const groupId = groupTasks.map((t) => t.id).join("+");
	const firstTask = groupTasks[0]!;
	const taskIds = groupTasks.map((t) => t.id);

	// Set ALL N tasks to "running" before spawn so the dashboard reflects
	// the in-flight state.
	let updatedTasks: TeamTaskState[] = input.tasks.map((t) => {
		if (taskIds.includes(t.id) && t.status !== "running") {
			return { ...t, status: "running" as const, startedAt: new Date().toISOString() };
		}
		return t;
	});
	await saveRunTasksAsync(manifest, updatedTasks);
	await appendEventAsync(manifest.eventsPath, {
		type: "task.coalesced_dispatch_start",
		runId: manifest.runId,
		message: `Dispatching ${groupTasks.length} coalesced tasks in 1 worker (role=${firstTask.role}, cwd=${firstTask.cwd})`,
		data: { groupId, role: firstTask.role, cwd: firstTask.cwd, taskIds },
	});

	const combinedPrompt = await buildCoalescedPrompt(manifest, step, groupTasks, agent);

	// FIX (M6): write heartbeats for ALL N tasks in the coalesced group so the
	// background watcher doesn't fire heartbeat_dead against the (single)
	// child pi worker. Previously runCoalescedTaskGroup never wrote heartbeats,
	// so the watcher saw `heartbeat.lastSeenAt: undefined` within 2 seconds of
	// spawn and emitted heartbeat_dead even though the worker continued to
	// completion (false-positive stuck-worker alarms). The singleton path
	// (runTeamTask) writes heartbeats via persistHeartbeat — M6 needs the
	// equivalent to avoid the false-positive.
	updatedTasks = updatedTasks.map((t) => {
		if (!taskIds.includes(t.id)) return t;
		return {
			...t,
			heartbeat: t.heartbeat ?? createWorkerHeartbeat(t.id),
		};
	});
	await saveRunTasksAsync(manifest, updatedTasks);

	let rawOutput = "";
	let success = false;
	// RT-5 #1: track cancellation separately from failure so the status
	// mapping can branch cancel → "cancelled" (not "failed").
	let cancelled = false;
	// FIND-06: serialize heartbeat saves and retain the active save so terminal
	// results can drain it before their final write.
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let heartbeatInFlight = false;
	let heartbeatPromise: Promise<void> | null = null;
	// FIND-06 P1 fix (R1 review): a heartbeat save that exceeds the 5s drain
	// timeout continues in the background and can rename its temp file AFTER
	// the terminal write, clobbering terminal state with the pre-terminal
	// snapshot. finalWriteStarted lets the IIFE repair that by re-writing the
	// (now-terminal) updatedTasks AFTER its own save resolves, so the terminal
	// state always lands last regardless of disk timing.
	let finalWriteStarted = false;
	if (!executeWorkers) {
		rawOutput = buildScaffoldOutput(groupTasks);
		success = true;
	} else {
		// Heartbeat refresher: touch every task's heartbeat every 15s while the
		// worker is alive. Set `alive: true` explicitly so post-completion
		// staleness checks immediately recognize liveness.
		heartbeatTimer = setInterval(() => {
			// FIND-06: setInterval does not await async callbacks. Do not start a
			// second read/modify/write while the preceding heartbeat save is active.
			if (heartbeatInFlight) return;
			heartbeatInFlight = true;
			heartbeatPromise = (async () => {
				try {
					// R15-3: persist heartbeats for ONLY this group's tasks via a fresh
					// disk read. The old closure `updatedTasks` is a dispatch-time
					// snapshot of the FULL task array — a sibling cancelled on disk after
					// dispatch could be un-cancelled by a late heartbeat save (the map
					// only mutated group tasks, but the SAVE wrote the whole stale array).
					await persistGroupHeartbeats(manifest, taskIds);
				} catch {
					// Run may have been pruned mid-dispatch — best-effort only.
				} finally {
					heartbeatInFlight = false;
					// FIND-06 P1 fix: if the terminal write started while our heartbeat
					// save was in flight, re-write the (now-terminal) updatedTasks so
					// our late snapshot cannot leave stale pre-terminal state on disk.
					// Runs after our own save resolves, so it always lands last.
					// R15-3: the repair now fresh-reads disk and re-applies ONLY the
					// group's terminal state — the old full-array write could resurrect
					// a sibling cancelled on disk (same flaw as the heartbeat save).
					if (finalWriteStarted) {
						try {
							await repairGroupTerminalWrite(manifest, taskIds, updatedTasks);
						} catch {
							// best-effort repair — same swallow policy as the heartbeat.
						}
					}
				}
			})();
		}, 15_000);
		// RT-5 #3/#4/#5: compute maxTurns, wall-clock timeout, and retry policy
		// from config instead of hardcoding — mirrors the singleton path
		// (team-runner.ts:1548-1578 + child-executor.ts:395-430).
		const taskTimeoutMs = input.runtimeConfig?.taskTimeoutMs ?? 0;
		const useRetry = input.reliability?.autoRetry !== false;
		const policy: RetryPolicy = {
			...DEFAULT_RETRY_POLICY,
			...(input.reliability?.retryPolicy ?? {}),
		};
		// RT-5 #3: pass maxTurns from config instead of hardcoded 5.
		// RT-5 #4: arm a per-attempt wall-clock timeout mirroring the singleton's
		// AbortController+setTimeout pattern (child-executor.ts:395-430). The
		// timeoutController is linked to the run-level signal so an external
		// abort also aborts the worker. Its signal is passed to runWorker; the
		// existing SIGTERM→SIGKILL escalation in child-pi.ts handles cleanup.
		const runOnce = async () => {
			const timeoutController = new AbortController();
			let externalAbortListener: (() => void) | undefined;
			if (signal) {
				if (signal.aborted) {
					timeoutController.abort(signal.reason);
				} else {
					externalAbortListener = () => timeoutController.abort(signal!.reason);
					signal.addEventListener("abort", externalAbortListener, { once: true });
				}
			}
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			if (taskTimeoutMs > 0 && !timeoutController.signal.aborted) {
				timeoutHandle = setTimeout(() => {
					if (!timeoutController.signal.aborted) {
						timeoutController.abort(new Error(`Task exceeded wall-clock timeout of ${taskTimeoutMs}ms`));
					}
				}, taskTimeoutMs);
				timeoutHandle.unref?.();
			}
			try {
				return await runWorker({
					cwd: firstTask.cwd,
					task: combinedPrompt,
					agent,
					signal: timeoutController.signal,
					excludeContextBash: true,
					maxTurns: input.runtimeConfig?.maxTurns,
					graceTurns: input.runtimeConfig?.graceTurns,
					onJsonEvent: (e) => input.onJsonEvent?.(firstTask.id, manifest.runId, e),
				});
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (externalAbortListener && signal) {
					signal.removeEventListener("abort", externalAbortListener);
				}
			}
		};
		try {
			const result = useRetry ? await executeWithRetry(runOnce, policy, { signal }) : await runOnce();
			rawOutput = result.rawFinalText ?? result.stdout ?? "";
			// RT-5 #1/#2: distinguish cancel from failure. Cancel = run-level
			// signal aborted OR the child reports cooperative cancellation.
			// success requires exitCode===0 AND no error AND not cancelled
			// (previously success = exitCode===0 only, which misreported
			// depth-guard exitCode:1 and ignored the error field).
			cancelled = signal?.aborted === true || result.exitStatus?.cancelled === true;
			success = !cancelled && result.exitCode === 0 && !result.error;
		} catch (err) {
			// RT-5 #1: detect cancel in the throw path (e.g. executeWithRetry's
			// throwIfCancelled when the run-level signal is already aborted).
			cancelled = signal?.aborted === true;
			rawOutput = cancelled
				? `Worker dispatch cancelled: ${err instanceof Error ? err.message : String(err)}`
				: `Worker dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
			success = false;
		} finally {
			if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
		}
	}

	const split = splitCoalescedOutput(rawOutput, taskIds);

	const finishedAt = new Date().toISOString();
	const newArtifacts: TeamRunManifest["artifacts"] = [];
	updatedTasks = updatedTasks.map((t) => {
		if (!taskIds.includes(t.id)) return t;
		const entry = split.find((s) => s.taskId === t.id);
		const ok = success && Boolean(entry?.text);
		const text = entry?.text ?? rawOutput;
		// BUGFIX (M6 real dispatch): write to artifactsRoot via writeArtifact
		// so task.resultArtifact is set and aggregateTaskOutputs can read
		// the per-task text. Previously the coalesced path used a raw
		// writeFile to stateRoot/results/<id>.txt which aggregated task
		// outputs could not locate — they only consult task.resultArtifact.
		// Result: tasks reported "EMPTY OUTPUT" in the batch summary even
		// though on-disk results were correct.
		const resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${t.id}.txt`,
			content: text,
			producer: t.id,
		});
		newArtifacts.push(resultArtifact);
		return {
			...t,
			status: ok ? ("completed" as const) : cancelled ? ("cancelled" as const) : ("failed" as const),
			finishedAt,
			result: {
				text,
				producer: groupId,
				strategy: entry?.strategy ?? "broadcast",
			},
			resultArtifact,
		};
	});

	// FIND-06: stop ticks and drain the snapshot captured by any active
	// heartbeat before persisting terminal results. Bound the wait so a stuck
	// filesystem operation cannot block dispatch completion indefinitely.
	// P1 fix (R1 review): set finalWriteStarted BEFORE the drain so any pending
	// heartbeat IIFE observes it and re-writes the terminal state after its
	// own (possibly late) save resolves — preventing a late heartbeat snapshot
	// from clobbering the terminal write.
	finalWriteStarted = true;
	if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
	const pendingHeartbeat = heartbeatPromise;
	if (pendingHeartbeat) {
		let drainTimeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				pendingHeartbeat,
				new Promise<void>((resolve) => {
					drainTimeout = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			if (drainTimeout !== undefined) clearTimeout(drainTimeout);
		}
	}
	await saveRunTasksAsync(manifest, updatedTasks);
	let updatedManifest: TeamRunManifest = {
		...manifest,
		artifacts: mergeArtifacts([...manifest.artifacts, ...newArtifacts]),
	};

	if (success) {
		updatedManifest = updateRunStatus(updatedManifest, "running");
	}
	await appendEventAsync(updatedManifest.eventsPath, {
		type: "task.coalesced_dispatch_end",
		runId: manifest.runId,
		message: `Coalesced dispatch ${success ? "completed" : cancelled ? "cancelled" : "failed"} (${taskIds.length} tasks, ${split[0]?.strategy ?? "broadcast"} split)`,
		data: { groupId, taskIds, success, cancelled, strategy: split[0]?.strategy },
	});

	return { manifest: updatedManifest, tasks: updatedTasks, taskIds, rawOutput, success };
}

/**
 * R15-3: heartbeat save scoped to this coalesced group only.
 *
 * Previously the heartbeat wrote the dispatch-time closure `updatedTasks` —
 * the FULL task array including sibling tasks outside this group. A sibling
 * cancelled on disk after dispatch (external cancel / reconciler) could be
 * un-cancelled ("resurrected") by a late heartbeat save, because the map only
 * mutated group tasks but the SAVE wrote the whole stale array. Fix: fresh
 * re-read tasks from disk (loadRunManifestById — the established fresh-read
 * pattern used by team-runner) and write back ONLY the group's own task ids
 * with heartbeats touched; sibling tasks are preserved untouched from the
 * fresh disk read. Keeps the FIND-06 'never replace terminal state' guard.
 */
async function persistGroupHeartbeats(manifest: TeamRunManifest, taskIds: string[]): Promise<void> {
	const fresh = loadRunManifestById(manifest.cwd, manifest.runId);
	if (!fresh) return; // run pruned mid-dispatch — best-effort only.
	const merged = fresh.tasks.map((t) => {
		if (!taskIds.includes(t.id)) return t; // sibling tasks: preserved untouched.
		// FIND-06 belt-and-suspenders: never replace terminal state or its
		// resultArtifact with a heartbeat-only snapshot.
		if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return t;
		return {
			...t,
			heartbeat: touchWorkerHeartbeat(t.heartbeat ?? createWorkerHeartbeat(t.id), { alive: true }),
		};
	});
	await saveRunTasksAsync(manifest, merged);
}

/**
 * R15-3: FIND-06 P1 repair — re-apply the group's terminal state after a late
 * heartbeat save may have landed last. Fresh-reads disk so sibling tasks are
 * preserved untouched; only the group's own terminal state from `updatedTasks`
 * is re-applied, and a disk-terminal group task is never flipped (same
 * belt-and-suspenders guard as the heartbeat).
 */
async function repairGroupTerminalWrite(
	manifest: TeamRunManifest,
	taskIds: string[],
	updatedTasks: TeamTaskState[],
): Promise<void> {
	const fresh = loadRunManifestById(manifest.cwd, manifest.runId);
	if (!fresh) return; // run pruned mid-dispatch — best-effort only.
	const groupById = new Map(updatedTasks.map((t) => [t.id, t] as const));
	const merged = fresh.tasks.map((t) => {
		if (!taskIds.includes(t.id)) return t; // sibling tasks: preserved untouched.
		if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return t;
		return groupById.get(t.id) ?? t;
	});
	await saveRunTasksAsync(manifest, merged);
}

/** @internal 3.5 R15-3 test export — exercise the heartbeat/repair writes directly. */
export const __test__persistGroupHeartbeats = persistGroupHeartbeats;
/** @internal 3.5 R15-3 test export — exercise the terminal repair write directly. */
export const __test__repairGroupTerminalWrite = repairGroupTerminalWrite;

async function buildCoalescedPrompt(
	manifest: TeamRunManifest,
	step: WorkflowStep,
	groupTasks: TeamTaskState[],
	agent: AgentConfig,
): Promise<string> {
	const tree = await buildWorkspaceTree(groupTasks[0]!.cwd);
	const treeBlock = tree.rendered ? `# Workspace Structure\n${tree.rendered}` : "";
	const roleInstructions =
		permissionForRole(groupTasks[0]!.role) === "read_only"
			? `You are running in READ-ONLY mode. Do not create, modify, delete, or move files. Emit your findings as TEXT in your final output.`
			: "";

	const taskBlocks = groupTasks
		.map((task, idx) => {
			return [
				`### Task ${idx + 1} of ${groupTasks.length} (id: ${task.id})`,
				`Step: ${step.id}`,
				`Role: ${step.role}`,
				`Task: ${sanitizeTaskText(step.task.replaceAll("{goal}", manifest.goal))}`,
			].join("\n");
		})
		.join("\n\n---\n\n");

	const outputInstructions = groupTasks.map((task) => `<<<TASK_RESULT:${task.id}>>>`).join(" ... ");

	return [
		"# pi-crew Coalesced Worker Prompt",
		`Run ID: ${manifest.runId}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`Goal: ${manifest.goal}`,
		`Tasks in this batch: ${groupTasks.length}`,
		``,
		roleInstructions,
		``,
		treeBlock,
		``,
		`# Your Tasks`,
		`Complete ALL ${groupTasks.length} tasks below. For each, structure your final output using the delimiters shown.`,
		``,
		taskBlocks,
		``,
		`# Output Format (CRITICAL)`,
		`After completing all tasks, structure your final output using these delimiters:`,
		``,
		outputInstructions,
		``,
		`Wrap each task's result between the start and end delimiters:`,
		`<<<TASK_RESULT:{taskId}>>>`,
		`...your result for this task...`,
		`<<<END_TASK_RESULT>>>`,
		``,
		`If delimiters don't fit your workflow, use \`### Task N of M\` headings and we'll parse those instead.`,
	]
		.filter(Boolean)
		.join("\n");
}

function buildScaffoldOutput(groupTasks: TeamTaskState[]): string {
	return groupTasks
		.map(
			(task, idx) =>
				`<<<TASK_RESULT:${task.id}>>>\nScaffold result for task ${idx + 1} of ${groupTasks.length}: ${task.id}\n<<<END_TASK_RESULT>>>`,
		)
		.join("\n\n");
}
