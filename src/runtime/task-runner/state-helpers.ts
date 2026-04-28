import type { TaskCheckpointState, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { loadRunManifestById, saveRunTasks } from "../../state/state-store.ts";
import { recordFromTask, upsertCrewAgent } from "../crew-agent-records.ts";

export function updateTask(tasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	return tasks.map((task) => task.id === updated.id ? updated : task);
}

export function persistSingleTaskUpdate(manifest: TeamRunManifest, fallbackTasks: TeamTaskState[], updated: TeamTaskState): TeamTaskState[] {
	const latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
	const merged = updateTask(latest, updated);
	saveRunTasks(manifest, merged);
	return merged;
}

export function checkpointTask(manifest: TeamRunManifest, tasks: TeamTaskState[], task: TeamTaskState, phase: TaskCheckpointState["phase"], childPid?: number): { task: TeamTaskState; tasks: TeamTaskState[] } {
	const checkpoint: TaskCheckpointState = { phase, updatedAt: new Date().toISOString(), ...(childPid ? { childPid } : task.checkpoint?.childPid ? { childPid: task.checkpoint.childPid } : {}) };
	const nextTask = { ...task, checkpoint };
	const nextTasks = persistSingleTaskUpdate(manifest, updateTask(tasks, nextTask), nextTask);
	upsertCrewAgent(manifest, recordFromTask(manifest, nextTask, "child-process"));
	return { task: nextTask, tasks: nextTasks };
}
