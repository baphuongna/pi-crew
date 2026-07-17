/**
 * Parallel dispatch handler — accepts an array of independent tasks
 * and spawns them as concurrent background agents.
 *
 * Solves the host-agent limitation of only being able to emit
 * one Agent() call per response turn. By calling `action=parallel`
 * once with multiple tasks, the system handles fanout automatically.
 */
import { discoverAgents } from "../../agents/discover-agents.ts";
import { loadConfig } from "../../config/config.ts";
import { resolveCrewRuntime } from "../../runtime/runtime-resolver.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { appendEvent } from "../../state/event-log.ts";
import { createRunManifest } from "../../state/state-store.ts";
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";
import { discoverTeams } from "../../teams/discover-teams.ts";
import type { TeamConfig } from "../../teams/team-config.ts";
import { discoverWorkflows } from "../../workflows/discover-workflows.ts";
import type { WorkflowConfig } from "../../workflows/workflow-config.ts";
import { resolveCwdOverride } from "../registration/team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TEAM = "fast-fix";
const DEFAULT_AGENT = "explorer";

export async function handleParallel(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const tasksParam = params.config?.tasks;
	if (!Array.isArray(tasksParam) || tasksParam.length === 0) {
		return result("parallel action requires config.tasks: [{goal, agent?}]", { action: "parallel", status: "error" }, true);
	}

	const concurrency = Math.min(Math.max(1, Math.floor((params.config?.concurrency as number) ?? DEFAULT_CONCURRENCY)), MAX_CONCURRENCY);

	const config = loadConfig(ctx.cwd);
	const agentsResult = discoverAgents(ctx.cwd);
	const allAgentsList = [...agentsResult.builtin, ...agentsResult.user, ...agentsResult.project];
	const teams = discoverTeams(ctx.cwd);
	const workflows = discoverWorkflows(ctx.cwd);

	const teamName = (params.config?.team as string) ?? DEFAULT_TEAM;
	const team =
		teams.builtin.find((t) => t.name === teamName) ??
		teams.user.find((t) => t.name === teamName) ??
		teams.project.find((t) => t.name === teamName);
	if (!team) {
		return result(`Team '${teamName}' not found`, { action: "parallel", status: "error" }, true);
	}

	// H2: Use team's defaultWorkflow, fall back to "fast-fix"
	const workflow = workflows.builtin.find((w) => w.name === team.defaultWorkflow) ?? workflows.builtin.find((w) => w.name === "fast-fix");
	if (!workflow) {
		return result("No suitable workflow found for parallel dispatch", { action: "parallel", status: "error" }, true);
	}

	const runtime = await resolveCrewRuntime(config.config);

	const launched: Array<{ runId: string; goal: string; agent: string }> = [];
	const errors: Array<{ goal: string; error: string }> = [];

	// C1: Enforce concurrency limit with batched spawning
	for (let batchStart = 0; batchStart < tasksParam.length; batchStart += concurrency) {
		const batch = tasksParam.slice(batchStart, batchStart + concurrency);
		const batchPromises = batch.map((task) => spawnSingleTask(task, ctx, allAgentsList, team, workflow, runtime));
		const batchResults = await Promise.allSettled(batchPromises);
		for (const res of batchResults) {
			if (res.status === "fulfilled" && res.value.ok) {
				launched.push(res.value.value);
			} else if (res.status === "fulfilled" && !res.value.ok) {
				errors.push(res.value.error);
			} else {
				const reason = (res as PromiseRejectedResult).reason;
				errors.push({
					goal: "(unknown)",
					error: reason instanceof Error ? reason.message : String(reason),
				});
			}
		}
	}

	const lines: string[] = [`Parallel dispatch: ${launched.length}/${tasksParam.length} tasks launched (concurrency: ${concurrency})`, ""];
	for (const l of launched) {
		lines.push(`  ✅ ${l.runId} — ${l.agent}: ${l.goal.slice(0, 80)}`);
	}
	for (const e of errors) {
		lines.push(`  ❌ ${e.goal.slice(0, 80)}: ${e.error}`);
	}

	return result(
		lines.join("\n"),
		{
			action: "parallel",
			status: errors.length === tasksParam.length ? "error" : "ok",
		},
		errors.length === tasksParam.length,
	);
}

type SpawnOk = {
	ok: true;
	value: { runId: string; goal: string; agent: string };
};
type SpawnErr = { ok: false; error: { goal: string; error: string } };
type SpawnResult = SpawnOk | SpawnErr;

async function spawnSingleTask(
	task: unknown,
	ctx: TeamContext,
	allAgentsList: Array<{ name: string }>,
	team: TeamConfig,
	workflow: WorkflowConfig,
	runtime: { available: boolean; kind: string },
): Promise<SpawnResult> {
	try {
		const taskRec = task as Record<string, unknown>;
		const goal = taskRec.goal as string;
		const agentName = (taskRec.agent as string) ?? DEFAULT_AGENT;
		const rawCwd = (taskRec.cwd as string) ?? undefined;

		if (!goal) {
			return {
				ok: false,
				error: {
					goal: "(missing)",
					error: "Each task must have a 'goal' field",
				},
			};
		}

		const agent = allAgentsList.find((a) => a.name === agentName);
		if (!agent) {
			return {
				ok: false,
				error: { goal, error: `Agent '${agentName}' not found` },
			};
		}

		// H1: Validate taskCwd containment against project root
		const cwdResult = resolveCwdOverride(ctx.cwd, rawCwd);
		if (!cwdResult.ok) {
			return { ok: false, error: { goal, error: cwdResult.error } };
		}
		const taskCwd = cwdResult.cwd;

		const created = createRunManifest({
			cwd: taskCwd,
			team,
			workflow,
			goal,
			// EXT F1: mirror handleRun — without ownerSessionId, the foreign-run check in
			// cancel/retry/resume (cancel.ts:50: `typeof ownerSessionId === "string"`) is
			// skipped and any session can cancel/retry parallel-dispatched runs.
			ownerSessionId: ctx.sessionId,
			runKind: "team-run",
		});

		appendEvent(created.manifest.eventsPath, {
			type: "run.started",
			runId: created.manifest.runId,
			message: `Parallel task: ${goal}`,
		});

		if (runtime.available && runtime.kind === "child-process") {
			await spawnBackgroundTeamRun(created.manifest);
		}

		return {
			ok: true,
			value: { runId: created.manifest.runId, goal, agent: agentName },
		};
	} catch (error) {
		const goal = ((task as Record<string, unknown>).goal as string) ?? "(unknown)";
		return {
			ok: false,
			error: {
				goal,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
}
