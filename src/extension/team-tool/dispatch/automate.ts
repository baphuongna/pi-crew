/**
 * API-5 facade dispatch — Automate domain router.
 *
 * Actions: schedule, scheduled, anchor, auto-summarize, auto_boomerang, api.
 *
 * Inline cases (anchor, auto-summarize/auto_boomerang) are moved verbatim from
 * the former handleTeamTool switch.
 */
import {
	handleAnchorAccumulate,
	handleAnchorClear,
	handleAnchorSet,
	handleAnchorStatus,
} from "../anchor.ts";
import { handleApi } from "../api.ts";
import {
	createAutoSummarizeService,
	handleAutoSummarizeConfig,
	handleAutoSummarizeOff,
	handleAutoSummarizeOn,
	handleAutoSummarizeStatus,
} from "../auto-summarize.ts";
import { handleListScheduled, handleSchedule } from "../handle-schedule.ts";
import { result, type TeamContext } from "../context.ts";
import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import { formatActionSuggestion } from "../../action-suggestions.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";

export async function handleAutomateDomain(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<PiTeamsToolResult> {
	switch (params.action) {
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
		default:
			return result(
				`Unhandled automate-domain action: ${params.action}${formatActionSuggestion(String(params.action ?? ""))}`,
				{ action: "unknown", status: "error" },
				true,
			);
	}
}
