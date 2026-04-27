import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { atomicWriteJson, readJsonFile } from "../state/atomic-write.ts";
import type { CrewAgentRecord, CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { taskStatusToAgentStatus } from "./crew-agent-runtime.ts";

export function agentsPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "agents.json");
}

export function readCrewAgents(manifest: TeamRunManifest): CrewAgentRecord[] {
	return readJsonFile<CrewAgentRecord[]>(agentsPath(manifest)) ?? [];
}

export function saveCrewAgents(manifest: TeamRunManifest, records: CrewAgentRecord[]): void {
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	atomicWriteJson(agentsPath(manifest), records);
}

export function upsertCrewAgent(manifest: TeamRunManifest, record: CrewAgentRecord): void {
	const records = readCrewAgents(manifest).filter((item) => item.id !== record.id);
	records.push(record);
	saveCrewAgents(manifest, records);
}

export function recordFromTask(manifest: TeamRunManifest, task: TeamTaskState, runtime: CrewRuntimeKind): CrewAgentRecord {
	return {
		id: `${manifest.runId}:${task.id}`,
		runId: manifest.runId,
		taskId: task.id,
		agent: task.agent,
		role: task.role,
		runtime,
		status: taskStatusToAgentStatus(task.status),
		startedAt: task.startedAt ?? new Date().toISOString(),
		completedAt: task.finishedAt,
		resultArtifactPath: task.resultArtifact?.path,
		transcriptPath: task.logArtifact?.path,
		jsonEvents: task.jsonEvents,
		error: task.error,
	};
}
