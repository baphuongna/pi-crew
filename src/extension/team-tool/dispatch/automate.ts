/**
 * API-5 facade dispatch — Automate domain router.
 *
 * Actions: schedule, scheduled, anchor, auto-summarize, auto_boomerang, api.
 *
 * Inline cases (anchor, auto-summarize/auto_boomerang) are moved verbatim from
 * the former handleTeamTool switch.
 */

import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import { formatActionSuggestion } from "../../action-suggestions.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import { handleAnchorAccumulate, handleAnchorClear, handleAnchorSet, handleAnchorStatus } from "../anchor.ts";
import { handleApi } from "../api.ts";
import {
	createAutoSummarizeService,
	handleAutoSummarizeConfig,
	handleAutoSummarizeOff,
	handleAutoSummarizeOn,
	handleAutoSummarizeStatus,
} from "../auto-summarize.ts";
import { result, type TeamContext } from "../context.ts";
import { handleListScheduled, handleSchedule } from "../handle-schedule.ts";

/**
 * Actions owned by the Automate domain. Single source of truth for the switch
 * below AND for the runtime exhaustiveness test
 * (test/unit/dispatch-exhaustive.test.ts). The compile-time `never` sentinel in
 * the `default` branch errors if an AutomateDomainAction is added here without
 * a matching `case`.
 */
export const AUTOMATE_DOMAIN_ACTIONS = ["schedule", "scheduled", "anchor", "auto-summarize", "auto_boomerang", "api"] as const;
type AutomateDomainAction = (typeof AUTOMATE_DOMAIN_ACTIONS)[number];

export async function handleAutomateDomain(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	// `domainForAction` routes only Automate-domain actions here, so narrowing is sound.
	const action = params.action as AutomateDomainAction;
	switch (action) {
		case "api":
			return handleApi(params, ctx);
		case "schedule":
			return handleSchedule(params, ctx);
		case "scheduled":
			return handleListScheduled(params, ctx);
		case "anchor": {
			const subAction = typeof params.config?.subAction === "string" ? params.config.subAction : "status";
			switch (subAction) {
				case "set":
					return handleAnchorSet(params, ctx);
				case "clear":
					return handleAnchorClear(params, ctx);
				case "accumulate":
					return handleAnchorAccumulate(params, ctx);
				default:
					return handleAnchorStatus(params, ctx);
			}
		}
		case "auto-summarize":
		case "auto_boomerang": {
			const subAction =
				typeof params.config?.subAction === "string"
					? params.config.subAction
					: (params.action as string) === "auto_boomerang"
						? "toggle"
						: "status";
			switch (subAction) {
				case "on":
					return handleAutoSummarizeOn(params, ctx);
				case "off":
					return handleAutoSummarizeOff(params, ctx);
				case "config":
					return handleAutoSummarizeConfig(params, ctx);
				case "toggle": {
					const service = createAutoSummarizeService();
					service.toggle();
					return result(`Auto-summarize ${service.isEnabled() ? "enabled" : "disabled"}.`, {
						action: "auto-summarize",
						status: "ok",
					});
				}
				default:
					return handleAutoSummarizeStatus(params, ctx);
			}
		}
		default: {
			// Compile-time exhaustiveness: errors if an AutomateDomainAction lacks a case above.
			const _exhaustive: never = action;
			return result(
				`Unhandled automate-domain action: ${params.action}${formatActionSuggestion(String(params.action ?? ""))}`,
				{ action: "unknown", status: "error" },
				true,
			);
		}
	}
}
