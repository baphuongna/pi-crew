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

export interface RegisterTeamToolDeps {
	foregroundControllers: Set<AbortController>;
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	getManifestCache: (cwd: string) => ReturnType<typeof createManifestCache>;
	getRunSnapshotCache?: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;
	getMetricRegistry?: () => MetricRegistry | undefined;
	widgetState: CrewWidgetState;
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
				// Phase 1.5: Auto-set session name from team run context
				if (resolved.action === "run" && resolved.goal && !pi.getSessionName()) {
					const runLabel = resolved.team ?? resolved.agent ?? "direct";
					pi.setSessionName(`pi-crew: ${runLabel}/${resolved.workflow ?? "default"} — ${resolved.goal.slice(0, 60)}`);
				}
				const output = await handleTeamTool(resolved, { ...ctx, signal: controller.signal, metricRegistry: deps.getMetricRegistry?.(), startForegroundRun: (runner, runId) => deps.startForegroundRun(ctx, runner, runId), onRunStarted: (runId) => deps.openLiveSidebar(ctx, runId) });
				if (resolved.action === "run") {
					pi.appendEntry("crew:run-started", {
						runId: output.details?.runId,
						team: resolved.team,
						workflow: resolved.workflow,
						agent: resolved.agent,
						goal: resolved.goal,
						status: output.details?.status,
						timestamp: Date.now(),
					});
				}
				const config = loadConfig(ctx.cwd).config.ui;
				const cache = deps.getManifestCache(ctx.cwd);
				const snapshotCache = deps.getRunSnapshotCache?.(ctx.cwd);
				updateCrewWidget(ctx, deps.widgetState, config, cache, snapshotCache);
				updatePiCrewPowerbar(pi.events, ctx.cwd, config, cache, snapshotCache, ctx);
				return output;
			} finally {
				signal?.removeEventListener("abort", abort);
				deps.foregroundControllers.delete(controller);
			}
		},
	};
	pi.registerTool(tool);
}
