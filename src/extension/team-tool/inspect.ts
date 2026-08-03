import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { readEvents } from "../../state/event-log/event-log.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { aggregateUsage, formatCostReport, formatUsage } from "../../state/usage.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";
import { formatFailurePatterns } from "./failure-patterns.ts";
import { paramRequired } from "./param-error.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

export function handleEvents(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId)
		return result(
			paramRequired("events", "runId", "{ action: 'events', runId: 'team_...' }"),
			{ action: "events", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "events", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "events", status: "error" }, true);
	const events = readEvents(loaded.manifest.eventsPath);
	const lines = [
		`Events for ${loaded.manifest.runId}:`,
		...(events.length
			? events.map(
					(event) =>
						`${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? `: ${event.message}` : ""}${event.data ? ` ${JSON.stringify(event.data)}` : ""}`,
				)
			: ["(none)"]),
	];
	return result(lines.join("\n"), {
		action: "events",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
}

export function handleArtifacts(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId)
		return result(
			paramRequired("artifacts", "runId", "{ action: 'artifacts', runId: 'team_...' }"),
			{ action: "artifacts", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "artifacts", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "artifacts", status: "error" }, true);
	const lines = [
		`Artifacts for ${loaded.manifest.runId}:`,
		...(loaded.manifest.artifacts.length
			? loaded.manifest.artifacts.map(
					(artifact) =>
						`- ${artifact.kind}: ${artifact.path}${artifact.sizeBytes !== undefined ? ` (${artifact.sizeBytes} bytes)` : ""}${artifact.contentHash ? ` sha256=${artifact.contentHash.slice(0, 12)}` : ""}`,
				)
			: ["- (none)"]),
	];
	return result(lines.join("\n"), {
		action: "artifacts",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
}

export function handleSummary(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId)
		return result(
			paramRequired("summary", "runId", "{ action: 'summary', runId: 'team_...' }"),
			{ action: "summary", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "summary", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "summary", status: "error" }, true);
	const usage = aggregateUsage(loaded.tasks);
	const failurePatternLines = formatFailurePatterns(loaded.tasks);
	const lines = [
		`Summary for ${loaded.manifest.runId}`,
		`Status: ${loaded.manifest.status}`,
		`Team: ${loaded.manifest.team}`,
		`Workflow: ${loaded.manifest.workflow ?? "(none)"}`,
		`Goal: ${loaded.manifest.goal}`,
		`Usage: ${formatUsage(usage)}`,
		"",
		formatCostReport(loaded.tasks),
		...(failurePatternLines.length > 0 ? ["", ...failurePatternLines] : []),
		"",
		"Tasks:",
		...loaded.tasks.map(
			(task) => `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.error ? ` - ${task.error}` : ""}`,
		),
	];
	return result(lines.join("\n"), {
		action: "summary",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
}
