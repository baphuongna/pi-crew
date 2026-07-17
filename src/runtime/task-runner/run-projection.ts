import type { MailboxMessage } from "../../state/mailbox.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { sanitizeTaskText } from "../task-packet.ts";

export interface RunProjectionSource {
	kind: "events" | "mailbox" | "artifacts" | "ui_metadata" | "runtime_metadata";
	bounded: boolean;
	reference?: string;
}

export interface RunProjectionResult {
	sources: RunProjectionSource[];
	summary: string;
	injectedAsContext: boolean;
}

/**
 * Transform run context before a worker starts.
 * Builds a bounded projection of durable history that will be available
 * to the worker as reference context, not as instructions.
 *
 * Rules:
 * - Durable history retains events, mailbox, artifacts, UI/runtime metadata.
 * - Worker prompt gets a bounded projection (truncated/summarized).
 * - UI/runtime events are not prompt text unless explicitly selected.
 */
export function transformRunContextBeforeWorkerStart(input: {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	pendingMailbox: MailboxMessage[];
	artifacts: ArtifactDescriptor[];
	maxEvents?: number;
	maxMailboxMessages?: number;
	maxArtifactRefs?: number;
}): RunProjectionResult {
	const maxEvents = input.maxEvents ?? 20;
	const maxMailbox = input.maxMailboxMessages ?? 10;
	const maxArtifacts = input.maxArtifactRefs ?? 15;

	const sources: RunProjectionSource[] = [];
	const lines: string[] = [];

	// Project a bounded slice of task history
	const completedTasks = input.tasks.filter((t) => t.status === "completed" || t.status === "failed");
	if (completedTasks.length > 0) {
		const tasks = completedTasks.slice(0, maxEvents);
		sources.push({
			kind: "events",
			bounded: true,
			reference: `tasks:${tasks.length}/${completedTasks.length}`,
		});
		lines.push(`Previous tasks (${tasks.length}/${completedTasks.length}):`);
		for (const task of tasks) {
			lines.push(`- ${task.id}: ${task.status}${task.error ? ` (${task.error})` : ""}`);
		}
	}

	// Project pending mailbox that is relevant to this worker
	if (input.pendingMailbox.length > 0) {
		const messages = input.pendingMailbox.slice(0, maxMailbox);
		sources.push({
			kind: "mailbox",
			bounded: true,
			reference: `mailbox:${messages.length}/${input.pendingMailbox.length}`,
		});
		lines.push(`Pending messages (${messages.length}/${input.pendingMailbox.length}):`);
		for (const msg of messages) {
			const safeBody = sanitizeTaskText(msg.body.slice(0, 100));
			lines.push(`- ${msg.kind ?? "message"}: ${safeBody}`);
		}
	}

	// Project artifact references (not content)
	if (input.artifacts.length > 0) {
		const artifacts = input.artifacts.slice(0, maxArtifacts);
		sources.push({
			kind: "artifacts",
			bounded: true,
			reference: `artifacts:${artifacts.length}/${input.artifacts.length}`,
		});
		lines.push(`Available artifacts (${artifacts.length}/${input.artifacts.length}):`);
		for (const art of artifacts) {
			lines.push(`- ${art.kind} (${art.producer})`);
		}
	}

	// Metadata markers — not injected as prompt instructions
	sources.push({
		kind: "ui_metadata",
		bounded: false,
		reference: "excluded_from_prompt",
	});
	sources.push({
		kind: "runtime_metadata",
		bounded: false,
		reference: "excluded_from_prompt",
	});

	return {
		sources,
		summary: lines.join("\n"),
		injectedAsContext: true,
	};
}

/**
 * Convert run history to a bounded worker prompt section.
 * Same logic as transformRunContextBeforeWorkerStart but returns
 * the prompt text directly for embedding in the worker prompt.
 */
export function convertRunHistoryToWorkerPrompt(input: {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	pendingMailbox: MailboxMessage[];
	artifacts: ArtifactDescriptor[];
}): string {
	const projection = transformRunContextBeforeWorkerStart(input);
	if (!projection.summary) return "";
	return [
		"## Run Context (bounded projection)",
		projection.summary,
		"",
		`Projection sources: ${projection.sources.map((s) => s.kind).join(", ")}`,
	].join("\n");
}
