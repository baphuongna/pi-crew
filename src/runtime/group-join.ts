import type { CrewRuntimeConfig } from "../config/config.ts";
import { appendMailboxMessage, findMailboxMessageByRequestId, readDeliveryState } from "../state/coordination/mailbox.ts";
import { appendEvent } from "../state/event-log/event-log.ts";
import { writeArtifact } from "../state/stores/artifact-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { aggregateTaskOutputs } from "./task-output-context.ts";

export type CrewGroupJoinMode = "off" | "group" | "smart";

export interface CrewGroupJoinDelivery {
	batchId: string;
	mode: CrewGroupJoinMode;
	partial: boolean;
	taskIds: string[];
	completed: string[];
	failed: string[];
	skipped: string[];
	remaining: string[];
	artifact?: ArtifactDescriptor;
	messageId?: string;
	requestId?: string;
	ackRequired?: boolean;
	ackStatus?: "pending" | "acknowledged";
}

export function resolveGroupJoinMode(runtime?: CrewRuntimeConfig): CrewGroupJoinMode {
	return runtime?.groupJoin ?? "smart";
}

export function shouldGroupJoin(mode: CrewGroupJoinMode, batch: TeamTaskState[]): boolean {
	if (mode === "off") return false;
	if (mode === "group") return batch.length > 0;
	return batch.length > 1;
}

function batchIdFor(runId: string, taskIds: string[]): string {
	return `${runId}_${taskIds.join("+").replace(/[^a-zA-Z0-9_+-]/g, "_")}`;
}

function requestIdFor(runId: string, batchId: string, partial: boolean): string {
	return `${runId}:group-join:${partial ? "partial" : "completed"}:${batchId}`;
}

function statusList(tasks: TeamTaskState[], status: TeamTaskState["status"]): string[] {
	return tasks.filter((task) => task.status === status).map((task) => task.id);
}

export function deliverGroupJoin(input: {
	manifest: TeamRunManifest;
	mode: CrewGroupJoinMode;
	batch: TeamTaskState[];
	allTasks: TeamTaskState[];
	partial?: boolean;
}): CrewGroupJoinDelivery | undefined {
	if (!shouldGroupJoin(input.mode, input.batch)) return undefined;
	const taskIds = input.batch.map((task) => task.id);
	const latest = taskIds
		.map((id) => input.allTasks.find((task) => task.id === id))
		.filter((task): task is TeamTaskState => Boolean(task));
	const completed = statusList(latest, "completed");
	const failed = statusList(latest, "failed");
	const skipped = statusList(latest, "skipped");
	const remaining = latest.filter((task) => task.status === "queued" || task.status === "running").map((task) => task.id);
	const partial = input.partial ?? remaining.length > 0;
	const batchId = batchIdFor(input.manifest.runId, taskIds);
	const summary = aggregateTaskOutputs(latest, input.manifest);
	const requestId = requestIdFor(input.manifest.runId, batchId, partial);
	const existingMailbox = findMailboxMessageByRequestId(input.manifest, requestId);
	const existingStatus = existingMailbox
		? (readDeliveryState(input.manifest).messages[existingMailbox.id] ?? existingMailbox.status)
		: undefined;
	const delivery: CrewGroupJoinDelivery = {
		batchId,
		mode: input.mode,
		partial,
		taskIds,
		completed,
		failed,
		skipped,
		remaining,
		requestId,
		ackRequired: true,
		ackStatus: existingStatus === "acknowledged" ? "acknowledged" : "pending",
	};
	const content = `${JSON.stringify({ ...delivery, createdAt: new Date().toISOString() }, null, 2)}\n`;
	const artifact = writeArtifact(input.manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/group-joins/${batchId}.json`,
		producer: "group-join",
		content,
	});
	const mailbox =
		existingMailbox ??
		appendMailboxMessage(input.manifest, {
			direction: "outbox",
			from: "group-join",
			to: "leader",
			body: [
				`Group join ${partial ? "partial" : "completed"}: ${taskIds.join(", ")}`,
				`Request: ${requestId}`,
				`Completed: ${completed.join(", ") || "none"}`,
				`Failed: ${failed.join(", ") || "none"}`,
				`Skipped: ${skipped.join(", ") || "none"}`,
				`Remaining: ${remaining.join(", ") || "none"}`,
				"",
				summary,
			].join("\n"),
			status: "delivered",
			data: {
				kind: "group_join",
				requestId,
				batchId,
				partial,
				ackRequired: true,
				taskIds,
				completed,
				failed,
				skipped,
				remaining,
			},
		});
	appendEvent(input.manifest.eventsPath, {
		type: partial ? "agent.group_join.partial" : "agent.group_join.completed",
		runId: input.manifest.runId,
		message: `Group join ${partial ? "partial" : "completed"} for ${taskIds.length} task(s).`,
		data: {
			...delivery,
			artifactPath: artifact.path,
			messageId: mailbox.id,
			fallback: "mailbox-delivered",
			reused: Boolean(existingMailbox),
		},
	});
	if (existingMailbox)
		appendEvent(input.manifest.eventsPath, {
			type: "agent.group_join.delivery_reused",
			runId: input.manifest.runId,
			message: `Reused group join mailbox delivery for ${taskIds.length} task(s).`,
			data: { requestId, messageId: mailbox.id, batchId, partial },
		});
	return { ...delivery, artifact, messageId: mailbox.id };
}

/**
 * Persisted settings vocabulary for join mode (imported by settings-store.ts
 * for `defaultJoinMode` validation and config application).
 */
export type JoinMode = "async" | "group" | "smart";
