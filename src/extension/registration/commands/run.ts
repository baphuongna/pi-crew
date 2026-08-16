import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { suggestRunIds, suggestTeams } from "../../command-completions.ts";
import { commandText, notifyCommandResult, parseRunArgs, parseScalar } from "../command-utils.ts";
import type { RegisterTeamCommandsDeps } from "./shared.ts";
import { handleTeamTool, teamCommandContext } from "./shared.ts";

export function registerRunCommands(pi: ExtensionAPI, deps: RegisterTeamCommandsDeps): void {
	pi.registerCommand("team-run", {
		description: "Manually start a pi-crew run (agent may also use the team tool autonomously)",
		// Round 13 UX: suggest team names for Tab-completion of the first positional arg.
		getArgumentCompletions: (argumentPrefix: string) => suggestTeams(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool(parseRunArgs(args), {
				...teamCommandContext(ctx),
				metricRegistry: deps.getMetricRegistry?.(),
				startForegroundRun: (runner, runId) => deps.startForegroundRun(ctx as ExtensionContext, runner, runId),
				abortForegroundRun: deps.abortForegroundRun,
				onRunStarted: undefined,
			});
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	for (const [name, action, description] of [
		["team-resume", "resume", "Resume a pi-crew run by re-queueing failed/cancelled/skipped/running tasks"],
		["team-export", "export", "Export a pi-crew run bundle to artifacts/export"],
		["team-cancel", "cancel", "Cancel a pi-crew run"],
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

	pi.registerCommand("team-invalidate", {
		description: "Invalidate the snapshot cache for a run so the UI refreshes immediately: <runId>",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const runId = args.trim() || undefined;
			if (!runId) {
				await notifyCommandResult(ctx, "Usage: /team-invalidate <runId>");
				return;
			}
			const result = await handleTeamTool(
				{ action: "invalidate", runId },
				{
					...teamCommandContext(ctx),
					getRunSnapshotCache: deps.getRunSnapshotCache,
				},
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-retry", {
		description: "Retry failed/cancelled pi-crew tasks: <runId> [taskId]",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskId = tokens.shift();
			if (!runId) {
				await notifyCommandResult(ctx, "Usage: /team-retry <runId> [taskId]");
				return;
			}
			const retryResult = await handleTeamTool(
				{ action: "retry", runId, taskId },
				{
					...teamCommandContext(ctx),
					getRunSnapshotCache: deps.getRunSnapshotCache,
				},
			);
			await notifyCommandResult(ctx, commandText(retryResult));
		},
	});

	pi.registerCommand("team-respond", {
		description: "Respond to a waiting pi-crew task: <runId> <taskId|--all> <message>",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskToken = tokens[0] === "--all" ? tokens.shift() : tokens.shift();
			const taskId = taskToken === "--all" ? undefined : taskToken;
			const message = tokens.join(" ") || undefined;
			const result = await handleTeamTool({ action: "respond", runId, taskId, message }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-follow-up", {
		description: "Send a follow-up prompt to a pi-crew task: <runId> <taskId> <prompt>",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.shift();
			const taskId = tokens.shift();
			const prompt = tokens.join(" ") || undefined;
			if (!runId || !taskId || !prompt) {
				await notifyCommandResult(
					ctx,
					"Usage: /team-follow-up <runId> <taskId> <prompt>. Use /team-respond for waiting-task replies.",
				);
				return;
			}
			const result = await handleTeamTool(
				{
					action: "api",
					runId,
					config: { operation: "follow-up-agent", taskId, prompt },
				},
				teamCommandContext(ctx),
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-api", {
		description: "Run safe pi-crew API interop operations: <runId> <operation> [key=value]",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const positional = tokens.filter((token) => !token.includes("=") && !token.startsWith("--"));
			const runIdLessOperations = new Set(["metrics-snapshot"]);
			const first = positional[0];
			const runId = first && runIdLessOperations.has(first) ? undefined : first;
			const operation = runId ? (positional[1] ?? "read-manifest") : (first ?? "read-manifest");
			const config: Record<string, unknown> = { operation };
			for (const token of tokens.filter((item) => item.includes("="))) {
				const [key, ...rest] = token.split("=");
				if (key) config[key] = parseScalar(rest.join("="));
			}
			const result = await handleTeamTool({ action: "api", runId, config }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-goal", {
		description:
			"Autonomous goal loop control: [start|status|pause|resume|stop|step|clear] [goalId] [--objective=...] [--evaluatorModel=...] [--maxTurns=N]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const knownSubs = new Set(["start", "status", "pause", "resume", "stop", "step", "clear", "cancel", "reset"]);
			const subAction = tokens[0] && knownSubs.has(tokens[0]) ? tokens[0] : "status";
			const positional = tokens.filter((token) => !token.includes("=") && !token.startsWith("--") && token !== subAction);
			const goalId = positional[0];
			const config: Record<string, unknown> = { subAction };
			if (goalId) config.goalId = goalId;
			for (const token of tokens.filter((item) => item.includes("="))) {
				const [key, ...rest] = token.split("=");
				if (key) config[key.replace(/^--/, "")] = parseScalar(rest.join("="));
			}
			const result = await handleTeamTool({ action: "goal", config }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("workflows", {
		description: "List all workflows (static + dynamic .dwf.ts)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "workflow-list" }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-metrics", {
		description: "Show pi-crew metrics snapshot: [filter]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const filter = args.trim() || undefined;
			const result = await handleTeamTool(
				{
					action: "api",
					config: { operation: "metrics-snapshot", filter },
				},
				{
					...teamCommandContext(ctx),
					metricRegistry: deps.getMetricRegistry?.(),
				},
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-imports", {
		description: "List imported pi-crew run bundles",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await handleTeamTool({ action: "imports" }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-import", {
		description: "Import a pi-crew run-export.json bundle into local imports",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const pathArg = tokens.find((token) => !token.startsWith("--"));
			const scope = tokens.includes("--user") ? "user" : "project";
			const result = await handleTeamTool({ action: "import", config: { path: pathArg, scope } }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});
}
