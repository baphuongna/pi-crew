import { allAgents, discoverAgents } from "../../agents/discover-agents.ts";
import { loadConfig } from "../../config/config.ts";
import { sanitizeTaskText } from "../../runtime/task-packet.ts";
// Heavy runtime — lazy-loaded to avoid 1.4s import cost at extension registration.
import type { executeTeamRun as ExecuteTeamRunFn } from "../../runtime/team-runner.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { registerActiveRun, unregisterActiveRun } from "../../state/active-run-registry.ts";
import { writeArtifact } from "../../state/artifact-store.ts";
import { atomicWriteJson } from "../../state/atomic-write.ts";
import { createRunManifest, loadRunManifestById, updateRunStatus } from "../../state/state-store.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import { assertCleanLeaderAsync, findGitRootAsync } from "../../worktree/worktree-manager.ts";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-only import for TS inference
const _typeCheck: typeof ExecuteTeamRunFn = null as never as typeof ExecuteTeamRunFn;

import { logInternalError } from "../../utils/internal-error.ts";
import { resolveContainedPath, resolveRealContainedPath } from "../../utils/safe-paths.ts";

let _cachedExecuteTeamRun: typeof ExecuteTeamRunFn | undefined;
async function executeTeamRun(...args: Parameters<typeof ExecuteTeamRunFn>): Promise<Awaited<ReturnType<typeof ExecuteTeamRunFn>>> {
	if (!_cachedExecuteTeamRun) {
		// LAZY: heavy runtime — defer 1.4s import cost until team run actually executes.
		const mod = await import("../../runtime/team-runner.ts");
		_cachedExecuteTeamRun = mod.executeTeamRun;
	}
	return _cachedExecuteTeamRun(...args);
}

import { resolveCrewRuntime, runtimeResolutionState } from "../../runtime/runtime-resolver.ts";
import { appendEventAsync, readEvents } from "../../state/event-log.ts";
import type { RunMetrics } from "../../state/run-metrics.ts";
import type { RuntimeResolutionState, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";

/**
 * Module-scoped latch for the crew-init dynamic import.
 *
		// LAZY: defer dynamic import of module to its call site.
 * `crew-init.ts` is dynamically `await import()`'d from `handleRun` below, which
 * N concurrent subagents hit simultaneously (every `team` tool call runs it).
 * Under the tsx/jiti loader, concurrent first-imports race module-record
 * instantiation → top-level `const` initializers (e.g. CREW_README) hit TDZ
 * (`Cannot access 'CREW_README' before initialization`) and namespace bindings
 * arrive as `undefined` (`reading 'existsSync'`). crew-init.ts's own header
 * documents this for the `path` binding; the race persists for other top-level
 * consts because module-body evaluation itself races.
 *
 * The latch makes concurrent callers share ONE in-flight import promise, so the
 * module body evaluates exactly once regardless of fanout. Same pattern as
 * runtime-warmup.ts / the v0.8.1 peer-dep latch, applied to this specific
 * dynamic-import race site.
 *
 * IMPORTANT: must be `var` (not `let`) — when this module is loaded via
 * `jiti.import()` (the pi extension loader) wrapped in an async function,
 * `let` causes a Temporal Dead Zone error because the function declaration
 * below is hoisted and can be called before this `let` line executes under
 * certain microtask schedules. `var` is hoisted with `undefined`, avoiding
 * the TDZ. Round-11 cold review reproduction:
 *   `team action='run' workflow='<dynamic>'` → "Cannot access 'crewInitPromise'
 *    before initialization" at run.ts load. See RFC 17 + commit fixing this.
 */
var crewInitPromise: Promise<typeof import("../../state/crew-init.ts")> | undefined;
function loadCrewInit(): Promise<typeof import("../../state/crew-init.ts")> {
	if (!crewInitPromise) {
		crewInitPromise = import("../../state/crew-init.ts");
	}
	return crewInitPromise;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { hasAsyncStartMarker } from "../../runtime/async-marker.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../../runtime/process-status.ts";
import { waitForRun } from "../../runtime/run-tracker.ts";
import { collectRunMetrics } from "../../state/run-metrics.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { effectiveRunConfig } from "./config-patch.ts";
import { buildParentContext, result, type TeamContext } from "./context.ts";
import { isGoalWrapEnabled, shouldGoalWrap, startGoalWrappedRun } from "./goal-wrap.ts";

function tailFile(filePath: string, maxBytes = 4096): string | undefined {
	try {
		// Cap at 512KB to prevent OOM from misconfigured callers.
		const safeMaxBytes = Math.min(maxBytes, 512 * 1024);
		const stat = fs.statSync(filePath);
		const start = Math.max(0, stat.size - safeMaxBytes);
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(stat.size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			return buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function scheduleBackgroundEarlyExitGuard(cwd: string, runId: string, pid: number | undefined, logPath: string): void {
	if (process.env.PI_CREW_ASYNC_EARLY_EXIT_GUARD === "0") return;
	const timer = setTimeout(() => {
		const loaded = loadRunManifestById(cwd, runId);
		if (!loaded || !isActiveRunStatus(loaded.manifest.status)) return;
		if (hasAsyncStartMarker(loaded.manifest)) return;
		if (
			readEvents(loaded.manifest.eventsPath).some(
				(event) => event.type === "async.started" || event.type === "async.completed" || event.type === "async.failed",
			)
		)
			return;
		const liveness = checkProcessLiveness(pid);
		if (liveness.alive) return;
		const tail = tailFile(logPath);
		const message = `Background runner exited within 3s; see background.log${tail ? `\n${tail}` : ""}`;
		const failed = updateRunStatus(loaded.manifest, "failed", "Background runner exited within 3s; see background.log");
		void appendEventAsync(failed.eventsPath, {
			type: "async.failed",
			runId: failed.runId,
			message,
			data: { pid, detail: liveness.detail },
		});
	}, 3000);
	timer.unref();
}

/**
 * Max analysis size in bytes — matches the `maxLength: 100_000` schema cap on
 * the inline `analysis` param, so the file channel can't smuggle in a larger
 * payload than the inline channel allows (prompt-size blowup guard).
 */
const MAX_ANALYSIS_BYTES = 100_000;

/**
 * Resolve the analysis channel (round-X Y1): inline `analysis` or `analysisPath` file.
 *
 * Called BEFORE `createRunManifest` so validation failures fail-fast and no orphan
 * run state is left on disk. Sanitizes the parsed content with the same
 * {@link sanitizeTaskText} machinery used in `buildTaskPacket` (SEC-007), since the
 * resulting text is injected into worker prompts via standard sharedReads.
 *
 * Mutual exclusivity mirrors the `budgetTotal`/`budgetUnlimited` pattern in
 * `goal.ts` — a cold-review #2 blocking fix pattern.
 */
function resolveAnalysisText(
	params: TeamToolParamsValue,
	cwd: string,
): { text?: string; error?: string; source: "inline" | "path" | "none" } {
	const hasInline = typeof params.analysis === "string" && params.analysis.length > 0;
	const hasPath = typeof params.analysisPath === "string" && params.analysisPath.length > 0;

	if (hasInline && hasPath) {
		return {
			error: "`analysis` and `analysisPath` are mutually exclusive. Set exactly one.",
			source: "none",
		};
	}
	if (!hasInline && !hasPath) return { source: "none" };

	if (hasPath) {
		let resolved: string;
		try {
			resolved = resolveContainedPath(cwd, params.analysisPath as string);
		} catch {
			return {
				error: `analysisPath must be within project directory: ${params.analysisPath}`,
				source: "none",
			};
		}
		if (!fs.existsSync(resolved)) {
			return {
				error: `Analysis file not found: ${resolved}`,
				source: "none",
			};
		}
		// Size cap BEFORE reading: mirror the inline schema cap (maxLength 100_000)
		// so a large file can't blow up worker prompts via the sharedReads channel.
		const { size } = fs.statSync(resolved);
		if (size > MAX_ANALYSIS_BYTES) {
			return {
				error: `Analysis file too large: ${size} bytes (max ${MAX_ANALYSIS_BYTES}). Trim the analysis or pass a summary inline.`,
				source: "none",
			};
		}
		const raw = fs.readFileSync(resolved, "utf-8");
		const sanitized = sanitizeTaskText(raw);
		if (!sanitized) return { source: "none" };
		return { text: sanitized, source: "path" };
	}

	// hasInline
	const sanitized = sanitizeTaskText(params.analysis as string);
	if (!sanitized) return { source: "none" };
	return { text: sanitized, source: "inline" };
}

/**
 * Options for {@link formatRunResult} (EXT-2 refactor).
 */
export interface FormatRunResultOptions {
	/** Task states for the completed run (used to render the per-task summary in "waited" mode). */
	tasks: TeamTaskState[];
	/** Pre-computed run metrics snapshot; omitted when the run finished before metrics were recorded. */
	metrics: RunMetrics | undefined;
	/** Goal text — truncated to 100 chars in the "waited" banner. */
	goal: string;
	/** Team name (for the banner). */
	team: string;
	/** Workflow name (for the scaffold banner). */
	workflow: string;
	/** Optional workspace identifier (session id / cwd) — surfaced in `details.data` for traceability. */
	workspaceId?: string;
	/** Runtime resolution — required for `mode: "scaffold"`, optional otherwise. */
	runtime?: RuntimeResolutionState;
	/** Output mode:
	 *  - `"waited"` (default) — detailed per-task summary after `waitForRun` resolved
	 *    (replaces the former async + foreground completion blocks).
	 *  - `"scaffold"` — concise "Created pi-crew run" banner for runs that completed
	 *    without worker execution (scaffold mode / `executeWorkers=false`).
	 */
	mode?: "waited" | "scaffold";
}

/**
 * Format the text + {@link PiTeamsToolResult} for a completed team run.
 *
 * Replaces three near-identical inline blocks in `handleRun` (EXT-2 finding):
 *   1. Async-spawned run completion (after `waitForRun`).
 *   2. Foreground-run completion (after `waitForRun`).
 *   3. Scaffold / no-executeWorkers completion (after `executeTeamRun` returns
 *      synchronously without launching workers).
 *
 * The output is byte-identical to the prior inline implementations when
 * `workspaceId` is unset. When `workspaceId` is provided it is included in
 * `details.data.workspaceId` so downstream consumers (TUI widgets, audit logs)
 * can attribute the result to the originating session/cwd.
 */
function formatRunResult(manifest: TeamRunManifest, options: FormatRunResultOptions): PiTeamsToolResult {
	const { tasks, metrics, goal, team, workflow, workspaceId, runtime, mode = "waited" } = options;

	if (mode === "scaffold") {
		// Scaffold / no-worker banner. `runtime` is required in this mode — callers
		// must provide it so we can render the runtime kind + explanation.
		const runtimeLine = runtime
			? `Runtime: ${runtime.kind}${runtime.fallback ? ` (fallback from ${runtime.requestedMode})` : ""}${runtime.reason ? ` - ${runtime.reason}` : ""}`
			: "Runtime: unknown";
		const runtimeExplanation = !runtime
			? ""
			: runtime.kind === "child-process"
				? "Child Pi worker execution is enabled by default; each task is launched as a separate Pi process. Set runtime.mode=scaffold or executeWorkers=false only for dry runs."
				: runtime.kind === "live-session"
					? "Experimental live-session worker execution was enabled."
					: "Safe scaffold mode: child Pi workers were not launched because runtime.mode=scaffold or executeWorkers=false was configured.";
		const text = [
			`Created pi-crew run ${manifest.runId}.`,
			`Team: ${team}`,
			`Workflow: ${workflow}`,
			`Status: ${manifest.status}`,
			`Tasks: ${tasks.length}`,
			`State: ${manifest.stateRoot}`,
			`Artifacts: ${manifest.artifactsRoot}`,
			"",
			runtimeLine,
			runtimeExplanation,
		]
			.filter((line) => line !== "")
			.join("\n");
		const isError = manifest.status === "failed";
		return result(
			text,
			{
				action: "run",
				status: isError ? "error" : "ok",
				runId: manifest.runId,
				artifactsRoot: manifest.artifactsRoot,
				metrics,
				...(workspaceId ? { data: { workspaceId } } : {}),
			},
			isError,
		);
	}

	// mode === "waited" — detailed per-task summary.
	const lines: string[] = [`pi-crew run ${manifest.status}: ${manifest.runId} (${team})`, `Goal: ${goal.slice(0, 100)}`];
	if (metrics) {
		lines.push("");
		lines.push(
			`Metrics: ${metrics.completedCount}/${metrics.taskCount} tasks, ${metrics.totalTokens} tokens, ${metrics.durationMs}ms, consistency=${metrics.consistencyScore}`,
		);
	}

	if (tasks.length > 0) {
		// Read run-level summary artifact if present
		let summaryContent: string | undefined;
		const summaryArtifact = manifest.artifacts?.find((a: { kind?: string }) => a.kind === "summary");
		if (summaryArtifact) {
			try {
				const sumPath = path.join(manifest.artifactsRoot, summaryArtifact.path);
				summaryContent = fs.readFileSync(sumPath, "utf-8").trim().slice(0, 4000);
			} catch {
				/* summary unavailable */
			}
		}

		const taskLines: string[] = [];
		let failedCount = 0;
		const failedIds: string[] = [];
		for (const task of tasks) {
			let resultExcerpt = "";
			if (task.resultArtifact?.path) {
				try {
					// H-3 fix (code-review 2026-06-23): resolve the result artifact path
					// inside artifactsRoot via the project's safe-path primitive. Rejects
					// absolute paths (/etc/passwd) and ../ traversal that the old
					// path.isAbsolute shortcut + bare path.join allowed.
					const resPath = resolveRealContainedPath(manifest.artifactsRoot, task.resultArtifact.path);
					resultExcerpt = fs.readFileSync(resPath, "utf-8").trim().slice(0, 2000);
				} catch {
					resultExcerpt = "(result unavailable)";
				}
			}
			const shortResult = resultExcerpt.slice(0, 500);
			const statusTag = task.status === "completed" ? "✓" : task.status === "failed" ? "✗" : task.status === "cancelled" ? "⊘" : "·";
			taskLines.push(
				`- ${statusTag} ${task.id} [${task.role}]: ${task.status}${shortResult ? " — " + shortResult : ""}${task.error ? ` | Error: ${task.error.slice(0, 200)}` : ""}`,
			);
			if (task.status === "failed" || task.status === "needs_attention") {
				failedCount++;
				failedIds.push(task.id);
			}
		}

		lines.push("");
		lines.push(`Tasks (${tasks.length}):`);
		lines.push(...taskLines);

		if (summaryContent) {
			lines.push("");
			lines.push("Summary:");
			lines.push(summaryContent.slice(0, 2000));
		}

		if (failedCount === 0) {
			lines.push("");
			lines.push("All tasks completed successfully.");
		} else {
			lines.push("");
			lines.push(`${failedCount} task(s) failed: ${failedIds.join(", ")}. Consider retrying.`);
		}
	} else {
		lines.push(
			manifest.status === "completed"
				? "Run completed with no task results."
				: `The run ended with status: ${manifest.status}. Check the run artifacts for details.`,
		);
	}

	const runFailed = manifest.status === "failed" || manifest.status === "blocked";
	return result(
		lines.join("\n"),
		{
			action: "run",
			status: runFailed ? "error" : "ok",
			runId: manifest.runId,
			artifactsRoot: manifest.artifactsRoot,
			metrics,
			...(workspaceId ? { data: { workspaceId } } : {}),
		},
		runFailed,
	);
}

export async function handleRun(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	// CHAIN DISPATCH: runs before goal validation since a chain has no top-level
	// goal. The injected handleRun reference breaks the run.ts ↔ chain-dispatch.ts
	// import cycle; the lazy import defers the chain-executor cost until a chain is
	// actually requested. Existing run/workflow paths below are unchanged.
	if (params.chain) {
		// LAZY: defer chain-dispatch import until a chain is actually requested.
		const { handleChainRun } = await import("./chain-dispatch.ts");
		return handleChainRun(params, ctx, handleRun);
	}
	const goal = params.goal ?? params.task;
	if (!goal) return result("Run requires goal or task.", { action: "run", status: "error" }, true);
	const intentPrefix = goal.length > 60 ? `${goal.slice(0, 57)}...` : goal;

	// P0: Ensure .crew directory structure exists before creating any manifests.
	// Latched dynamic import (loadCrewInit) — concurrent `team` tool calls from
	// N subagents share ONE in-flight promise so crew-init.ts's module body
	// evaluates exactly once (avoids the cold-start race on CREW_README / path / fs).
	const workingDir = ctx.cwd ?? process.cwd();
	const { ensureCrewDirectory } = await loadCrewInit();
	await ensureCrewDirectory(workingDir);

	// WORKTREE FIX: If worktree mode is needed but cwd is not a git repo,
	// auto-correct to the nearest git repo root. This prevents "not a git repository"
	// errors when ctx.cwd points to a parent directory that isn't a git repo.
	let resolvedCtx = ctx;
	if (workingDir) {
		try {
			const gitRoot = await findGitRootAsync(workingDir);
			if (gitRoot && gitRoot !== workingDir) {
				resolvedCtx = { ...ctx, cwd: gitRoot };
			}
		} catch {
			// cwd is not in a git repo — validate below if worktree mode is needed
		}
	}

	// WORKTREE PRECONDITION CHECK: validate git repo exists and is clean
	// BEFORE creating the run manifest, so we return a friendly error
	// instead of crashing mid-execution in prepareTaskWorkspace.
	if (params.workspaceMode === "worktree") {
		let gitRoot: string | undefined;
		try {
			gitRoot = await findGitRootAsync(resolvedCtx.cwd);
		} catch {
			// not a git repo
		}
		if (!gitRoot) {
			return result(
				`Worktree mode requires a git repository. '${resolvedCtx.cwd}' is not inside a git repo.\nUse workspaceMode: 'single' or run from a git repository.`,
				{ action: "run", status: "error" },
				true,
			);
		}
		// Check if clean leader is required (can be disabled via config)
		const preCheckConfig = loadConfig(resolvedCtx.cwd);
		if (preCheckConfig.config.requireCleanWorktreeLeader !== false) {
			try {
				await assertCleanLeaderAsync(gitRoot);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return result(
					`${msg}\nCommit or stash changes before using worktree mode, or use workspaceMode: 'single'.`,
					{ action: "run", status: "error" },
					true,
				);
			}
		}
	}

	const teams = allTeams(discoverTeams(resolvedCtx.cwd));
	const workflows = allWorkflows(discoverWorkflows(resolvedCtx.cwd));
	const agents = allAgents(discoverAgents(resolvedCtx.cwd));
	const directAgent = params.agent ? agents.find((item) => item.name === params.agent) : undefined;
	if (params.agent && !directAgent) return result(`Agent '${params.agent}' not found.`, { action: "run", status: "error" }, true);
	const teamName = params.team ?? "default";
	const team = directAgent
		? {
				name: `direct-${directAgent.name}`,
				description: `Direct subagent run for ${directAgent.name}`,
				source: "builtin" as const,
				filePath: "<generated>",
				roles: [
					{
						name: params.role ?? "agent",
						agent: directAgent.name,
						description: directAgent.description,
					},
				],
				defaultWorkflow: "direct-agent",
				workspaceMode: params.workspaceMode,
			}
		: teams.find((item) => item.name === teamName);
	if (!team) return result(`Team '${teamName}' not found.`, { action: "run", status: "error" }, true);
	const workflowName = directAgent ? "direct-agent" : (params.workflow ?? team.defaultWorkflow ?? "default");
	const baseWorkflow = directAgent
		? {
				name: "direct-agent",
				description: `Direct task for ${directAgent.name}`,
				source: "builtin" as const,
				filePath: "<generated>",
				steps: [
					{
						id: "01_agent",
						role: params.role ?? "agent",
						task: "{goal}",
						model: params.model,
						reads: params.analysis || params.analysisPath ? ["analysis.md"] : undefined,
					},
				],
			}
		: workflows.find((item) => item.name === workflowName);
	if (!baseWorkflow) return result(`Workflow '${workflowName}' not found.`, { action: "run", status: "error" }, true);

	// ANALYSIS CHANNEL (round-X Y1): resolve analysis text from inline or file BEFORE
	// createRunManifest so validation errors fail-fast (no orphan run state).
	const analysisParam = resolveAnalysisText(params, resolvedCtx.cwd);
	if (analysisParam.error) return result(analysisParam.error, { action: "run", status: "error" }, true);

	// LAZY: dodge the jiti ESM/CJS interop TDZ race on the static `import { expandParallelResearchWorkflow }` above (issue #28, RFC 17). At call time the module body has fully evaluated, so the dynamic import returns a live binding. Multi-line form breaks scripts/check-lazy-imports.mjs (which does `lines[lineNum - 2]`), so keep destructuring + await import on one line.
	const { expandParallelResearchWorkflow: expandParallelResearch } = await import("../../runtime/parallel-research.ts");
	const workflow = directAgent ? baseWorkflow : expandParallelResearch(baseWorkflow, resolvedCtx.cwd);
	const isDynamicWorkflow =
		!directAgent && (workflow as import("../../workflows/workflow-config.ts").WorkflowConfig).runtime === "dynamic";
	const effectiveRunKind = isDynamicWorkflow ? params.runKind : undefined;
	if (params.runKind !== undefined && !isDynamicWorkflow) {
		logInternalError(
			"team-tool.run.runKindIgnored",
			new Error(`Ignoring runKind='${params.runKind}' because workflow '${workflow.name}' is not dynamic.`),
			undefined,
			"warn",
		);
	}

	// PREFLIGHT (advisory only, since v0.9.15): classify workflow topology and emit
	// informational notes per the rule in .crew/knowledge.md "pi-crew USAGE THRESHOLD
	// RULE". Never blocks execution — the agent (caller) decides whether to proceed,
	// refactor, or override. This honors Pi's design philosophy: tooling provides
	// information, agents exercise judgment.
	// Skip for direct-agent runs (they bypass the workflow system entirely).
	if (!directAgent) {
		// LAZY: defer preflight-validator import until a team run actually requests it.
		const { validateWorkflowUsage } = await import("../../workflows/preflight-validator.ts");
		const preflight = validateWorkflowUsage(workflow, {
			force: params.force === true,
		});
		const icon = preflight.level === "warn" ? "⚠️ " : preflight.level === "note" ? "ℹ️  " : "";
		const tag = preflight.level.toUpperCase();
		console.warn(`${icon}[team-tool.preflight] ${tag}: ${preflight.message} (workflow=${workflow.name})`);
		if (preflight.suggestion) {
			console.warn(`[team-tool.preflight] → ${preflight.suggestion}`);
		}
	}

	// RFC v0.5 vision: goal-wrap. If .crew/config.json has goalWrap[workflow.name].enabled=true,
	// route to a goal loop where this workflow runs as the worker turn (judge → feedback → redo
	// until achieved). Only for eligible builtins (implementation, fast-fix, default). Per-workflow
	// toggle; OFF by default. See goal-wrap.ts.
	//
	// SAFETY (commit b57bad3): multi-step workflows crash non-deterministically
	// in the background goal-loop process (V8/libuv race in team-runner batch
	// transition). When goal-wrap is unsafe for this workflow, we do NOT error
	// out — we fall through to the normal team-run path so the user still gets
	// the run they asked for. The disabled reason is logged for traceability.
	if (!directAgent && workflow.source === "builtin" && isGoalWrapEnabled(resolvedCtx.cwd, workflow.name)) {
		const decision = shouldGoalWrap(resolvedCtx.cwd, workflow);
		if (decision.enabled) {
			if (analysisParam.text) {
				console.warn(
					`[team-tool.run] analysis param is ignored by goal-wrapped run (workflow=${workflow.name}). The analysis artifact will not be written.`,
				);
			}
			return await startGoalWrappedRun(params, ctx, workflow, goal);
		}
		// goal-wrap disabled for this workflow — fall through silently to normal
		// team-run path. Log the reason so it's discoverable in events.jsonl and
		// debug logs. This preserves the trace of WHY goal-wrap was bypassed for
		// a given run (vs. just disappearing without explanation).
		if (decision.message) {
			logInternalError(
				"team-tool.run.goalWrapBypassed",
				new Error(decision.message),
				`workflow=${workflow.name} reason=${decision.reason}`,
			);
		}
	}

	// LAZY: dodge the jiti ESM/CJS interop TDZ race on the static `import { validateWorkflowForTeam }` above (issue #28, RFC 17).
	const { validateWorkflowForTeam: validateWorkflow } = await import("../../workflows/validate-workflow.ts");
	const validationErrors = validateWorkflow(workflow, team);
	if (validationErrors.length > 0) {
		return result(
			[`Workflow '${workflow.name}' is not valid for team '${team.name}':`, ...validationErrors.map((error) => `- ${error}`)].join(
				"\n",
			),
			{ action: "run", status: "error" },
			true,
		);
	}

	// LAZY: dodge the jiti ESM/CJS interop TDZ race on the static `import { normalizeSkillOverride }` above (issue #28, RFC 17).
	const { normalizeSkillOverride: normalizeSkill } = await import("../../runtime/skill-instructions.ts");
	const skillOverride = normalizeSkill(params.skill);
	const { manifest, tasks, paths } = createRunManifest({
		cwd: resolvedCtx.cwd,
		team,
		workflow,
		goal,
		workspaceMode: params.workspaceMode,
		ownerSessionId: ctx.sessionId,
		runKind: effectiveRunKind,
		args: params.args,
	});
	const goalArtifact = writeArtifact(paths.artifactsRoot, {
		kind: "prompt",
		relativePath: "goal.md",
		content: `${goal}\n`,
		producer: "team-tool",
	});
	// ANALYSIS CHANNEL (round-X Y1): if analysis was provided, persist as a shared artifact
	// so workflow steps declaring reads: analysis.md receive it via the standard
	// dependency-context injection (collectDependencyOutputContext → renderDependencyOutputContext).
	const analysisArtifacts = analysisParam.text
		? [
				writeArtifact(paths.artifactsRoot, {
					kind: "prompt",
					relativePath: "shared/analysis.md",
					content: `${analysisParam.text}\n`,
					producer: "team-tool",
				}),
			]
		: [];
	const updatedManifest = {
		...manifest,
		...(skillOverride !== undefined ? { skillOverride } : {}),
		artifacts: [goalArtifact, ...analysisArtifacts],
		summary: "Run manifest created; worker execution is not implemented yet.",
	};
	atomicWriteJson(paths.manifestPath, updatedManifest);
	registerActiveRun(updatedManifest);

	// P2: dynamic-workflow dispatch — when the resolved workflow is a .dwf.ts (runtime:"dynamic"),
	// run it via runDynamicWorkflow instead of the static executeTeamRun path. The script
	// orchestrates subagents via ctx.agent(); only ctx.setResult() reaches the main context.
	// Placed AFTER manifest creation so runId/paths/artifactsRoot are available.
	if (isDynamicWorkflow) {
		console.warn(
			`[pi-crew SECURITY] Dynamic workflow '${workflow.name}' executes as trusted Node.js code with full process/require/import access; run only reviewed .dwf.ts files.`,
		);
		// LAZY: defer dynamic import of ../../runtime/dynamic-workflow-runner.ts to its call site.
		const { runDynamicWorkflow } = await import("../../runtime/dynamic-workflow-runner.ts");
		// Re-synthesize a dynamic-team (§0c C9) for role resolution.
		const dwfTeam: import("../../teams/team-config.ts").TeamConfig = {
			name: `dwf-${manifest.runId.slice(-12)}`,
			description: `Dynamic workflow run for ${workflow.name}`,
			source: "dynamic",
			filePath: "<dynamic-workflow>",
			roles: [{ name: "worker", agent: params.agent ?? "executor" }],
			workspaceMode: "single",
		};
		const dwfManifest: import("../../state/types.ts").TeamRunManifest = {
			...updatedManifest,
			runKind: "dynamic-workflow",
			team: dwfTeam.name,
		};
		atomicWriteJson(paths.manifestPath, dwfManifest);
		try {
			let dwfResult: import("../../runtime/dynamic-workflow-runner.ts").RunDynamicWorkflowResult | undefined;
			try {
				dwfResult = await runDynamicWorkflow({
					manifest: dwfManifest,
					workflow: workflow as import("../../workflows/workflow-config.ts").DynamicWorkflowConfig,
					team: dwfTeam,
					signal: ctx.signal ?? AbortSignal.timeout(3_600_000),
					modelOverride: params.model,
					tokenBudget:
						params.tokenBudget ??
						(workflow as import("../../workflows/workflow-config.ts").DynamicWorkflowConfig).maxTokenBudget,
				});
			} catch (runnerError) {
				// Round-11 runtime fix: persist manifest with status=failed when runner throws
				// (e.g., script timeout, script syntax error, async failure). Previously the
				// manifest stayed at 'queued' indefinitely, leaving an orphan state file.
				const failureReason = runnerError instanceof Error ? runnerError.message : String(runnerError);
				const failedManifest = {
					...dwfManifest,
					status: "failed" as const,
					summary: `Dynamic workflow '${workflow.name}' failed: ${failureReason}`.slice(0, 2000),
					updatedAt: new Date().toISOString(),
				};
				atomicWriteJson(paths.manifestPath, failedManifest);
				return result(
					`Dynamic workflow '${workflow.name}' failed: ${failureReason}`,
					{
						action: "run",
						status: "error",
						runId: failedManifest.runId,
						artifactsRoot: failedManifest.artifactsRoot,
					},
					true,
				);
			}
			// Round-10 runtime-test fix: persist the updated manifest with status=completed
			// so status queries / cancel / cleanup see the real state. Previously run.ts
			// returned the result without atomicWriteJson, leaving manifest at 'queued' forever.
			atomicWriteJson(paths.manifestPath, dwfResult.manifest);
			return result(
				`Dynamic workflow '${workflow.name}' completed.\n${dwfResult.manifest.summary ?? ""}`,
				{
					action: "run",
					status: dwfResult.manifest.status === "failed" ? "error" : "ok",
					runId: dwfResult.manifest.runId,
					artifactsRoot: dwfResult.manifest.artifactsRoot,
				},
				dwfResult.manifest.status === "failed",
			);
		} finally {
			unregisterActiveRun(dwfManifest.runId);
		}
	}

	const loadedConfig = loadConfig(resolvedCtx.cwd);
	// DX (Round 16 F4): surface config errors/warnings instead of silently
	// proceeding with defaults. Non-blocking: emit a config.warning event so
	// it shows in the run timeline and status, and log it. A malformed config
	// (bad JSON / wrong types) should not be a silent no-op — doctor/config
	// actions already surface these; run should too.
	const configIssues = [...(loadedConfig.error ? [`Config error: ${loadedConfig.error}`] : []), ...(loadedConfig.warnings ?? [])];
	if (configIssues.length > 0) {
		void appendEventAsync(updatedManifest.eventsPath, {
			type: "config.warning",
			runId: updatedManifest.runId,
			message: `Loaded config from ${loadedConfig.path || "(defaults)"} with ${configIssues.length} issue(s): ${configIssues.join("; ")}`,
			data: {
				error: loadedConfig.error,
				warnings: loadedConfig.warnings,
				path: loadedConfig.path,
			},
		}).catch((error) => logInternalError("team-tool.run.configWarning", error, `runId=${updatedManifest.runId}`));
		logInternalError(
			"team-tool.run.configWarning",
			new Error(`config issues: ${configIssues.join("; ")}`),
			`runId=${updatedManifest.runId} path=${loadedConfig.path ?? "(defaults)"}`,
		);
	}
	const executedConfig = effectiveRunConfig(loadedConfig.config, params.config);
	const runtime = await resolveCrewRuntime(executedConfig);
	const runtimeResolution = runtimeResolutionState(runtime);
	// DEBUG: log what we received (gated to avoid stdout pollution in production)
	if (process.env.PI_CREW_DEBUG_BUDGET === "1") {
		console.log(
			"[DEBUG budget] params keys:",
			Object.keys(params),
			"budgetTotal:",
			params.budgetTotal,
			"budgetWarning:",
			params.budgetWarning,
			"budgetAbort:",
			params.budgetAbort,
		);
	}
	const executionManifest = {
		...updatedManifest,
		runtimeResolution,
		runConfig: executedConfig,
		// Persist budget config on the manifest so it's observable post-run
		// (events.jsonl, status reads, audits). The team-runner reads these
		// from the input, but persisting them means consumers can verify
		// enforcement was armed without re-parsing the original call params.
		...(params.budgetTotal !== undefined ? { budgetTotal: params.budgetTotal } : {}),
		...(params.budgetWarning !== undefined ? { budgetWarning: params.budgetWarning } : {}),
		...(params.budgetAbort !== undefined ? { budgetAbort: params.budgetAbort } : {}),
		...(params.budgetUnlimited !== undefined ? { budgetUnlimited: params.budgetUnlimited } : {}),
		updatedAt: new Date().toISOString(),
	};
	atomicWriteJson(paths.manifestPath, executionManifest);
	appendEventAsync(executionManifest.eventsPath, {
		type: "runtime.resolved",
		runId: executionManifest.runId,
		message: `Runtime resolved: ${runtime.kind} safety=${runtime.safety}`,
		data: { runtimeResolution },
	}).catch((error) => logInternalError("team-tool.run.resolved", error, `runId=${executionManifest.runId}`));
	const runAsync = params.async ?? executedConfig.asyncByDefault ?? false;
	let effectiveRuntime = runtime;
	if (runAsync && runtime.kind === "live-session") {
		effectiveRuntime = {
			...runtime,
			kind: "child-process",
			steer: true,
			resume: false,
			liveToolActivity: false,
			fallback: "child-process",
			reason: "Background runner cannot use live-session; falling back to child-process.",
		};
	}
	const effectiveRuntimeResolution = effectiveRuntime !== runtime ? runtimeResolutionState(effectiveRuntime) : runtimeResolution;
	const effectiveManifest =
		effectiveRuntime !== runtime
			? {
					...executionManifest,
					runtimeResolution: effectiveRuntimeResolution,
					updatedAt: new Date().toISOString(),
				}
			: executionManifest;
	if (effectiveRuntime !== runtime) {
		atomicWriteJson(paths.manifestPath, effectiveManifest);
		appendEventAsync(effectiveManifest.eventsPath, {
			type: "runtime.resolved",
			runId: effectiveManifest.runId,
			message: `Runtime overridden: child-process (async fallback from live-session)`,
			data: { runtimeResolution: effectiveRuntimeResolution },
		}).catch((error) => logInternalError("team-tool.run.override", error, `runId=${effectiveManifest.runId}`));
	}
	if (runAsync) {
		if (effectiveRuntime.safety === "blocked") {
			const runningManifest = updateRunStatus(effectiveManifest, "running", "Checking worker runtime availability.");
			const blocked = updateRunStatus(
				runningManifest,
				"blocked",
				effectiveRuntime.reason ?? "Child worker execution is disabled; refusing to create no-op scaffold subagents.",
			);
			void appendEventAsync(blocked.eventsPath, {
				type: "run.blocked",
				runId: blocked.runId,
				message: blocked.summary,
				data: {
					runtime: effectiveRuntime,
					runtimeResolution: effectiveRuntimeResolution,
					async: true,
					diagnostics: {
						requestedMode: effectiveRuntime.requestedMode,
						workersDisabled: executedConfig.executeWorkers === false,
						envCrew: process.env.PI_CREW_EXECUTE_WORKERS,
						envTeams: process.env.PI_TEAMS_EXECUTE_WORKERS,
					},
				},
			});
			unregisterActiveRun(blocked.runId);
			return result(
				[
					`Blocked pi-crew run ${blocked.runId}: real subagent workers are disabled.`,
					`Runtime: ${effectiveRuntime.kind} (requested ${effectiveRuntime.requestedMode})`,
					`Reason: ${effectiveRuntime.reason ?? "unknown"}`,
					`Config: executeWorkers=${executedConfig.executeWorkers ?? "<default>"}, runtime.mode=${executedConfig.runtime?.mode ?? "<default>"}`,
					`Env: PI_CREW_EXECUTE_WORKERS=${process.env.PI_CREW_EXECUTE_WORKERS ?? "<unset>"}, PI_TEAMS_EXECUTE_WORKERS=${process.env.PI_TEAMS_EXECUTE_WORKERS ?? "<unset>"}`,
				].join("\n"),
				{
					action: "run",
					status: "error",
					runId: blocked.runId,
					artifactsRoot: blocked.artifactsRoot,
				},
				true,
			);
		}
		const spawned = await spawnBackgroundTeamRun(effectiveManifest);
		const asyncManifest = {
			...effectiveManifest,
			async: {
				pid: spawned.pid,
				logPath: spawned.logPath,
				spawnedAt: new Date().toISOString(),
			},
		};
		atomicWriteJson(paths.manifestPath, asyncManifest);
		void appendEventAsync(effectiveManifest.eventsPath, {
			type: "async.spawned",
			runId: effectiveManifest.runId,
			data: { pid: spawned.pid, logPath: spawned.logPath },
		});
		ctx.onRunStarted?.(effectiveManifest.runId);
		scheduleBackgroundEarlyExitGuard(resolvedCtx.cwd, effectiveManifest.runId, spawned.pid, spawned.logPath);
		// Wait for the async run to complete and return actual results.
		try {
			const completed = await waitForRun(updatedManifest.runId, resolvedCtx.cwd, { timeoutMs: 3600000 });
			return formatRunResult(completed.manifest, {
				tasks: completed.tasks,
				metrics: collectRunMetrics(resolvedCtx.cwd, completed.manifest.runId),
				goal,
				team: team.name,
				workflow: workflow.name,
				workspaceId: ctx.sessionId ?? ctx.cwd,
			});
		} catch (waitError: unknown) {
			const errorMessage = waitError instanceof Error ? waitError.message : String(waitError);
			return result(
				[
					`pi-crew run timed out or failed: ${updatedManifest.runId}`,
					`Team: ${team.name}`,
					`Workflow: ${workflow.name}`,
					`Error: ${errorMessage}`,
					"",
					`Check status with: team status runId=${updatedManifest.runId}`,
					`State: ${updatedManifest.stateRoot}`,
					`Background log: ${spawned.logPath}`,
				].join("\n"),
				{
					action: "run",
					status: "error",
					runId: updatedManifest.runId,
					artifactsRoot: updatedManifest.artifactsRoot,
				},
				true,
			);
		}
	}

	if (runtime.safety === "blocked") {
		const runningManifest = updateRunStatus(executionManifest, "running", "Checking worker runtime availability.");
		const blocked = updateRunStatus(
			runningManifest,
			"blocked",
			runtime.reason ?? "Child worker execution is disabled; refusing to create no-op scaffold subagents.",
		);
		void appendEventAsync(blocked.eventsPath, {
			type: "run.blocked",
			runId: blocked.runId,
			message: blocked.summary,
			data: {
				runtime,
				runtimeResolution,
				diagnostics: {
					requestedMode: runtime.requestedMode,
					workersDisabled: executedConfig.executeWorkers === false,
					envCrew: process.env.PI_CREW_EXECUTE_WORKERS,
					envTeams: process.env.PI_TEAMS_EXECUTE_WORKERS,
				},
			},
		});
		unregisterActiveRun(blocked.runId);
		return result(
			[
				`Blocked pi-crew run ${blocked.runId}: real subagent workers are disabled.`,
				`Runtime: ${runtime.kind} (requested ${runtime.requestedMode})`,
				`Reason: ${runtime.reason ?? "unknown"}`,
				`Config: executeWorkers=${executedConfig.executeWorkers ?? "<default>"}, runtime.mode=${executedConfig.runtime?.mode ?? "<default>"}`,
				`Env: PI_CREW_EXECUTE_WORKERS=${process.env.PI_CREW_EXECUTE_WORKERS ?? "<unset>"}, PI_TEAMS_EXECUTE_WORKERS=${process.env.PI_TEAMS_EXECUTE_WORKERS ?? "<unset>"}`,
				"",
				"To run effective subagents, remove executeWorkers=false / PI_CREW_EXECUTE_WORKERS=0 / PI_TEAMS_EXECUTE_WORKERS=0 or set runtime.mode=child-process.",
				"Use runtime.mode=scaffold only for explicit dry-run prompt/artifact generation.",
			].join("\n"),
			{
				action: "run",
				status: "error",
				runId: blocked.runId,
				artifactsRoot: blocked.artifactsRoot,
			},
			true,
		);
	}
	const executeWorkers = runtime.kind !== "scaffold";
	if (executeWorkers && ctx.startForegroundRun) {
		ctx.onRunStarted?.(updatedManifest.runId);
		ctx.startForegroundRun(async (signal) => {
			try {
				await executeTeamRun({
					manifest: executionManifest,
					tasks,
					team,
					workflow,
					agents,
					executeWorkers,
					limits: executedConfig.limits,
					runtime,
					runtimeConfig: executedConfig.runtime,
					parentContext: buildParentContext(ctx),

					parentModel: ctx.model,
					modelRegistry: ctx.modelRegistry,
					modelOverride: params.model,
					skillOverride,
					signal,
					reliability: executedConfig.reliability,
					metricRegistry: ctx.metricRegistry,
					onJsonEvent: ctx.onJsonEvent,
					workspaceId: ctx.sessionId ?? ctx.cwd,
					budgetTotal: params.budgetTotal,
					budgetWarning: params.budgetWarning,
					budgetAbort: params.budgetAbort,
					budgetUnlimited: params.budgetUnlimited,
				});
			} finally {
				unregisterActiveRun(updatedManifest.runId);
			}
		}, updatedManifest.runId);

		// Wait for the foreground run to complete and return actual results.
		try {
			const completed = await waitForRun(updatedManifest.runId, resolvedCtx.cwd, { timeoutMs: 3600000 });
			return formatRunResult(completed.manifest, {
				tasks: completed.tasks,
				metrics: collectRunMetrics(resolvedCtx.cwd, completed.manifest.runId),
				goal,
				team: team.name,
				workflow: workflow.name,
				workspaceId: ctx.sessionId ?? ctx.cwd,
			});
		} catch (waitError: unknown) {
			const errorMessage = waitError instanceof Error ? waitError.message : String(waitError);
			return result(
				[
					`pi-crew run timed out or failed: ${updatedManifest.runId}`,
					`Team: ${team.name}`,
					`Workflow: ${workflow.name}`,
					`Error: ${errorMessage}`,
					"",
					`Check status with: team status runId=${updatedManifest.runId}`,
					`State: ${updatedManifest.stateRoot}`,
				].join("\n"),
				{
					action: "run",
					status: "error",
					runId: updatedManifest.runId,
					artifactsRoot: updatedManifest.artifactsRoot,
				},
				true,
			);
		}
	}
	let executed: Awaited<ReturnType<typeof executeTeamRun>>;
	try {
		executed = await executeTeamRun({
			manifest: executionManifest,
			tasks,
			team,
			workflow,
			agents,
			executeWorkers,
			limits: executedConfig.limits,
			runtime,
			runtimeConfig: executedConfig.runtime,
			parentContext: buildParentContext(ctx),
			parentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			modelOverride: params.model,
			skillOverride,
			signal: ctx.signal,
			reliability: executedConfig.reliability,
			metricRegistry: ctx.metricRegistry,
			onJsonEvent: ctx.onJsonEvent,
			workspaceId: ctx.cwd,
			budgetTotal: params.budgetTotal,
			budgetWarning: params.budgetWarning,
			budgetAbort: params.budgetAbort,
			budgetUnlimited: params.budgetUnlimited,
		});
	} finally {
		unregisterActiveRun(updatedManifest.runId);
	}
	return formatRunResult(executed.manifest, {
		tasks: executed.tasks,
		metrics: collectRunMetrics(resolvedCtx.cwd, executed.manifest.runId),
		goal,
		team: team.name,
		workflow: workflow.name,
		workspaceId: ctx.cwd,
		runtime: runtimeResolutionState(runtime),
		mode: "scaffold",
	});
}
