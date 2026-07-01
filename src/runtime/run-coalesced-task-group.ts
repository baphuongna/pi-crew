/**
 * run-coalesced-task-group.ts — M6 real-dispatch MVP worker spawn.
 *
 * Spawns ONE child Pi process for an entire coalesced group of N tasks
 * (sharing role + cwd per `planCoalescedGroups`). The combined prompt
 * instructs the worker to wrap each task's result in `<<<TASK_RESULT:id>>>`
 * ... `<<<END_TASK_RESULT>>>` delimiters. Output is split back into N
 * per-task results via `splitCoalescedOutput`, each written to its own
 * result artifact + state update.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { permissionForRole } from "./role-permission.ts";
import { runChildPi } from "./child-pi.ts";
import { splitCoalescedOutput } from "./task-runner/output-splitter.ts";
import { buildWorkspaceTree } from "./workspace-tree.ts";
import { saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import { appendEventAsync } from "../state/event-log.ts";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewRuntimeMode } from "./runtime-resolver.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";

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

export async function runCoalescedTaskGroup(
	input: CoalescedTaskGroupInput,
): Promise<CoalescedTaskGroupResult> {
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
	saveRunTasks(manifest, updatedTasks);
	await appendEventAsync(manifest.eventsPath, {
		type: "task.coalesced_dispatch_start",
		runId: manifest.runId,
		message: `Dispatching ${groupTasks.length} coalesced tasks in 1 worker (role=${firstTask.role}, cwd=${firstTask.cwd})`,
		data: { groupId, role: firstTask.role, cwd: firstTask.cwd, taskIds },
	});

	const combinedPrompt = await buildCoalescedPrompt(manifest, step, groupTasks, agent);

	let rawOutput = "";
	let success = false;
	if (!executeWorkers) {
		rawOutput = buildScaffoldOutput(groupTasks);
		success = true;
	} else {
		try {
			const result = await runChildPi({
				cwd: firstTask.cwd,
				task: combinedPrompt,
				agent,
				signal,
				excludeContextBash: true,
				maxTurns: 5,
				onJsonEvent: (e) => input.onJsonEvent?.(firstTask.id, manifest.runId, e),
			});
			rawOutput = result.rawFinalText ?? result.stdout ?? "";
			success = result.exitStatus?.exitCode === 0;
		} catch (err) {
			rawOutput = `Worker dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
			success = false;
		}
	}

	const split = splitCoalescedOutput(rawOutput, taskIds);

	const finishedAt = new Date().toISOString();
	updatedTasks = updatedTasks.map((t) => {
		if (!taskIds.includes(t.id)) return t;
		const entry = split.find((s) => s.taskId === t.id);
		const ok = success && Boolean(entry?.text);
		const resultArtifactPath = path.join(
			manifest.stateRoot,
			"results",
			`${t.id}.txt`,
		);
		void writeFile(resultArtifactPath, entry?.text ?? rawOutput, "utf-8").catch(() => undefined);
		return {
			...t,
			status: ok ? ("completed" as const) : ("failed" as const),
			finishedAt,
			result: {
				text: entry?.text ?? rawOutput,
				producer: groupId,
				strategy: entry?.strategy ?? "broadcast",
			},
		};
	});
	saveRunTasks(manifest, updatedTasks);

	let updatedManifest: TeamRunManifest = manifest;
	if (success) {
		updatedManifest = updateRunStatus(manifest, "running");
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
	const roleInstructions = permissionForRole(groupTasks[0]!.role) === "read_only"
		? `You are running in READ-ONLY mode. Do not create, modify, delete, or move files. Emit your findings as TEXT in your final output.`
		: "";

	const taskBlocks = groupTasks
		.map((task, idx) => {
			return [
				`### Task ${idx + 1} of ${groupTasks.length} (id: ${task.id})`,
				`Step: ${step.id}`,
				`Role: ${step.role}`,
				`Task: ${step.task.replaceAll("{goal}", manifest.goal)}`,
			].join("\n");
		})
		.join("\n\n---\n\n");

	const outputInstructions = groupTasks
		.map((task) => `<<<TASK_RESULT:${task.id}>>>`)
		.join(" ... ");

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
	].filter(Boolean).join("\n");
}

function buildScaffoldOutput(groupTasks: TeamTaskState[]): string {
	return groupTasks
		.map((task, idx) => `<<<TASK_RESULT:${task.id}>>>\nScaffold result for task ${idx + 1} of ${groupTasks.length}: ${task.id}\n<<<END_TASK_RESULT>>>`)
		.join("\n\n");
}