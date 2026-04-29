import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { handleTeamTool } from "../extension/team-tool.ts";
import { isToolError, textFromToolResult } from "../extension/tool-result.ts";
import { loadRunManifestById, saveRunTasks } from "../state/state-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { exportDiagnostic } from "../runtime/diagnostic-export.ts";
import type { MailboxDirection, MailboxMessage } from "../state/mailbox.ts";

export interface RunActionResult {
	ok: boolean;
	message: string;
	data?: unknown;
}

function okFromTool(result: Awaited<ReturnType<typeof handleTeamTool>>): RunActionResult {
	return { ok: !isToolError(result), message: textFromToolResult(result), data: result };
}

function err(error: unknown): RunActionResult {
	return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

async function dispatchApi(ctx: ExtensionContext, runId: string, config: Record<string, unknown>): Promise<RunActionResult> {
	try {
		return okFromTool(await handleTeamTool({ action: "api", runId, config }, ctx));
	} catch (error) {
		return err(error);
	}
}

function parseMailboxMessages(text: string): MailboxMessage[] {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is MailboxMessage => Boolean(item) && typeof item === "object" && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string");
	} catch {
		return [];
	}
}

export function dispatchMailboxAck(ctx: ExtensionContext, runId: string, messageId: string): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, { operation: "ack-message", messageId });
}

export function dispatchMailboxNudge(ctx: ExtensionContext, runId: string, agentId: string, message: string): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, { operation: "nudge-agent", agentId, message });
}

export function dispatchMailboxCompose(ctx: ExtensionContext, runId: string, payload: { from: string; to: string; body: string; taskId?: string; direction: MailboxDirection }): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, { operation: "send-message", ...payload });
}

export async function dispatchMailboxAckAll(ctx: ExtensionContext, runId: string): Promise<RunActionResult> {
	const listed = await dispatchApi(ctx, runId, { operation: "read-mailbox", direction: "inbox" });
	if (!listed.ok) return listed;
	const messages = parseMailboxMessages(listed.message).filter((message) => message.status !== "acknowledged");
	let count = 0;
	for (const message of messages) {
		const acked = await dispatchMailboxAck(ctx, runId, message.id);
		if (!acked.ok) return { ok: false, message: `Acknowledged ${count}/${messages.length}; failed ${message.id}: ${acked.message}` };
		count += 1;
	}
	return { ok: true, message: `Acknowledged ${count} messages.`, data: { count } };
}

export function dispatchHealthRecovery(ctx: ExtensionContext, runId: string): Promise<RunActionResult> {
	return dispatchApi(ctx, runId, { operation: "foreground-interrupt", reason: "operator health recovery" });
}

export async function dispatchKillStaleWorkers(ctx: ExtensionContext, runId: string): Promise<RunActionResult> {
	try {
		const loaded = loadRunManifestById(ctx.cwd, runId);
		if (!loaded) return { ok: false, message: `Run '${runId}' not found.` };
		const currentMs = Date.now();
		const staleMs = 60_000;
		const now = new Date(currentMs).toISOString();
		let count = 0;
		const tasks = loaded.tasks.map((task) => {
			if ((task.status !== "running" && task.status !== "queued") || !task.heartbeat || task.heartbeat.alive === false) return task;
			const lastSeenMs = Date.parse(task.heartbeat.lastSeenAt);
			if (!Number.isFinite(lastSeenMs) || currentMs - lastSeenMs <= staleMs) return task;
			count += 1;
			return { ...task, heartbeat: { ...task.heartbeat, alive: false, lastSeenAt: now } };
		});
		saveRunTasks(loaded.manifest, tasks);
		appendEvent(loaded.manifest.eventsPath, { type: "worker.kill_stale", runId, message: `Marked ${count} stale worker heartbeat(s) dead.`, data: { count } });
		return { ok: true, message: `Marked ${count} stale worker heartbeat(s) dead.`, data: { count } };
	} catch (error) {
		return err(error);
	}
}

export async function dispatchDiagnosticExport(ctx: ExtensionContext, runId: string, options: { registry?: MetricRegistry } = {}): Promise<RunActionResult> {
	try {
		const exported = await exportDiagnostic(ctx, runId, options);
		return { ok: true, message: `Diagnostic exported to ${exported.path}`, data: exported.path };
	} catch (error) {
		return err(error);
	}
}

export function defaultNudgeAgentId(ctx: Pick<ExtensionContext, "cwd">, runId: string): string | undefined {
	const loaded = loadRunManifestById(ctx.cwd, runId);
	if (!loaded) return undefined;
	return readCrewAgents(loaded.manifest).find((agent) => agent.status === "running" || agent.status === "queued")?.taskId;
}
