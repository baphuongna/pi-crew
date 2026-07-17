/**
 * Command registration installer for pi-crew.
 *
 * Single entry point that wires every `pi.registerCommand(...)` call
 * site in the extension. Today that means one heavy call:
 *   • `registerTeamCommands` — registers every `/crew-*`, `/team-*`,
 *     `/teams`, and friends. The full set lives in
 *     `registration/commands.ts` (already extracted); this file is
 *     the orchestrator-level wrapper that calls it with the right deps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { updateCrewWidget } from "../../ui/widget/index.ts";
import { updatePiCrewPowerbar } from "../../ui/powerbar-publisher.ts";
import { registerTeamCommands } from "./commands.ts";
import type { RegistrationContext } from "./registration-types.ts";

/**
 * Register all pi-crew slash commands on the ExtensionAPI.
 *
 * The dismiss-notifications callback (used by commands like
 * `/crew-notifications dismiss`) needs to refresh both the widget and
 * the powerbar with the new count, so we read `currentCtx` + `widgetState`
 * lazily off the context.
 */
export function registerPiCommands(pi: ExtensionAPI, ctx: RegistrationContext): void {
	registerTeamCommands(pi, {
		startForegroundRun: ctx.startForegroundRun,
		abortForegroundRun: ctx.abortForegroundRun,
		openLiveSidebar: ctx.openLiveSidebar,
		getManifestCache: ctx.getManifestCache,
		getRunSnapshotCache: ctx.getRunSnapshotCache,
		getMetricRegistry: () => ctx.observabilityState.metricRegistry,
		dismissNotifications: () => {
			ctx.widgetState.notificationCount = 0;
			if (ctx.currentCtx) {
				const uiConfig = loadConfig(ctx.currentCtx.cwd).config.ui;
				updateCrewWidget(
					ctx.currentCtx,
					ctx.widgetState,
					uiConfig,
					ctx.getManifestCache(ctx.currentCtx.cwd),
					ctx.getRunSnapshotCache(ctx.currentCtx.cwd),
				);
				updatePiCrewPowerbar(
					pi.events,
					ctx.currentCtx.cwd,
					uiConfig,
					ctx.getManifestCache(ctx.currentCtx.cwd),
					ctx.getRunSnapshotCache(ctx.currentCtx.cwd),
					ctx.currentCtx,
					0,
				);
			}
		},
	});
}
