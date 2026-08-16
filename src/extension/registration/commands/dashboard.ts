import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../../config/config.ts";
import { DEFAULT_UI } from "../../../config/defaults.ts";
import { readCrewAgents } from "../../../runtime/crew-agent-records.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import { requestRenderTarget } from "../../../ui/pi-ui-compat.ts";
import { suggestRunIds, suggestTaskIds } from "../../command-completions.ts";
import { commandText, notifyCommandResult } from "../command-utils.ts";
import { openTranscriptViewer, selectAgentTask } from "../viewers.ts";
import type { RegisterTeamCommandsDeps } from "./shared.ts";
import { handleTeamTool, openTeamDashboard, teamCommandContext, ui } from "./shared.ts";

export function registerDashboardCommands(pi: ExtensionAPI, deps: RegisterTeamCommandsDeps): void {
	pi.registerCommand("team-result", {
		description: "Open a pi-crew agent result viewer: <runId> [taskId]",
		getArgumentCompletions: async (argumentPrefix: string) => {
			const parts = argumentPrefix.trim().split(/\s+/);
			return parts.length <= 1 ? suggestRunIds(parts[0] ?? "") : suggestTaskIds(parts[0] ?? "", parts[1] ?? "");
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [runId, rawTaskId] = args.trim().split(/\s+/).filter(Boolean);
			const selected = await selectAgentTask(ctx, runId, rawTaskId);
			const loaded = selected ? loadRunManifestById(ctx.cwd, selected.runId) : undefined; // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
			if (ctx.hasUI && loaded) {
				const agent =
					readCrewAgents(loaded.manifest).find((item) => item.taskId === selected?.taskId || item.id === selected?.taskId) ??
					readCrewAgents(loaded.manifest)[0];
				const resultText = agent?.resultArtifactPath
					? commandText(
							await handleTeamTool(
								{
									action: "api",
									runId: selected?.runId ?? "",
									config: {
										operation: "read-agent-output",
										agentId: agent.taskId,
										maxBytes: 64_000,
									},
								},
								teamCommandContext(ctx),
							),
						)
					: "(no result)";
				const { DurableTextViewer } = await ui();
				await ctx.ui.custom<undefined>(
					(_tui, theme, _keybindings, done) =>
						new DurableTextViewer(
							"pi-crew result",
							`${selected?.runId ?? ""}:${agent?.taskId ?? "unknown"}`,
							resultText.split(/\r?\n/),
							theme,
							done,
						),
					{
						overlay: true,
						overlayOptions: {
							width: "90%",
							maxHeight: "85%",
							anchor: "center",
						},
					},
				);
				return;
			}
			const result = await handleTeamTool(
				{
					action: "api",
					runId,
					config: {
						operation: "read-agent-output",
						agentId: rawTaskId,
						maxBytes: 64_000,
					},
				},
				teamCommandContext(ctx),
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-transcript", {
		description: "Open a pi-crew transcript viewer: <runId> [taskId]",
		getArgumentCompletions: async (argumentPrefix: string) => {
			const parts = argumentPrefix.trim().split(/\s+/);
			return parts.length <= 1 ? suggestRunIds(parts[0] ?? "") : suggestTaskIds(parts[0] ?? "", parts[1] ?? "");
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [runId, taskId] = args.trim().split(/\s+/).filter(Boolean);
			if (await openTranscriptViewer(ctx, runId, taskId)) return;
			const result = await handleTeamTool(
				{
					action: "api",
					runId,
					config: {
						operation: "read-agent-transcript",
						agentId: taskId,
					},
				},
				teamCommandContext(ctx),
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-dashboard", {
		description: "Open a pi-crew run dashboard overlay",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openTeamDashboard(ctx);
		},
	});

	pi.registerCommand("team-mascot", {
		description: "Show an animated mascot splash",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const uiConfig = loadConfig(ctx.cwd).config.ui;
			const styleArg = tokens.find((t) => t === "cat" || t === "armin");
			const effectArg = tokens.find((t) =>
				["random", "none", "typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"].includes(t),
			);
			const style = (styleArg as "cat" | "armin" | undefined) ?? uiConfig?.mascotStyle ?? DEFAULT_UI.mascotStyle;
			const effect =
				(effectArg as
					| "random"
					| "none"
					| "typewriter"
					| "scanline"
					| "rain"
					| "fade"
					| "crt"
					| "glitch"
					| "dissolve"
					| undefined) ??
				uiConfig?.mascotEffect ??
				DEFAULT_UI.mascotEffect;
			const { AnimatedMascot } = await ui();
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new AnimatedMascot(theme, () => done(undefined), {
						frameIntervalMs: style === "armin" ? 100 : 180,
						autoCloseMs: 7000,
						requestRender: () => requestRenderTarget(tui),
						style,
						effect,
					}),
				{
					overlay: true,
					overlayOptions: {
						width: style === "armin" ? 48 : 62,
						maxHeight: "85%",
						anchor: "center",
					},
				},
			);
		},
	});
}
