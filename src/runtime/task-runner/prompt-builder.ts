import type { AgentConfig } from "../../agents/agent-config.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import type { WorkflowStep } from "../../workflows/workflow-config.ts";
import { buildMemoryBlock } from "../agent-memory.ts";
import { permissionForRole } from "../role-permission.ts";
import { renderTaskPacket } from "../task-packet.ts";

function readOnlyRoleInstructions(role: string): string {
	if (permissionForRole(role) !== "read_only") return "";
	return [
		"# READ-ONLY ROLE CONTRACT",
		"You are running in READ-ONLY mode for this task.",
		"- Do not create, modify, delete, move, or copy files.",
		"- Do not use shell redirects, heredocs, in-place edits, package installs, git commit/merge/rebase/reset/checkout, or other state-mutating commands.",
		"- If implementation changes are needed, report exact recommendations instead of applying them.",
		"- Prefer read/grep/find/listing tools and read-only git inspection commands.",
	].join("\n");
}

export function coordinationBridgeInstructions(task: TeamTaskState): string {
	return [
		"# Crew Coordination Channel",
		`Mailbox target for this task: ${task.id}`,
		"Use the run mailbox contract for coordination with the leader/orchestrator:",
		"- If blocked or uncertain, report the blocker in your final result and, when mailbox tools/API are available, send an inbox/outbox message addressed to the leader.",
		"- If nudged, answer with current status, blocker, or smallest next step.",
		"- Treat inherited/dependency context as reference-only; do not continue the parent conversation directly.",
		"- Completion handoff should include: DONE/FAILED, summary, changed/read files, verification evidence, and remaining risks.",
	].join("\n");
}

function inputDependencyContext(task: TeamTaskState): string {
	return (task as TeamTaskState & { dependencyContextText?: string }).dependencyContextText ?? "";
}

export function renderTaskPrompt(manifest: TeamRunManifest, step: WorkflowStep, task: TeamTaskState, agent?: AgentConfig): string {
	const memoryBlock = agent?.memory ? buildMemoryBlock(agent.name, agent.memory, task.cwd, Boolean(agent.tools?.some((tool) => tool === "write" || tool === "edit"))) : "";
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
		readOnlyRoleInstructions(task.role),
		"",
		coordinationBridgeInstructions(task),
		"",
		task.taskPacket ? renderTaskPacket(task.taskPacket) : "",
		"",
		(inputDependencyContext(task) || ""),
		memoryBlock,
		"Task:",
		step.task.replaceAll("{goal}", manifest.goal),
	].join("\n");
}
