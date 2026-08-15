import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { suggestRunIds } from "../../command-completions.ts";
import { piTeamsHelp } from "../../help.ts";
import { commandText, notifyCommandResult } from "../command-utils.ts";
import { handleTeamTool, teamCommandContext } from "./shared.ts";
import type { RegisterTeamCommandsDeps } from "./shared.ts";

export function registerStatusCommands(pi: ExtensionAPI, deps: RegisterTeamCommandsDeps): void {

	pi.registerCommand("teams", {
		description: "List pi-crew teams, workflows, and agents",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "list" }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	for (const [name, action, description] of [
		["team-status", "status", "Show pi-crew run status"],
		["team-summary", "summary", "Show pi-crew run summary"],
		["team-events", "events", "Show full pi-crew event log for a run"],
		["team-artifacts", "artifacts", "List pi-crew artifacts for a run"],
		["team-worktrees", "worktrees", "List pi-crew worktrees for a run"],
	] as const) {
		pi.registerCommand(name, {
			description,
			// Round 13 UX: suggest recent run IDs for Tab-completion.
			getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const runId = args.trim() || undefined;
				const result = await handleTeamTool(
					{ action, runId },
					{
						...teamCommandContext(ctx),
						getRunSnapshotCache: deps.getRunSnapshotCache,
					},
				);
				await notifyCommandResult(ctx, commandText(result));
			},
		});
	}

	for (const [name, action, description] of [
		["team-validate", "validate", "Validate pi-crew agents, teams, and workflows"],
		["team-doctor", "doctor", "Check pi-crew installation and discovery readiness"],
	] as const)
		pi.registerCommand(name, {
			description,
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const result = await handleTeamTool({ action }, teamCommandContext(ctx));
				await notifyCommandResult(ctx, commandText(result));
			},
		});

	pi.registerCommand("team-help", {
		description: "Show pi-crew command help",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await notifyCommandResult(ctx, piTeamsHelp());
		},
	});

}
