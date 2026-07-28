/**
 * API-5 facade dispatch — Run domain router.
 *
 * Actions: run, parallel, plan, orchestrate, resume, retry, wait, steer, goal.
 *
 * Handlers are already extracted into src/extension/team-tool/*.ts; this file
 * just routes the action labels. Local handlers (handleResume, handleSteer,
 * handleWait, cacheControlDepsFromContext) are imported from the parent
 * team-tool.ts module via ESM live bindings (circular import is safe — all
 * references are resolved at call time, not at module-init).
 */
import { handleRetry } from "../cancel.ts";
import { result, type TeamContext } from "../context.ts";
import { handleGoal } from "../goal.ts";
import { handleOrchestrate } from "../orchestrate.ts";
import { handleParallel } from "../parallel-dispatch.ts";
import { handlePlan } from "../plan.ts";
import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import {
	cacheControlDepsFromContext,
	handleResume,
	handleRun,
	handleSteer,
	handleWait,
} from "../../team-tool.ts";

export async function handleRunDomain(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<PiTeamsToolResult> {
	switch (params.action) {
		case "run":
			return handleRun(params, ctx);
		case "parallel":
			return handleParallel(params, ctx);
		case "plan":
			return handlePlan(params, ctx);
		case "orchestrate":
			return handleOrchestrate(params, ctx);
		case "resume":
			return handleResume(params, ctx);
		case "retry":
			return handleRetry(params, ctx, cacheControlDepsFromContext(ctx));
		case "wait":
			return handleWait(params, ctx);
		case "steer":
			return handleSteer(params, ctx);
		case "goal":
			return handleGoal(params, ctx);
		default:
			return result(`Unhandled run-domain action: ${params.action}`, {
				action: "unknown",
				status: "error",
			}, true);
	}
}
