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

import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import { cacheControlDepsFromContext, handleResume, handleRun, handleSteer, handleWait } from "../../team-tool.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import { handleRetry } from "../cancel.ts";
import { result, type TeamContext } from "../context.ts";
import { handleGoal } from "../goal.ts";
import { handleOrchestrate } from "../orchestrate.ts";
import { handleParallel } from "../parallel-dispatch.ts";
import { handlePlan } from "../plan.ts";

/**
 * Actions owned by the Run domain. Single source of truth for the switch
 * below AND for the runtime exhaustiveness test
 * (test/unit/dispatch-exhaustive.test.ts). The compile-time `never` sentinel in
 * the `default` branch errors if a RunDomainAction is added here without a
 * matching `case`.
 */
export const RUN_DOMAIN_ACTIONS = ["run", "parallel", "plan", "orchestrate", "resume", "retry", "wait", "steer", "goal"] as const;
type RunDomainAction = (typeof RUN_DOMAIN_ACTIONS)[number];

export async function handleRunDomain(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	// `domainForAction` routes only Run-domain actions here, so narrowing is sound.
	const action = params.action as RunDomainAction;
	switch (action) {
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
		default: {
			// Compile-time exhaustiveness: errors if a RunDomainAction lacks a case above.
			const _exhaustive: never = action;
			return result(
				`Unhandled run-domain action: ${params.action}`,
				{
					action: "unknown",
					status: "error",
				},
				true,
			);
		}
	}
}
