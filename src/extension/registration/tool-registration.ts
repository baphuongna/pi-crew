/**
 * Tool registration installer for pi-crew.
 *
 * Single entry point that wires every `pi.registerTool(...)` call site
 * in the extension. Today that means two heavy tools:
 *   • `team` — the multi-agent orchestration tool (team-tool.ts).
 *   • subagent tools — agent spawn tool + result-join helpers
 *     (subagent-tools.ts).
 *
 * The actual tool handlers live in `registration/team-tool.ts` and
 * `registration/subagent-tools.ts` (already extracted); this file is
 * the orchestrator-level wrapper that calls them with the right deps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegistrationContext } from "./registration-types.ts";
import { registerSubagentTools } from "./subagent-tools.ts";
import { registerTeamTool } from "./team-tool.ts";

/**
 * Register all pi-crew tools on the ExtensionAPI.
 *
 * Pulls every dependency the underlying tools need off `ctx`. The
 * orchestrator guarantees those fields are populated before this call
 * (see registerPiTeams in ../register.ts).
 */
export function registerPiTools(pi: ExtensionAPI, ctx: RegistrationContext): void {
	registerTeamTool(pi, {
		foregroundControllers: ctx.foregroundControllers,
		startForegroundRun: ctx.startForegroundRun,
		abortForegroundRun: ctx.abortForegroundRun,
		openLiveSidebar: ctx.openLiveSidebar,
		getManifestCache: ctx.getManifestCache,
		getRunSnapshotCache: ctx.getRunSnapshotCache,
		getMetricRegistry: () => ctx.observabilityState.metricRegistry,
		widgetState: ctx.widgetState,
		onJsonEvent: (taskId, runId, event) => {
			const record = event as Record<string, unknown>;
			const eventType = typeof record.type === "string" ? record.type : undefined;
			if (eventType) ctx.lifecycleState.overflowTracker?.feedEvent(taskId, runId, eventType);
		},
	});
	registerSubagentTools(pi, ctx.subagentManager, {
		ownerSessionGeneration: ctx.captureSessionGeneration,
		// Subagent options only type-check against `unknown` for ctx; cast
		// back to ExtensionContext since the subagent tool re-validates.
		startForegroundRun: (subCtx, runner, runId) =>
			ctx.startForegroundRun(subCtx as Parameters<typeof ctx.startForegroundRun>[0], runner, runId),
		batchBarrier: ctx.batchBarrier,
	});
}
