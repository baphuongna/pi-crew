import { appendEvent, readEvents } from "../state/event-log.ts";
import type { CrewAttentionEventData, TeamRunManifest } from "../state/types.ts";

export interface AppendTaskAttentionInput {
	manifest: TeamRunManifest;
	taskId?: string;
	message: string;
	data: CrewAttentionEventData;
}

export function appendTaskAttentionEvent(input: AppendTaskAttentionInput): boolean {
	const recent = readEvents(input.manifest.eventsPath).slice(-200);
	const dedupKey = `${input.taskId ?? ""}:${input.data.reason}:${input.data.activityState}`;
	const duplicate = recent.some(
		(event) =>
			event.type === "task.attention" &&
			`${event.taskId ?? ""}:${event.data?.reason ?? ""}:${event.data?.activityState ?? ""}` === dedupKey,
	);
	if (duplicate) return false;
	appendEvent(input.manifest.eventsPath, {
		type: "task.attention",
		runId: input.manifest.runId,
		taskId: input.taskId,
		message: input.message,
		data: { ...input.data },
	});
	return true;
}
