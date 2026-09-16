import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { recordFromTask } from "./crew-agent-records.ts";
import type { CrewAgentRecord, CrewRuntimeKind } from "./crew-agent-runtime.ts";

export function shouldMaterializeAgent(task: TeamTaskState): boolean {
	return task.status !== "queued" && task.status !== "skipped";
}

export function recordsForMaterializedTasks(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	runtime: CrewRuntimeKind,
): CrewAgentRecord[] {
	return tasks.filter(shouldMaterializeAgent).map((task) => recordFromTask(manifest, task, runtime));
}

export function taskById(tasks: TeamTaskState[]): Map<string, TeamTaskState> {
	const map = new Map<string, TeamTaskState>();
	for (const task of tasks) {
		map.set(task.id, task);
		if (task.stepId) map.set(task.stepId, task);
	}
	return map;
}

export function waitingReason(task: TeamTaskState, tasks: TeamTaskState[]): string | undefined {
	if (task.status !== "queued") return undefined;
	const byId = taskById(tasks);
	const waiting = task.dependsOn.map((id) => byId.get(id)?.id ?? id).filter((id) => byId.get(id)?.status !== "completed");
	if (waiting.length === 0) return "ready";
	return `waiting for ${waiting.join(", ")}`;
}

export function formatTaskGraphLines(tasks: TeamTaskState[]): string[] {
	if (tasks.length === 0) return ["- (none)"];
	return tasks.map((task) => {
		const icon =
			task.status === "completed"
				? "✓"
				: task.status === "running"
					? "⠋"
					: task.status === "failed"
						? "✗"
						: task.status === "cancelled" || task.status === "skipped"
							? "■"
							: task.status === "needs_attention"
								? "⚠"
								: "◦";
		const wait = waitingReason(task, tasks);
		return `- ${icon} ${task.id} [${task.status}] ${task.role}▸${task.agent}${wait && wait !== "ready" ? ` (${wait})` : ""}`;
	});
}
