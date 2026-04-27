import type { TeamTaskStatus } from "../state/contracts.ts";

export type CrewRuntimeKind = "scaffold" | "child-process" | "live-session";
export type CrewAgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped";

export interface CrewAgentRecord {
	id: string;
	runId: string;
	taskId: string;
	agent: string;
	role: string;
	runtime: CrewRuntimeKind;
	status: CrewAgentStatus;
	startedAt: string;
	completedAt?: string;
	resultArtifactPath?: string;
	transcriptPath?: string;
	toolUses?: number;
	jsonEvents?: number;
	error?: string;
}

export function taskStatusToAgentStatus(status: TeamTaskStatus): CrewAgentStatus {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	if (status === "running") return "running";
	return "queued";
}
