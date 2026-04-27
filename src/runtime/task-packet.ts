import * as path from "node:path";
import type { TeamRunManifest, TaskPacket, TaskScope, VerificationContract } from "../state/types.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";

export interface BuildTaskPacketInput {
	manifest: TeamRunManifest;
	step: WorkflowStep;
	taskId: string;
	cwd: string;
	worktreePath?: string;
}

export interface TaskPacketValidationResult {
	valid: boolean;
	errors: string[];
}

export function inferTaskScope(step: WorkflowStep): TaskScope {
	const reads = step.reads === false ? [] : step.reads ?? [];
	if (reads.length === 1) return "single_file";
	if (reads.length > 1) return "module";
	return "workspace";
}

export function defaultVerificationContract(step: WorkflowStep): VerificationContract {
	return {
		requiredGreenLevel: step.verify ? "targeted" : "none",
		commands: [],
		allowManualEvidence: true,
	};
}

export function buildTaskPacket(input: BuildTaskPacketInput): TaskPacket {
	const scope = inferTaskScope(input.step);
	const reads = input.step.reads === false ? [] : input.step.reads ?? [];
	const scopePath = reads.length === 1 ? reads[0] : reads.length > 1 ? reads.join(", ") : undefined;
	return {
		objective: input.step.task.replaceAll("{goal}", input.manifest.goal),
		scope,
		scopePath,
		repo: path.basename(input.manifest.cwd) || input.manifest.cwd,
		worktree: input.worktreePath,
		branchPolicy: input.manifest.workspaceMode === "worktree" ? "Use the assigned task worktree and avoid modifying the leader checkout." : "Use the current checkout; do not create branches unless explicitly requested.",
		acceptanceTests: [],
		commitPolicy: "Do not commit unless explicitly requested by the user or workflow.",
		reportingContract: "Report changed files, verification evidence, blockers, and next recommended action.",
		escalationPolicy: "Stop and report if scope is ambiguous, destructive action is needed, permissions are missing, or verification cannot be completed.",
		constraints: [
			"Stay within the assigned task scope.",
			"Do not claim completion without verification evidence.",
			"Use mailbox/API state for coordination when available.",
		],
		expectedArtifacts: ["prompt", "result", "verification"],
		verification: defaultVerificationContract(input.step),
	};
}

export function validateTaskPacket(packet: TaskPacket): TaskPacketValidationResult {
	const errors: string[] = [];
	if (!packet.objective.trim()) errors.push("objective must not be empty");
	if (!packet.repo.trim()) errors.push("repo must not be empty");
	if (!packet.branchPolicy.trim()) errors.push("branchPolicy must not be empty");
	if (!packet.commitPolicy.trim()) errors.push("commitPolicy must not be empty");
	if (!packet.reportingContract.trim()) errors.push("reportingContract must not be empty");
	if (!packet.escalationPolicy.trim()) errors.push("escalationPolicy must not be empty");
	if ((packet.scope === "module" || packet.scope === "single_file" || packet.scope === "custom") && !packet.scopePath?.trim()) {
		errors.push(`scopePath is required for scope '${packet.scope}'`);
	}
	for (const [index, test] of packet.acceptanceTests.entries()) {
		if (!test.trim()) errors.push(`acceptanceTests contains an empty value at index ${index}`);
	}
	return { valid: errors.length === 0, errors };
}

export function renderTaskPacket(packet: TaskPacket): string {
	return [
		"# Task Packet",
		"",
		"```json",
		JSON.stringify(packet, null, 2),
		"```",
		"",
	].join("\n");
}
