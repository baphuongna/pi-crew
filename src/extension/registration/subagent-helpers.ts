import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadRunManifestById } from "../../state/state-store.ts";
import { savePersistedSubagentRecord, type SubagentRecord, type SubagentSpawnOptions } from "../../subagents/manager.ts";

export function sendFollowUp(pi: ExtensionAPI, content: string): void {
	const sender = (pi as unknown as { sendMessage?: (message: unknown, options?: unknown) => void }).sendMessage;
	if (typeof sender !== "function") return;
	sender.call(pi, { customType: "pi-crew-subagent-notification", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}

export function refreshPersistedSubagentRecord(ctx: ExtensionContext | ExtensionCommandContext, record: SubagentRecord): SubagentRecord {
	if (!record.runId) return record;
	const loaded = loadRunManifestById(ctx.cwd, record.runId);
	if (!loaded) return record;
	if (loaded.manifest.status === "completed" || loaded.manifest.status === "failed" || loaded.manifest.status === "cancelled" || loaded.manifest.status === "blocked") {
		const refreshed = {
			...record,
			status: loaded.manifest.status,
			error: loaded.manifest.status === "completed" || loaded.manifest.status === "blocked" ? undefined : loaded.manifest.summary,
			completedAt: loaded.manifest.status === "blocked" ? undefined : record.completedAt ?? Date.now(),
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
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function readSubagentRunResult(ctx: ExtensionContext | ExtensionCommandContext, record: SubagentRecord): string | undefined {
	if (!record.runId) return record.result;
	const loaded = loadRunManifestById(ctx.cwd, record.runId);
	const task = loaded?.tasks.find((item) => item.resultArtifact) ?? loaded?.tasks[0];
	const path = task?.resultArtifact?.path;
	if (!path) return undefined;
	try {
		return fs.readFileSync(path, "utf-8").trim();
	} catch {
		return undefined;
	}
}

export function subagentToolResult(text: string, details: Record<string, unknown> = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

export function __test__subagentSpawnParams(params: Record<string, unknown>, ctx: Pick<ExtensionContext, "cwd">): SubagentSpawnOptions {
	return {
		cwd: ctx.cwd,
		type: typeof params.subagent_type === "string" && params.subagent_type.trim() ? params.subagent_type.trim() : "executor",
		description: typeof params.description === "string" && params.description.trim() ? params.description.trim() : "pi-crew subagent",
		prompt: typeof params.prompt === "string" ? params.prompt : "",
		background: params.run_in_background === true,
		model: typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined,
		maxTurns: typeof params.max_turns === "number" && Number.isFinite(params.max_turns) ? params.max_turns : undefined,
	};
}
