/**
 * API-5 facade dispatch — Control domain router.
 *
 * Actions: cancel, invalidate, respond, cleanup, prune, forget, doctor.
 */
import { type CacheControlDeps } from "../cache-control.ts";
import { handleCancel } from "../cancel.ts";
import { handleDoctor } from "../doctor.ts";
import { result, type TeamContext } from "../context.ts";
import {
	handleCleanup,
	handleForget,
	handlePrune,
} from "../lifecycle-actions.ts";
import { handleRespond } from "../respond.ts";
import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import {
	cacheControlDepsFromContext,
	handleInvalidate,
} from "../../team-tool.ts";

export async function handleControlDomain(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<PiTeamsToolResult> {
	switch (params.action) {
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
		default:
			return result(`Unhandled control-domain action: ${params.action}`, {
				action: "unknown",
				status: "error",
			}, true);
	}
}
