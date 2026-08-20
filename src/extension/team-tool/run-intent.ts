/**
 * Run-intent validation phase (H3 phase 4).
 *
 * Extracted from `handleRun` (src/extension/team-tool/run.ts) on 2026-08-10.
 * Validates the tool params → resolved team/workflow/agent + goal + analysis,
 * returning either a validated `RunIntent` (for materialization) or an error
 * result. Behaviour is byte-identical to the inline block it replaces —
 * including the exact error-precedence order the run tests assert on.
 *
 * The chain dispatch stays in `handleRun` because it recurses via a lazy
 * injected handleRun reference (run.ts ↔ chain-dispatch.ts import cycle).
 */

import * as fs from "node:fs";
import { allAgents, discoverAgents } from "../../agents/discover-agents.ts";
import { loadConfig } from "../../config/config.ts";
import { sanitizeTaskText } from "../../runtime/task-packet.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { loadSpecRecord } from "../../state/stores/spec-store.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import type { TeamConfig } from "../../teams/team-config.ts";
import { errorMessage } from "../../utils/guards.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import type { WorkflowConfig } from "../../workflows/workflow-config.ts";

/** T4/R6 (ADR-6 §5 + round-1): reject-start reason for strict usage —
 *  exported for tests. undefined = start allowed. Covers: workflow-level OR
 *  step-level specStrict without a verifier-role step (per-step flags bypass
 *  the same no-silent-self-certification rule), DWF (structurally verifier-
 *  less in v0.10.x), and — when cwd is provided — declared specRefs that
 *  resolve to nothing at start (fail-closed freeze, round-1 P2). */
export function specStrictRejectReason(workflow: WorkflowConfig, cwd?: string): string | undefined {
	const strict = workflow.specStrict === true || workflow.steps.some((s) => s.specStrict === true);
	if (!strict) return undefined;
	if (workflow.runtime === "dynamic") {
		return `Workflow '${workflow.name}' uses specStrict, but dynamic workflows do not support strict spec mode in v0.10.x (ctx.agent() tasks have no verifier-role gate). Drop specStrict for DWF runs (ADR-6 erratum §11).`;
	}
	if (!workflow.steps.some((s) => s.role === "verifier")) {
		return `Workflow '${workflow.name}' enables specStrict (workflow or step level) but has no verifier-role step — strict mode requires independent verification (ADR-6 §5). Add a verifier step or drop specStrict.`;
	}
	if (cwd) {
		// Round-1 P2: fail-closed at START — a strict step whose specRefs resolve
		// to nothing would otherwise silently degrade to ungated at dispatch.
		const declared = [...(workflow.specStrict === true ? workflow.steps : workflow.steps.filter((s) => s.specStrict === true))]
			.flatMap((s) => s.specRefs ?? [])
			.map((id) => ({ id, resolved: loadSpecRecord(cwd, id) !== undefined }))
			.filter((x) => !x.resolved);
		if (declared.length > 0) {
			return `Workflow '${workflow.name}' is strict but these specRefs resolve to nothing in state/specs (typo, not imported, or corrupted): ${declared
				.map((x) => x.id)
				.join(", ")}. Import them first (scripts/spec-import.mjs) or fix the refs (ADR-6 erratum §11).`;
		}
	}
	return undefined;
}

import { assertCleanLeaderAsync, findGitRootAsync } from "../../worktree/worktree-manager.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import type { TeamContext } from "./context.ts";
import { result } from "./context.ts";
import { isGoalWrapEnabled, shouldGoalWrap, startGoalWrappedRun } from "./goal-wrap.ts";
import { paramRequired } from "./param-error.ts";

/** Cap for inline/path analysis content (mirrors the schema maxLength). */
const MAX_ANALYSIS_BYTES = 100_000;

/**
 * Module-scoped latch for the crew-init dynamic import (moved verbatim from
 * run.ts — see the comment there for the jiti TDZ race it guards).
 */
var crewInitPromise: Promise<typeof import("../../state/crew-init.ts")> | undefined;
function loadCrewInit(): Promise<typeof import("../../state/crew-init.ts")> {
	if (!crewInitPromise) {
		crewInitPromise = import("../../state/crew-init.ts");
	}
	return crewInitPromise;
}

/**
 * Resolve analysis text from inline or file. Mutual exclusivity mirrors the
 * `budgetTotal`/`budgetUnlimited` pattern (cold-review #2 blocking fix).
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
			resolved = resolveRealContainedPath(cwd, params.analysisPath as string);
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

/** The validated run intent produced by {@link validateRunIntent}. */
export interface RunIntent {
	goal: string;
	intentPrefix: string;
	/** cwd after the git-root auto-correction for worktree mode. */
	resolvedCtx: TeamContext;
	directAgent: boolean;
	team: TeamConfig;
	workflow: WorkflowConfig;
	/** All discovered agents (needed by the execution phase for executeTeamRun). */
	agents: ReturnType<typeof allAgents>;
	analysisParam: { text?: string; error?: string; source: "inline" | "path" | "none" };
	isDynamicWorkflow: boolean;
	/** params.runKind only when the workflow is dynamic (else undefined). */
	effectiveRunKind: TeamToolParamsValue["runKind"];
	/** normalizeSkillOverride result — matches TeamRunManifest.skillOverride. */
	skillOverride: false | string[] | undefined;
}

/**
 * Validate the run params into a {@link RunIntent}.
 *
 * Error-precedence order (asserted by run tests, do not reorder):
 * goal/params → crew-init → worktree precondition → agent → team →
 * workflow → analysis → workflow-validation. Non-validation branches
 * (chain dispatch, goal-wrap delegation) are handled inside.
 */
export async function validateRunIntent(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<{ kind: "ok"; intent: RunIntent } | { kind: "error"; result: PiTeamsToolResult }> {
	const goal = params.goal ?? params.task;
	if (!goal)
		return {
			kind: "error",
			result: result(
				paramRequired("run", "goal or task", "{ action: 'run', goal: '<what to achieve>' }"),
				{ action: "run", status: "error" },
				true,
			),
		};
	const intentPrefix = goal.length > 60 ? `${goal.slice(0, 57)}...` : goal;

	// P0: Ensure .crew directory structure exists before creating any manifests.
	// Latch shared across concurrent `team` tool calls (see loadCrewInit).
	const workingDir = ctx.cwd ?? process.cwd();
	const { ensureCrewDirectory } = await loadCrewInit();
	await ensureCrewDirectory(workingDir);

	// WORKTREE FIX: If worktree mode is needed but cwd is not a git repo,
	// auto-correct to the nearest git repo root.
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
	// BEFORE creating the run manifest.
	if (params.workspaceMode === "worktree") {
		let gitRoot: string | undefined;
		try {
			gitRoot = await findGitRootAsync(resolvedCtx.cwd);
		} catch {
			// not a git repo
		}
		if (!gitRoot) {
			return {
				kind: "error",
				result: result(
					`Worktree mode requires a git repository. '${resolvedCtx.cwd}' is not inside a git repo.\nUse workspaceMode: 'single' or run from a git repository.`,
					{ action: "run", status: "error" },
					true,
				),
			};
		}
		// Check if clean leader is required (can be disabled via config)
		const preCheckConfig = loadConfig(resolvedCtx.cwd);
		if (preCheckConfig.config.requireCleanWorktreeLeader !== false) {
			try {
				await assertCleanLeaderAsync(gitRoot);
			} catch (err) {
				const msg = errorMessage(err);
				return {
					kind: "error",
					result: result(
						`${msg}\nCommit or stash changes before using worktree mode, or use workspaceMode: 'single'.`,
						{ action: "run", status: "error" },
						true,
					),
				};
			}
		}
	}

	const teams = allTeams(discoverTeams(resolvedCtx.cwd));
	const workflows = allWorkflows(discoverWorkflows(resolvedCtx.cwd));
	const agents = allAgents(discoverAgents(resolvedCtx.cwd));
	const directAgent = params.agent ? agents.find((item) => item.name === params.agent) : undefined;
	if (params.agent && !directAgent)
		return { kind: "error", result: result(`Agent '${params.agent}' not found.`, { action: "run", status: "error" }, true) };
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
	if (!team) return { kind: "error", result: result(`Team '${teamName}' not found.`, { action: "run", status: "error" }, true) };
	// BUG-44 (github #44): `chain` is a dispatcher-only workflow — see the
	// comment in run.ts; chain steps forwarding params.workflow fall back to
	// the team's default workflow.
	const workflowName = directAgent
		? "direct-agent"
		: params.workflow === "chain" && !params.chain
			? (team.defaultWorkflow ?? "default")
			: (params.workflow ?? team.defaultWorkflow ?? "default");
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
	if (!baseWorkflow)
		return { kind: "error", result: result(`Workflow '${workflowName}' not found.`, { action: "run", status: "error" }, true) };

	// ANALYSIS CHANNEL (round-X Y1): resolve analysis text BEFORE
	// createRunManifest so validation errors fail-fast (no orphan run state).
	const analysisParam = resolveAnalysisText(params, resolvedCtx.cwd);
	if (analysisParam.error) return { kind: "error", result: result(analysisParam.error, { action: "run", status: "error" }, true) };

	// LAZY: dodge the jiti ESM/CJS interop TDZ race on the static `import { expandParallelResearchWorkflow }` (issue #28, RFC 17). Multi-line form breaks scripts/check-lazy-imports.mjs.
	const { expandParallelResearchWorkflow: expandParallelResearch } = await import("../../runtime/scheduling/parallel-research.ts");
	const workflow = directAgent ? baseWorkflow : expandParallelResearch(baseWorkflow, resolvedCtx.cwd);
	const isDynamicWorkflow =
		!directAgent && (workflow as import("../../workflows/workflow-config.ts").WorkflowConfig).runtime === "dynamic";
	if (params.runKind !== undefined && !isDynamicWorkflow) {
		logInternalError(
			"team-tool.run.runKindIgnored",
			new Error(`Ignoring runKind='${params.runKind}' because workflow '${workflow.name}' is not dynamic.`),
			undefined,
			"warn",
		);
	}

	// T4/R6 (ADR-6 §5): REJECT-START — a strict-mode workflow without a
	// verifier-role step fails at start (no silent self-certification).
	// Non-strict workflows are unaffected.
	const rejectReason = !directAgent ? specStrictRejectReason(workflow, resolvedCtx.cwd) : undefined;
	if (rejectReason) {
		return {
			kind: "error",
			result: result(rejectReason, { action: "run", status: "error" }, true),
		};
	}
	// Platform honesty (ADR §4): loud warning — NOT best-effort. Where the
	// re-run sandbox is unavailable every strict check fails closed.
	if (!directAgent && workflow.specStrict === true && process.platform !== "linux") {
		console.warn(
			`⚠️  [team-tool.run] specStrict is enabled but this platform (${process.platform}) has no unshare -rn equivalent: every strict machine-check will FAIL CLOSED (ADR-6 §4).`,
		);
	}

	// WP-8 (R8): model-routing transparency — one pre-run line: resolved
	// chain + worst-case spawns/task (attemptModels × (maxAttempts+1)).
	if (!directAgent) {
		try {
			// LAZY: defer the routing-pipeline import to run start.
			const { summarizeModelBudget } = await import("../../runtime/model/model-budget-summary.ts");
			console.warn(summarizeModelBudget(resolvedCtx.cwd).line);
		} catch {
			/* advisory only — never block a run on the summary */
		}
	}

	// PREFLIGHT (advisory only, since v0.9.15) — informational notes per the
	// rule in .crew/knowledge.md "pi-crew USAGE THRESHOLD RULE". Never blocks.
	if (!directAgent) {
		// LAZY: defer preflight-validator import until a team run requests it.
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

	// RFC v0.5 vision: goal-wrap. If .crew/config.json has
	// goalWrap[workflow.name].enabled=true, route to a goal loop where this
	// workflow runs as the worker turn. Only for eligible builtins. When
	// goal-wrap is unsafe for this workflow we fall through (never block the
	// run the user asked for).
	if (!directAgent && workflow.source === "builtin" && isGoalWrapEnabled(resolvedCtx.cwd, workflow.name)) {
		const decision = shouldGoalWrap(resolvedCtx.cwd, workflow);
		if (decision.enabled) {
			if (analysisParam.text) {
				console.warn(
					`[team-tool.run] analysis param is ignored by goal-wrapped run (workflow=${workflow.name}). The analysis artifact will not be written.`,
				);
			}
			return {
				kind: "error",
				result: await startGoalWrappedRun(params, ctx, workflow, goal),
			};
		}
		if (decision.message) {
			logInternalError(
				"team-tool.run.goalWrapBypassed",
				new Error(decision.message),
				`workflow=${workflow.name} reason=${decision.reason}`,
			);
		}
	}

	// LAZY: dodge the jiti ESM/CJS interop TDZ race (issue #28, RFC 17).
	const { validateWorkflowForTeam: validateWorkflow } = await import("../../workflows/validate-workflow.ts");
	const validationErrors = validateWorkflow(workflow, team);
	if (validationErrors.length > 0) {
		return {
			kind: "error",
			result: result(
				[
					`Workflow '${workflow.name}' is not valid for team '${team.name}':`,
					...validationErrors.map((error) => `- ${error}`),
				].join("\n"),
				{ action: "run", status: "error" },
				true,
			),
		};
	}

	// LAZY: dodge the jiti ESM/CJS interop TDZ race (issue #28, RFC 17).
	const { normalizeSkillOverride: normalizeSkill } = await import("../../runtime/skill-instructions.ts");
	const skillOverride = normalizeSkill(params.skill);

	return {
		kind: "ok",
		intent: {
			goal,
			intentPrefix,
			resolvedCtx,
			directAgent: !!directAgent,
			team,
			workflow,
			agents,
			analysisParam,
			isDynamicWorkflow,
			effectiveRunKind: isDynamicWorkflow ? params.runKind : undefined,
			skillOverride,
		},
	};
}
