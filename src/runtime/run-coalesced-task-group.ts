import type { AgentConfig } from "../agents/agent-config.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEventAsync } from "../state/event-log.ts";
import { saveRunTasksAsync, updateRunStatus } from "../state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { runChildPi } from "./child-pi.ts";
import { DEFAULT_RETRY_POLICY, executeWithRetry } from "./retry-executor.ts";
import { permissionForRole } from "./role-permission.ts";
import type { CrewRuntimeMode } from "./runtime-resolver.ts";
import { sanitizeTaskText } from "./task-packet.ts";
import { splitCoalescedOutput } from "./task-runner/output-splitter.ts";
import { mergeArtifacts } from "./team-runner-artifacts.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "./worker-heartbeat.ts";
import { buildWorkspaceTree } from "./workspace-tree.ts";

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
	if (!executeWorkers) {
		rawOutput = buildScaffoldOutput(groupTasks);
		success = true;
	} else {
		// Heartbeat refresher: touch every task's heartbeat every 15s while the
		// worker is alive. Set `alive: true` explicitly so post-completion
		// staleness checks immediately recognize liveness.
		const heartbeatTimer = setInterval(async () => {
			const now = new Date().toISOString();
			updatedTasks = updatedTasks.map((t) => {
				if (!taskIds.includes(t.id)) return t;
				return {
					...t,
					heartbeat: touchWorkerHeartbeat(t.heartbeat ?? createWorkerHeartbeat(t.id), { alive: true }),
				};
			});
			try {
				await saveRunTasksAsync(manifest, updatedTasks);
			} catch {
				// Run may have been pruned mid-dispatch — best-effort only.
			}
		}, 15_000);
		try {
			const result = await executeWithRetry(
				async () => {
					return await runChildPi({
						cwd: firstTask.cwd,
						task: combinedPrompt,
						agent,
						signal,
						excludeContextBash: true,
						maxTurns: 5,
						onJsonEvent: (e) => input.onJsonEvent?.(firstTask.id, manifest.runId, e),
					});
				},
				DEFAULT_RETRY_POLICY,
				{ signal },
			);
			rawOutput = result.rawFinalText ?? result.stdout ?? "";
			success = result.exitStatus?.exitCode === 0;
		} catch (err) {
			rawOutput = `Worker dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
			success = false;
		} finally {
			clearInterval(heartbeatTimer);
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
			status: ok ? ("completed" as const) : ("failed" as const),
			finishedAt,
			result: {
				text,
				producer: groupId,
				strategy: entry?.strategy ?? "broadcast",
			},
			resultArtifact,
		};
	});
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
		message: `Coalesced dispatch ${success ? "completed" : "failed"} (${taskIds.length} tasks, ${split[0]?.strategy ?? "broadcast"} split)`,
		data: { groupId, taskIds, success, strategy: split[0]?.strategy },
	});

	return { manifest: updatedManifest, tasks: updatedTasks, taskIds, rawOutput, success };
}

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
