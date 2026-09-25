import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SubagentRecord, type SubagentSpawnOptions, savePersistedSubagentRecord } from "../../runtime/subagent-manager.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";

interface FollowUpCapablePi {
	sendMessage?: (message: unknown, options?: unknown) => void;
	sendUserMessage?: (content: string, options?: unknown) => void;
}

export function sendFollowUp(pi: ExtensionAPI, content: string): void {
	const api = pi as unknown as FollowUpCapablePi;
	if (typeof api.sendMessage !== "function") return;
	api.sendMessage.call(
		pi,
		{ customType: "pi-crew-subagent-notification", content, display: true },
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export function sendAgentWakeUp(pi: ExtensionAPI, content: string): boolean {
	const api = pi as unknown as FollowUpCapablePi;
	try {
		if (typeof api.sendUserMessage === "function") {
			api.sendUserMessage.call(pi, content, {
				deliverAs: "followUp",
				triggerTurn: true,
			});
			return true;
		}
		if (typeof api.sendMessage === "function") {
			api.sendMessage.call(
				pi,
				{
					customType: "pi-crew-subagent-wakeup",
					content,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

export function refreshPersistedSubagentRecord(ctx: ExtensionContext | ExtensionCommandContext, record: SubagentRecord): SubagentRecord {
	if (!record.runId) return record;
	const loaded = loadRunManifestById(ctx.cwd, record.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return record;
	if (
		loaded.manifest.status === "completed" ||
		loaded.manifest.status === "failed" ||
		loaded.manifest.status === "cancelled" ||
		loaded.manifest.status === "blocked"
	) {
		const refreshed = {
			...record,
			status: loaded.manifest.status,
			error: loaded.manifest.status === "completed" || loaded.manifest.status === "blocked" ? undefined : loaded.manifest.summary,
			completedAt: loaded.manifest.status === "blocked" ? undefined : (record.completedAt ?? Date.now()),
		};
		savePersistedSubagentRecord(ctx.cwd, refreshed);
		return refreshed;
	}
	return record;
}

export function formatSubagentRecord(record: SubagentRecord): string {
	const duration = record.completedAt ? `${Math.round((record.completedAt - record.startedAt) / 1000)}s` : "running";
	return [
		`Agent: ${record.id}`,
		`Type: ${record.type}`,
		`Status: ${record.status}`,
		record.runId ? `Run: ${record.runId}` : undefined,
		`Description: ${record.description}`,
		record.model ? `Model: ${record.model}` : undefined,
		`Duration: ${duration}`,
		record.error ? `Error: ${record.error}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function readSubagentRunResult(ctx: ExtensionContext | ExtensionCommandContext, record: SubagentRecord): string | undefined {
	if (!record.runId) return record.result;
	const loaded = loadRunManifestById(ctx.cwd, record.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	const task = loaded?.tasks.find((item) => item.resultArtifact) ?? loaded?.tasks[0];
	const artifactPath = task?.resultArtifact?.path;
	if (!artifactPath || !loaded) return undefined;
	try {
		const safePath = resolveRealContainedPath(loaded.manifest.artifactsRoot, artifactPath);
		return fs.readFileSync(safePath, "utf-8").trim();
	} catch {
		return undefined;
	}
}

export function subagentToolResult(text: string, details: Record<string, unknown> = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

function parseSkillParam(value: unknown): string | string[] | false | undefined {
	if (value === false) return false;
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
	return undefined;
}

export function __test__subagentSpawnParams(params: Record<string, unknown>, ctx: Pick<ExtensionContext, "cwd">): SubagentSpawnOptions {
	return {
		cwd: ctx.cwd,
		type: typeof params.subagent_type === "string" && params.subagent_type.trim() ? params.subagent_type.trim() : "executor",
		description: typeof params.description === "string" && params.description.trim() ? params.description.trim() : "pi-crew subagent",
		prompt: typeof params.prompt === "string" ? params.prompt : "",
		background: params.run_in_background === true,
		model: typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined,
		skill: parseSkillParam(params.skill),
		maxTurns: typeof params.max_turns === "number" && Number.isFinite(params.max_turns) ? params.max_turns : undefined,
		batchId: typeof params.batch_id === "string" && params.batch_id.trim() ? params.batch_id.trim() : undefined,
	};
}

/**
 * FINDING 6 (2026-09-23 battery): when a notification is cleared (e.g. the
 * health monitor resolved a false/stale alert), copies of the ORIGINAL
 * warning may still sit in the host session's follow-up queue — the host
 * drains queued follow-ups one per turn boundary, so stale copies kept
 * dripping into the parent conversation for hours after the clear.
 *
 * Feature-detected purge: newer pi runtimes expose
 * `clearQueuedUserMessagesMatching(predicate)` (agent-session), which removes
 * still-QUEUED messages whose text matches. Duck-typed here because the
 * installed runtime surface (0.87.0) does not export it yet — on such hosts
 * this is a documented no-op (returns false); the fire-cap policy in
 * health-notify-policy.ts is the defense that works on all hosts.
 */
interface QueuePurgeCapablePi {
	clearQueuedUserMessagesMatching?: (predicate: (text: string) => boolean) => { steering: string[]; followUp: string[] };
	session?: {
		clearQueuedUserMessagesMatching?: (predicate: (text: string) => boolean) => { steering: string[]; followUp: string[] };
	};
}

export function purgeQueuedAmbientNotifications(pi: ExtensionAPI, match: (text: string) => boolean): boolean {
	const api = pi as unknown as QueuePurgeCapablePi;
	const surface =
		typeof api.clearQueuedUserMessagesMatching === "function"
			? api.clearQueuedUserMessagesMatching
			: typeof api.session?.clearQueuedUserMessagesMatching === "function"
				? api.session.clearQueuedUserMessagesMatching
				: undefined;
	if (!surface) return false;
	try {
		const removed = surface.call(api.session ?? api, match);
		return (removed?.followUp?.length ?? 0) + (removed?.steering?.length ?? 0) > 0;
	} catch {
		return false;
	}
}
