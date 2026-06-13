import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { TeamToolParams, type TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { CrewWidgetState } from "../../ui/widget/index.ts";
import { updateCrewWidget } from "../../ui/widget/index.ts";
import { updatePiCrewPowerbar } from "../../ui/powerbar-publisher.ts";
import type { createManifestCache } from "../../runtime/manifest-cache.ts";
import type { createRunSnapshotCache } from "../../ui/run-snapshot-cache.ts";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { Text } from "@earendil-works/pi-tui";
import { teamToolRenderer, statusIcon } from "../../ui/tool-renderers/index.ts";
// Team tool handler — lazy-loaded because team-tool.ts imports many modules
import type { handleTeamTool as HandleTeamToolFn } from "../team-tool.ts";
let _cachedHandleTeamTool: typeof HandleTeamToolFn | undefined;
async function handleTeamTool(params: Parameters<typeof HandleTeamToolFn>[0], ctx: Parameters<typeof HandleTeamToolFn>[1]): Promise<ReturnType<typeof HandleTeamToolFn>> {
	if (!_cachedHandleTeamTool) {
		// LAZY: team-tool.ts imports many modules — defer until first use.
		const mod = await import("../team-tool.ts");
		_cachedHandleTeamTool = mod.handleTeamTool;
	}
	return _cachedHandleTeamTool(params, ctx);
}
import { withSessionId } from "../team-tool/context.ts";
import { toolResult } from "../tool-result.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { formatCompactToolProgress } from "../../ui/tool-progress-formatter.ts";
import { logInternalError } from "../../utils/internal-error.ts";

const TEAM_TOOL_PROGRESS_TICK_MS = 1000;

type OnUpdate = (chunk: { content: { type: "text"; text: string }[] }) => void;

export interface RegisterTeamToolDeps {
	foregroundControllers: Map<string | symbol, AbortController>;
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	abortForegroundRun: (runId: string) => boolean;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	getManifestCache: (cwd: string) => ReturnType<typeof createManifestCache>;
	getRunSnapshotCache?: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;
	getMetricRegistry?: () => MetricRegistry | undefined;
	widgetState: CrewWidgetState;
	onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
}

export function resolveCwdOverride(baseCwd: string, override: string | undefined): { ok: true; cwd: string } | { ok: false; error: string } {
	if (!override) return { ok: true, cwd: baseCwd };
	try {
		const resolved = resolveRealContainedPath(baseCwd, override);
		const stat = fs.statSync(resolved);
		if (!stat.isDirectory()) return { ok: false, error: `cwd override is not a directory: ${resolved}` };
		return { ok: true, cwd: resolved };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Invalid cwd override: ${message}` };
	}
}

export function registerTeamTool(pi: ExtensionAPI, deps: RegisterTeamToolDeps): void {
	const tool: ToolDefinition = {
		name: "team",
		label: "Team",
		description: "Coordinate Pi teams. Use proactively for complex multi-file work, planning, implementation, tests, reviews, security audits, research, async/background runs, and worktree-isolated execution. Use action='recommend' when unsure which team/workflow to choose. Destructive actions require explicit user confirmation.",
		promptSnippet: "Use the team tool proactively for coordinated multi-agent work. If unsure, call { action: 'recommend', goal } first, then run or plan with the suggested team/workflow.",
		parameters: TeamToolParams as never,
		async execute(_id, params, signal, onUpdate, ctx) {
			const controller = new AbortController();
			const toolKey = Symbol();
			deps.foregroundControllers.set(toolKey, controller);
			const abort = (): void => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			const stopProgress = startTeamToolProgressBinder(onUpdate as OnUpdate | undefined);
			try {
				const resolved = params as TeamToolParamsValue;
				const cwdOverride = resolveCwdOverride(ctx.cwd, resolved.cwd);
				if (!cwdOverride.ok) return toolResult(cwdOverride.error, { action: resolved.action ?? "list", status: "error" }, true);
				const toolCtx = withSessionId({ ...ctx, cwd: cwdOverride.cwd });
				// Phase 1.5: Auto-set session name from team run context
				if (resolved.action === "run" && resolved.goal && !pi.getSessionName()) {
					const runLabel = resolved.team ?? resolved.agent ?? "direct";
					pi.setSessionName(`pi-crew: ${runLabel}/${resolved.workflow ?? "default"} — ${resolved.goal.slice(0, 60)}`);
				}
				const output = await handleTeamTool(resolved, { ...toolCtx, signal: controller.signal, metricRegistry: deps.getMetricRegistry?.(), startForegroundRun: (runner, runId) => deps.startForegroundRun(toolCtx, runner, runId), abortForegroundRun: deps.abortForegroundRun, onRunStarted: (runId) => { stopProgress.attach(toolCtx.cwd, runId); deps.openLiveSidebar(toolCtx, runId); }, onJsonEvent: deps.onJsonEvent, getRunSnapshotCache: deps.getRunSnapshotCache });
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
				deps.foregroundControllers.delete(toolKey);
				stopProgress.stop();
			}
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any, context: any): any {
			return teamToolRenderer.renderCall(args, theme, context);
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, options: any, theme: any, context: any): any {
			try {
				return teamToolRenderer.renderResult(result, options, theme, context);
			} catch {
				return new Text(statusIcon("completed", theme) + " done", 0, 0);
			}
		},
	};
	pi.registerTool(tool);
}

interface TeamToolProgressBinder {
	attach: (cwd: string, runId: string) => void;
	stop: () => void;
}

function startTeamToolProgressBinder(onUpdate: OnUpdate | undefined): TeamToolProgressBinder {
	const _log = (msg: string) => { try { writeFileSync('/tmp/pi-crew-progress.log', `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' }); } catch {} };
	if (!onUpdate) {
		_log('no onUpdate');
		return { attach: () => {}, stop: () => {} };
	}
	_log('binder created');
	const startedAt = Date.now();
	let cwd: string | undefined;
	let runId: string | undefined;
	let _log: ((msg: string) => void) | undefined;
	const tick = (): void => {
		try {
			if (!cwd || !runId) {
				const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
				const msg = `team status=starting elapsed=${elapsed}s`;
				(`TICK no-attach: ${msg}`);
				onUpdate({ content: [{ type: "text", text: msg }] });
				return;
			}
			const loaded = loadRunManifestById(cwd, runId);
			if (!loaded) {
				const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
				const msg = `team run=${runId} elapsed=${elapsed}s (manifest pending)`;
				(`TICK no-manifest: ${msg}`);
				onUpdate({ content: [{ type: "text", text: msg }] });
				return;
			}
			(`TICK manifest loaded: status=${loaded.manifest.status} tasks=${loaded.tasks?.length}`);
			let agents;
			try { agents = readCrewAgents(loaded.manifest); } catch { /* ignore */ }
			const text = formatCompactToolProgress({
				agentId: runId,
				status: loaded.manifest.status,
				runId,
				startedAt,
				manifest: loaded.manifest,
				tasks: loaded.tasks,
				agents,
			});
			(`TICK progress: ${text.slice(0, 120)}`);
			onUpdate({ content: [{ type: "text", text }] });
		} catch (error) {
			(`TICK error: ${error}`);
			logInternalError("team-tool.progress", error, `runId=${runId ?? ""}`);
		}
	};
	tick();
	const timer = setInterval(tick, TEAM_TOOL_PROGRESS_TICK_MS);
	if (typeof timer.unref === "function") timer.unref();
	return {
		attach: (boundCwd, boundRunId) => { cwd = boundCwd; runId = boundRunId; tick(); },
		stop: () => clearInterval(timer),
	};
}
