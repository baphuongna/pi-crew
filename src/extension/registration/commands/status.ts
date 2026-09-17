import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import { suggestRunIds } from "../../command-completions.ts";
import { piTeamsHelp } from "../../help.ts";
import { commandText, NOTIFY_TEXT_CAP, notifyCommandResult } from "../command-utils.ts";
import type { RegisterTeamCommandsDeps } from "./shared.ts";
import { handleTeamTool, teamCommandContext } from "./shared.ts";

/**
 * W5 (slash-commands fix spec): `/team-events` pointer. When the events
 * listing is about to be clipped by the 800-char notification cap, resolve
 * the run's on-disk events log so the message can end with a reachable path.
 * Derived from the SAME source the `events` team action reads
 * (inspect.ts): locateRunCwd + loadRunManifestById → manifest.eventsPath.
 * The dynamic team-tool import is free here — the awaited handleTeamTool
 * call above it already loaded that module into the ESM cache.
 */
async function eventsLogFooter(runId: string | undefined, text: string, cwd: string): Promise<string | undefined> {
	if (!runId || text.length <= NOTIFY_TEXT_CAP) return undefined;
	const { locateRunCwd } = await import("../../team-tool.ts"); // LAZY: defer team-tool chain to call site (handleTeamTool already cached it).
	const runCwd = locateRunCwd(runId, cwd);
	const manifest = runCwd ? loadRunManifestById(runCwd, runId)?.manifest : undefined;
	return manifest ? ` Full log: ${manifest.eventsPath}` : undefined;
}

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
				const text = commandText(result);
				await notifyCommandResult(ctx, text, {
					// W5: only `team-events` output is a truncatable on-disk log —
					// point at the full file when the listing gets clipped.
					truncatedFooter: action === "events" ? await eventsLogFooter(runId, text, ctx.cwd) : undefined,
				});
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
