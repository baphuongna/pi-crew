import * as fs from "node:fs";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { appendEvent } from "../../state/event-log.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import { cleanupRunWorktrees } from "../../worktree/cleanup.ts";
import { listImportedRuns } from "../import-index.ts";
import { exportRunBundle } from "../run-export.ts";
import { importRunBundle } from "../run-import.ts";
import { pruneFinishedRuns } from "../run-maintenance.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { configRecord, result, type TeamContext } from "./context.ts";
import { enforceDestructiveIntent, intentFromConfig } from "./intent-policy.ts";
import { executeHook, appendHookEvent } from "../../hooks/registry.ts";

export function handleWorktrees(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Worktrees requires runId.", { action: "worktrees", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "worktrees", status: "error" }, true);
	const withWorktrees = loaded.tasks.filter((task) => task.worktree);
	const lines = [`Worktrees for ${loaded.manifest.runId}:`, ...(withWorktrees.length ? withWorktrees.map((task) => `- ${task.id}: ${task.worktree!.path} branch=${task.worktree!.branch} reused=${task.worktree!.reused ? "true" : "false"}`) : ["- (none)"])];
	return result(lines.join("\n"), { action: "worktrees", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export function handleImports(_params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const imports = listImportedRuns(ctx.cwd);
	const lines = ["Imported pi-crew runs:", ...(imports.length ? imports.map((entry) => `- ${entry.runId} (${entry.scope})${entry.status ? ` [${entry.status}]` : ""} ${entry.team ?? "unknown"}/${entry.workflow ?? "none"}: ${entry.goal ?? ""}\n  Bundle: ${entry.bundlePath}\n  Summary: ${entry.summaryPath}`) : ["- (none)"])];
	return result(lines.join("\n"), { action: "imports", status: "ok" });
}

export function handleImport(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const cfg = configRecord(params.config);
	const bundlePath = typeof cfg.path === "string" ? cfg.path : typeof cfg.bundlePath === "string" ? cfg.bundlePath : undefined;
	if (!bundlePath) return result("Import requires config.path pointing at run-export.json.", { action: "import", status: "error" }, true);
	const scope = cfg.scope === "user" ? "user" : "project";
	try {
		const imported = importRunBundle(ctx.cwd, bundlePath, scope);
		return result([`Imported run bundle ${imported.runId}.`, `Bundle: ${imported.bundlePath}`, `Summary: ${imported.summaryPath}`].join("\n"), { action: "import", status: "ok" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`Import failed: ${message}`, { action: "import", status: "error" }, true);
	}
}

export async function handleExport(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	if (!params.runId) return result("Export requires runId.", { action: "export", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "export", status: "error" }, true);

	const hookReport = await executeHook("before_publish", { runId: loaded.manifest.runId, cwd: ctx.cwd });
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		return result(`Export blocked by hook: ${hookReport.reason ?? "before_publish hook blocked the operation."}`, { action: "export", status: "error", runId: loaded.manifest.runId }, true);
	}

	const exported = exportRunBundle(loaded.manifest, loaded.tasks);
	appendEvent(loaded.manifest.eventsPath, { type: "run.exported", runId: loaded.manifest.runId, data: exported });
	return result([`Exported run ${loaded.manifest.runId}.`, `JSON: ${exported.jsonPath}`, `Markdown: ${exported.markdownPath}`].join("\n"), { action: "export", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export async function handlePrune(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const intentError = enforceDestructiveIntent("prune", params, ctx.config);
	if (intentError) return intentError;
	if (!params.confirm) return result("prune requires confirm: true.", { action: "prune", status: "error" }, true);
	const keep = params.keep ?? 20;
	if (keep < 0 || !Number.isInteger(keep)) return result("keep must be an integer >= 0.", { action: "prune", status: "error" }, true);
	const intent = intentFromConfig(params.config);
	const pruned = pruneFinishedRuns(ctx.cwd, keep, { intent, signal: ctx.signal });
	const firstRunId = pruned.kept[0] ?? pruned.removed[0];
	if (firstRunId) {
		const manifest = loadRunManifestById(ctx.cwd, firstRunId)?.manifest;
		if (manifest) {
			const hookReport = await executeHook("before_cleanup", { runId: manifest.runId, cwd: ctx.cwd });
			appendHookEvent(manifest, hookReport);
		}
	}
	return result([`Pruned finished pi-crew runs.`, `Kept: ${pruned.kept.length}`, `Removed: ${pruned.removed.length}`, ...(pruned.auditPath ? [`Audit: ${pruned.auditPath}`] : []), ...(pruned.removed.length ? ["Removed runs:", ...pruned.removed.map((runId) => `- ${runId}`)] : [])].join("\n"), { action: "prune", status: "ok", intent });
}

export async function handleForget(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const intentError = enforceDestructiveIntent("forget", params, ctx.config);
	if (intentError) return intentError;
	if (!params.runId) return result("Forget requires runId.", { action: "forget", status: "error" }, true);
	if (!params.confirm) return result("forget requires confirm: true.", { action: "forget", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "forget", status: "error" }, true);

	const hookReport = await executeHook("before_forget", { runId: loaded.manifest.runId, cwd: ctx.cwd });
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		return result(`Forget blocked by hook: ${hookReport.reason ?? "before_forget hook blocked the operation."}`, { action: "forget", status: "error", runId: loaded.manifest.runId }, true);
	}

	const cleanup = cleanupRunWorktrees(loaded.manifest, { force: params.force });
	if (cleanup.preserved.length > 0 && !params.force) return result([`Run '${params.runId}' has preserved worktrees. Use force: true to forget anyway.`, ...cleanup.preserved.map((item) => `- ${item.path}: ${item.reason}`)].join("\n"), { action: "forget", status: "error", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot }, true);
	const intent = intentFromConfig(params.config);
	appendEvent(loaded.manifest.eventsPath, { type: "run.forget_requested", runId: loaded.manifest.runId, message: "Run state and artifacts are being forgotten.", data: { force: params.force === true, removedWorktrees: cleanup.removed, preservedWorktrees: cleanup.preserved, intent } });
	fs.rmSync(loaded.manifest.stateRoot, { recursive: true, force: true });
	fs.rmSync(loaded.manifest.artifactsRoot, { recursive: true, force: true });
	return result([`Forgot run ${loaded.manifest.runId}.`, `Removed state: ${loaded.manifest.stateRoot}`, `Removed artifacts: ${loaded.manifest.artifactsRoot}`, ...(cleanup.removed.length ? ["Removed worktrees:", ...cleanup.removed.map((item) => `- ${item}`)] : [])].join("\n"), { action: "forget", status: "ok", runId: loaded.manifest.runId, intent });
}

export async function handleCleanup(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const intentError = enforceDestructiveIntent("cleanup", params, ctx.config);
	if (intentError) return intentError;
	if (!params.runId) return result("Cleanup requires runId.", { action: "cleanup", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "cleanup", status: "error" }, true);

	const hookReport = await executeHook("before_cleanup", { runId: loaded.manifest.runId, cwd: ctx.cwd });
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		return result(`Cleanup blocked by hook: ${hookReport.reason ?? "before_cleanup hook blocked the operation."}`, { action: "cleanup", status: "error", runId: loaded.manifest.runId }, true);
	}

	const cleanup = cleanupRunWorktrees(loaded.manifest, { force: params.force, signal: ctx.signal });
	const intent = intentFromConfig(params.config);
	appendEvent(loaded.manifest.eventsPath, { type: "worktree.cleanup", runId: loaded.manifest.runId, data: { removed: cleanup.removed, preserved: cleanup.preserved, artifacts: cleanup.artifactPaths, intent } });
	const lines = [`Worktree cleanup for ${loaded.manifest.runId}:`, "Removed:", ...(cleanup.removed.length ? cleanup.removed.map((item) => `- ${item}`) : ["- (none)"]), "Preserved:", ...(cleanup.preserved.length ? cleanup.preserved.map((item) => `- ${item.path}: ${item.reason}`) : ["- (none)"]), "Artifacts:", ...(cleanup.artifactPaths.length ? cleanup.artifactPaths.map((item) => `- ${item}`) : ["- (none)"])];
	return result(lines.join("\n"), { action: "cleanup", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot, intent });
}
