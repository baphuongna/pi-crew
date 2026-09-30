import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { readEventsCursor } from "../../state/event-log/event-log.ts";
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
	// PERF (2026-08-24): `readEvents` parses full history (every archive + the
	// whole live file) and exposes no limit option, and the events action params
	// carry no full-history flag — so read the bounded cursor tail (4 MB /
	// 5000-event cap) and display the last 500 events by default.
	const cursor = readEventsCursor(loaded.manifest.eventsPath);
	const events = cursor.events.slice(-500);
	const lines = [
		`Events for ${loaded.manifest.runId}:`,
		// Truncation indicator: `total` is the cursor's event count before the
		// display slice — surface it whenever the slice dropped events.
		...(cursor.total > events.length ? [`(showing last ${events.length} of ${cursor.total} events)`] : []),
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

// ─── G18 (SDD 2026-09-30 WI-3): prompt-token breakdown surface ──────────────

/** File suffix of the per-task breakdown artifact written by pre-execution
 *  (`metadata/<taskId>.prompt-breakdown.json`) when PI_CREW_PROMPT_BREAKDOWN=1. */
const BREAKDOWN_FILE_SUFFIX = ".prompt-breakdown.json";

/** Shape of one section entry in a prompt-breakdown JSON artifact
 *  (see writeArtifact call in src/runtime/task-runner/pre-execution.ts). */
interface PromptBreakdownSection {
	chars: number;
	estTokens: number;
}

/**
 * G18: read the opt-in per-task prompt-token breakdown artifacts of a run and
 * surface per-task totals + the top-5 largest sections. Consumers: the leader
 * prompt (future W-F token decisions, G15/G17) and humans debugging prompt
 * bloat. The artifacts exist only when the host session was started with
 * PI_CREW_PROMPT_BREAKDOWN=1 (default off — zero cost when off, SR-02).
 * Mirrors the handleArtifacts pattern: resolve run → read the manifest
 * artifacts index → filter kind=metadata breakdown entries → read files.
 */
export function handleBreakdown(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId)
		return result(
			paramRequired("breakdown", "runId", "{ action: 'breakdown', runId: 'team_...' }"),
			{ action: "breakdown", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "breakdown", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "breakdown", status: "error" }, true);
	// Index-driven lookup (no disk scan): the manifest artifacts index carries
	// one metadata entry per task with a prompt breakdown.
	const breakdownArtifacts = loaded.manifest.artifacts.filter(
		(artifact) => artifact.kind === "metadata" && path.basename(artifact.path).endsWith(BREAKDOWN_FILE_SUFFIX),
	);
	const perTask: Array<{
		taskId: string;
		totalEstTokens: number;
		topSections: Array<{ section: string; estTokens: number; chars: number }>;
	}> = [];
	for (const artifact of breakdownArtifacts) {
		const taskId = path.basename(artifact.path).slice(0, -BREAKDOWN_FILE_SUFFIX.length);
		if (params.taskId && taskId !== params.taskId) continue;
		let sections: Record<string, PromptBreakdownSection>;
		try {
			sections = JSON.parse(fs.readFileSync(artifact.path, "utf-8")) as Record<string, PromptBreakdownSection>;
		} catch {
			continue; // unreadable/corrupt breakdown JSON — skip rather than fail the whole action
		}
		const entries = Object.entries(sections).filter((entry): entry is [string, PromptBreakdownSection] => {
			const value = entry[1];
			return value !== null && typeof value === "object" && typeof value.estTokens === "number";
		});
		const totalEstTokens = entries.reduce((sum, [, value]) => sum + value.estTokens, 0);
		const topSections = [...entries]
			.sort((a, b) => b[1].estTokens - a[1].estTokens)
			.slice(0, 5)
			.map(([section, value]) => ({ section, estTokens: value.estTokens, chars: value.chars ?? 0 }));
		perTask.push({ taskId, totalEstTokens, topSections });
	}
	if (perTask.length === 0) {
		const scope = params.taskId ? ` for task '${params.taskId}'` : "";
		return result(
			`No prompt-breakdown artifacts${scope} for ${loaded.manifest.runId}. Breakdown capture is opt-in: start the host Pi session with PI_CREW_PROMPT_BREAKDOWN=1 and re-run to record per-section token estimates.`,
			{ action: "breakdown", status: "ok", runId: loaded.manifest.runId, data: { runTotal: 0, perTask: [] } },
		);
	}
	const runTotal = perTask.reduce((sum, task) => sum + task.totalEstTokens, 0);
	const lines = [
		`Prompt-token breakdown for ${loaded.manifest.runId}:`,
		...perTask.flatMap((task) => [
			`- ${task.taskId}: ~${task.totalEstTokens} tokens`,
			...task.topSections.map((section) => `    - ${section.section}: ~${section.estTokens} tokens (${section.chars} chars)`),
		]),
		`Run total: ~${runTotal} tokens`,
	];
	return result(lines.join("\n"), {
		action: "breakdown",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
		data: { runTotal, perTask },
	});
}
