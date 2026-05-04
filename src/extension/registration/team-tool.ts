import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { TeamToolParams, type TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { CrewWidgetState } from "../../ui/crew-widget.ts";
import { updateCrewWidget } from "../../ui/crew-widget.ts";
import { updatePiCrewPowerbar } from "../../ui/powerbar-publisher.ts";
import type { createManifestCache } from "../../runtime/manifest-cache.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { handleTeamTool } from "../team-tool.ts";
import { toolResult } from "../tool-result.ts";

export interface RegisterTeamToolDeps {
	foregroundControllers: Set<AbortController>;
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	getManifestCache: (cwd: string) => ReturnType<typeof createManifestCache>;
	getRunSnapshotCache?: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;
	getMetricRegistry?: () => MetricRegistry | undefined;
	widgetState: CrewWidgetState;
	onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
}

function resolveCwdOverride(baseCwd: string, override: string | undefined): { ok: true; cwd: string } | { ok: false; error: string } {
	if (!override) return { ok: true, cwd: baseCwd };
	const resolved = path.resolve(baseCwd, override);
	try {
		const stat = fs.statSync(resolved);
		if (!stat.isDirectory()) return { ok: false, error: `cwd override is not a directory: ${resolved}` };
		return { ok: true, cwd: resolved };
	} catch {
		return { ok: false, error: `cwd override does not exist: ${resolved}` };
	}
}

export function registerTeamTool(pi: ExtensionAPI, deps: RegisterTeamToolDeps): void {
	const tool: ToolDefinition = {
		name: "team",
		label: "Team",
		description: "Coordinate Pi teams. Use proactively for complex multi-file work, planning, implementation, tests, reviews, security audits, research, async/background runs, and worktree-isolated execution. Use action='recommend' when unsure which team/workflow to choose. Destructive actions require explicit user confirmation.",
		promptSnippet: "Use the team tool proactively for coordinated multi-agent work. If unsure, call { action: 'recommend', goal } first, then run or plan with the suggested team/workflow.",
		parameters: TeamToolParams as never,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const controller = new AbortController();
			deps.foregroundControllers.add(controller);
			const abort = (): void => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const resolved = params as TeamToolParamsValue;
				const cwdOverride = resolveCwdOverride(ctx.cwd, resolved.cwd);
				if (!cwdOverride.ok) return toolResult(cwdOverride.error, { action: resolved.action ?? "list", status: "error" }, true);
				const toolCtx = { ...ctx, cwd: cwdOverride.cwd };
				// Phase 1.5: Auto-set session name from team run context
				if (resolved.action === "run" && resolved.goal && !pi.getSessionName()) {
					const runLabel = resolved.team ?? resolved.agent ?? "direct";
					pi.setSessionName(`pi-crew: ${runLabel}/${resolved.workflow ?? "default"} — ${resolved.goal.slice(0, 60)}`);
				}
				const output = await handleTeamTool(resolved, { ...toolCtx, signal: controller.signal, metricRegistry: deps.getMetricRegistry?.(), startForegroundRun: (runner, runId) => deps.startForegroundRun(toolCtx, runner, runId), onRunStarted: (runId) => deps.openLiveSidebar(toolCtx, runId), onJsonEvent: deps.onJsonEvent });
				if (resolved.action === "run" && !output.isError && typeof output.details?.runId === "string") {
					pi.appendEntry("crew:run-started", {
						runId: output.details.runId,
						team: resolved.team,
						workflow: resolved.workflow,
						agent: resolved.agent,
						goal: resolved.goal,
						status: output.details?.status,
						timestamp: Date.now(),
					});
				}
				const config = loadConfig(toolCtx.cwd).config.ui;
				const cache = deps.getManifestCache(toolCtx.cwd);
				const snapshotCache = deps.getRunSnapshotCache?.(toolCtx.cwd);
				updateCrewWidget(toolCtx, deps.widgetState, config, cache, snapshotCache);
				updatePiCrewPowerbar(pi.events, toolCtx.cwd, config, cache, snapshotCache, toolCtx);
				return output;
			} finally {
				signal?.removeEventListener("abort", abort);
				deps.foregroundControllers.delete(controller);
			}
		},
	};
	pi.registerTool(tool);
}
