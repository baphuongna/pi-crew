import type { AgentConfig } from "../agents/agent-config.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { saveRunManifest, saveRunTasks } from "../state/state-store.ts";
import { createTaskClaim } from "../state/task-claims.ts";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "./worker-heartbeat.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";
import { captureWorktreeDiff, prepareTaskWorkspace } from "../worktree/worktree-manager.ts";
import { buildModelCandidates, formatModelAttemptNote, isRetryableModelFailure, type ModelAttemptSummary } from "./model-fallback.ts";
import { parsePiJsonOutput, type ParsedPiJsonOutput } from "./pi-json-output.ts";
import { runChildPi } from "./child-pi.ts";
import { buildTaskPacket, renderTaskPacket } from "./task-packet.ts";
import { createVerificationEvidence } from "./green-contract.ts";
import { createStartupEvidence } from "./worker-startup.ts";
import { permissionForRole } from "./role-permission.ts";

export interface TaskRunnerInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	task: TeamTaskState;
	step: WorkflowStep;
	agent: AgentConfig;
	signal?: AbortSignal;
	executeWorkers: boolean;
}

function renderTaskPrompt(manifest: TeamRunManifest, step: WorkflowStep, task: TeamTaskState): string {
	return [
		"# pi-crew Worker Runtime Context",
		`Run ID: ${manifest.runId}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`State root: ${manifest.stateRoot}`,
		`Artifacts root: ${manifest.artifactsRoot}`,
		`Events path: ${manifest.eventsPath}`,
		`Task ID: ${task.id}`,
		`Task cwd: ${task.cwd}`,
		`Workspace mode: ${manifest.workspaceMode}`,
		"",
		`Goal:\n${manifest.goal}`,
		"",
		`Step: ${step.id}`,
		`Role: ${step.role}`,
		"",
		"Protocol:",
		"- Stay within the task scope unless the prompt explicitly says otherwise.",
		"- Report blockers and verification evidence in the final result.",
		"- Do not claim completion without evidence.",
		"- Follow the Task Packet contract below; escalate if any contract field is impossible to satisfy.",
		"",
		task.taskPacket ? renderTaskPacket(task.taskPacket) : "",
		"Task:",
		step.task.replaceAll("{goal}", manifest.goal),
	].join("\n");
}

function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => task.id === updated.id ? updated : task);
}

export async function runTeamTask(input: TaskRunnerInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	let manifest = input.manifest;
	const workspace = prepareTaskWorkspace(manifest, input.task);
	const worktree = workspace.worktreePath && workspace.branch ? { path: workspace.worktreePath, branch: workspace.branch, reused: workspace.reused ?? false } : input.task.worktree;
	const taskPacket = buildTaskPacket({ manifest, step: input.step, taskId: input.task.id, cwd: workspace.cwd, worktreePath: worktree?.path });
	let task: TeamTaskState = {
		...input.task,
		cwd: workspace.cwd,
		worktree,
		taskPacket,
		status: "running",
		startedAt: new Date().toISOString(),
		claim: createTaskClaim(`task-runner:${input.task.id}`),
		heartbeat: createWorkerHeartbeat(input.task.id),
	};
	let tasks = updateTask(input.tasks, task);
	saveRunTasks(manifest, tasks);
	appendEvent(manifest.eventsPath, { type: "task.started", runId: manifest.runId, taskId: task.id, data: { role: task.role, agent: task.agent, cwd: task.cwd, worktreePath: workspace.worktreePath, worktreeBranch: workspace.branch, worktreeReused: workspace.reused } });
	const permissionMode = permissionForRole(task.role);

	const prompt = renderTaskPrompt(manifest, input.step, task);
	const promptArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "prompt",
		relativePath: `prompts/${task.id}.md`,
		content: `${prompt}\n`,
		producer: task.id,
	});

	let resultArtifact: ArtifactDescriptor;
	let logArtifact: ArtifactDescriptor | undefined;
	let exitCode: number | null = 0;
	let error: string | undefined;
	let modelAttempts: ModelAttemptSummary[] | undefined;
	let parsedOutput: ParsedPiJsonOutput | undefined;

	let startupEvidence = createStartupEvidence({ command: input.executeWorkers ? "pi" : "safe-scaffold", startedAt: new Date(task.startedAt ?? new Date().toISOString()), finishedAt: new Date(), promptSentAt: new Date(task.startedAt ?? new Date().toISOString()), promptAccepted: true, exitCode: 0 });
	if (input.executeWorkers) {
		const candidates = buildModelCandidates(input.step.model ?? input.agent.model, input.agent.fallbackModels, undefined);
		const attemptModels = candidates.length > 0 ? candidates : [input.step.model ?? input.agent.model];
		const logs: string[] = [];
		let finalStdout = "";
		let finalStderr = "";
		modelAttempts = [];
		for (let i = 0; i < attemptModels.length; i++) {
			const model = attemptModels[i];
			const attemptStartedAt = new Date();
			const childResult = await runChildPi({ cwd: task.cwd, task: prompt, agent: input.agent, model, signal: input.signal });
			startupEvidence = createStartupEvidence({ command: "pi", startedAt: attemptStartedAt, finishedAt: new Date(), promptSentAt: attemptStartedAt, promptAccepted: childResult.exitCode === 0 && !childResult.error, stderr: childResult.stderr, error: childResult.error, exitCode: childResult.exitCode });
			exitCode = childResult.exitCode;
			finalStdout = childResult.stdout;
			finalStderr = childResult.stderr;
			parsedOutput = parsePiJsonOutput(childResult.stdout);
			error = childResult.error || (childResult.exitCode && childResult.exitCode !== 0 ? childResult.stderr || `Child Pi exited with ${childResult.exitCode}` : undefined);
			const attempt: ModelAttemptSummary = { model: model ?? "default", success: !error, exitCode, error };
			modelAttempts.push(attempt);
			logs.push(`MODEL ATTEMPT ${i + 1}: ${attempt.model}`, `success=${attempt.success}`, `exitCode=${attempt.exitCode ?? "null"}`, attempt.error ? `error=${attempt.error}` : "", "");
			if (!error) break;
			const nextModel = attemptModels[i + 1];
			if (!nextModel || !isRetryableModelFailure(error)) break;
			logs.push(formatModelAttemptNote(attempt, nextModel), "");
		}
		resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${task.id}.txt`,
			content: parsedOutput?.finalText || finalStdout || finalStderr || "(no output)",
			producer: task.id,
		});
		logArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "log",
			relativePath: `logs/${task.id}.log`,
			content: [...logs, `finalExitCode=${exitCode ?? "null"}`, `jsonEvents=${parsedOutput?.jsonEvents ?? 0}`, parsedOutput?.usage ? `usage=${JSON.stringify(parsedOutput.usage)}` : "", "", "STDOUT:", finalStdout, "", "STDERR:", finalStderr].join("\n"),
			producer: task.id,
		});
	} else {
		resultArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "result",
			relativePath: `results/${task.id}.md`,
			content: [
				`# ${task.id}`,
				"",
				"Worker execution is disabled in this scaffold-safe run.",
				"The prompt artifact contains the exact task that will be sent to a child Pi worker when execution is enabled.",
			].join("\n"),
			producer: task.id,
		});
	}

	const diffArtifact = workspace.worktreePath ? writeArtifact(manifest.artifactsRoot, {
		kind: "diff",
		relativePath: `diffs/${task.id}.diff`,
		content: captureWorktreeDiff(workspace.worktreePath),
		producer: task.id,
	}) : undefined;

	task = {
		...task,
		status: error ? "failed" : "completed",
		finishedAt: new Date().toISOString(),
		exitCode,
		modelAttempts,
		usage: parsedOutput?.usage,
		jsonEvents: parsedOutput?.jsonEvents,
		error,
		verification: createVerificationEvidence(taskPacket.verification, !error, error ? `Task failed: ${error}` : input.executeWorkers ? "Worker finished without reporting a verification failure." : "Safe scaffold mode; verification commands were not executed."),
		promptArtifact,
		resultArtifact,
		claim: undefined,
		heartbeat: touchWorkerHeartbeat(task.heartbeat ?? createWorkerHeartbeat(task.id), { alive: false }),
		...(logArtifact ? { logArtifact } : {}),
	};
	tasks = updateTask(tasks, task);
	const packetArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.task-packet.json`,
		content: `${JSON.stringify(task.taskPacket, null, 2)}\n`,
		producer: task.id,
	});
	const verificationArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.verification.json`,
		content: `${JSON.stringify(task.verification, null, 2)}\n`,
		producer: task.id,
	});
	const startupArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.startup-evidence.json`,
		content: `${JSON.stringify(startupEvidence, null, 2)}\n`,
		producer: task.id,
	});
	const permissionArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.permission.json`,
		content: `${JSON.stringify({ role: task.role, permissionMode }, null, 2)}\n`,
		producer: task.id,
	});
	manifest = { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts, promptArtifact, resultArtifact, packetArtifact, verificationArtifact, startupArtifact, permissionArtifact, ...(logArtifact ? [logArtifact] : []), ...(diffArtifact ? [diffArtifact] : [])] };
	saveRunManifest(manifest);
	saveRunTasks(manifest, tasks);
	appendEvent(manifest.eventsPath, { type: error ? "task.failed" : "task.completed", runId: manifest.runId, taskId: task.id, message: error });
	return { manifest, tasks };
}
