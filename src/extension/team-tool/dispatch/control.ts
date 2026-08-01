/**
 * API-5 facade dispatch — Control domain router.
 *
 * Actions: cancel, invalidate, respond, cleanup, prune, forget, doctor.
 */

import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import { cacheControlDepsFromContext, handleInvalidate } from "../../team-tool.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import { handleCancel } from "../cancel.ts";
import { result, type TeamContext } from "../context.ts";
import { handleDoctor } from "../doctor.ts";
import { handleCleanup, handleForget, handlePrune } from "../lifecycle-actions.ts";
import { handleRespond } from "../respond.ts";

/**
 * Actions owned by the Control domain. Single source of truth for the switch
 * below AND for the runtime exhaustiveness test
 * (test/unit/dispatch-exhaustive.test.ts). The compile-time `never` sentinel in
 * the `default` branch errors if a ControlDomainAction is added here without a
 * matching `case`.
 */
export const CONTROL_DOMAIN_ACTIONS = ["cancel", "invalidate", "respond", "cleanup", "prune", "forget", "doctor"] as const;
type ControlDomainAction = (typeof CONTROL_DOMAIN_ACTIONS)[number];

export async function handleControlDomain(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	// `domainForAction` routes only Control-domain actions here, so narrowing is sound.
	const action = params.action as ControlDomainAction;
	switch (action) {
		case "doctor":
			return handleDoctor(ctx, params);
		case "cleanup":
			return handleCleanup(params, ctx);
		case "prune":
			return handlePrune(params, ctx);
		case "forget":
			return handleForget(params, ctx);
		case "cancel":
			return handleCancel(params, ctx, cacheControlDepsFromContext(ctx));
		case "invalidate":
			return handleInvalidate(params, ctx);
		case "respond":
			return handleRespond(params, ctx);
		default: {
			// Compile-time exhaustiveness: errors if a ControlDomainAction lacks a case above.
			const _exhaustive: never = action;
			return result(
				`Unhandled control-domain action: ${params.action}`,
				{
					action: "unknown",
					status: "error",
				},
				true,
			);
		}
	}
}
