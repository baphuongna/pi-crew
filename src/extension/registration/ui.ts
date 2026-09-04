/**
 * UI installer (H3 + L2 — Phase 4 of cleanup plan).
 *
 * Owns the dashboard / sidebar / powerbar overlay logic that is gated on
 * the user actually opening the dashboard (autoOpenDashboard flag) or a
 * foreground run starting.
 *
 * Extracted from src/extension/register.ts. State holder is `UiState`;
 * installer is `installLiveSidebar(ctx, runId, state, deps)`.
 *
 * Lazy by construction: the LiveRunSidebar class (and its transcript-viewer
 * dependency tree) is only loaded when the user opens a sidebar overlay.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../config/config.ts";
import { DEFAULT_UI } from "../../config/defaults.ts";
import type { LiveRunSidebar as LiveRunSidebarType } from "../../ui/live-run-sidebar.ts";
import { requestRender, setExtensionWidget, showCustom, toPiWidgetPlacement } from "../../ui/pi-ui-compat.ts";
import {
	clearPiCrewPowerbar,
	registerPiCrewPowerbarSegments,
	requestPowerbarUpdate,
	resetPowerbarDedupState,
	updatePiCrewPowerbar,
} from "../../ui/powerbar-publisher.ts";
import type { CrewWidgetState } from "../../ui/widget/index.ts";
import { stopCrewWidget, updateCrewWidget } from "../../ui/widget/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";

async function importLiveRunSidebar(): Promise<typeof LiveRunSidebarType> {
	// LAZY: defer LiveRunSidebar import until the user opens a sidebar overlay.
	const mod = await import("../../ui/live-run-sidebar.ts");
	return mod.LiveRunSidebar;
}

/** Mutable state owned by register.ts. */
export interface UiState {
	liveSidebarRunId: string | undefined;
	dashboardOpened: boolean;
	/** True while the full RunDashboard overlay (/team-dashboard) is open.
	 * Checked by the global renderTick to skip crew-widget updates while the
	 * dashboard obscures the widget (mirrors the liveSidebarRunId gate). */
	dashboardOpen?: boolean;
}

/** Dependencies passed in by register.ts. */
export interface UiDeps {
	pi: ExtensionAPI;
	widgetState: CrewWidgetState;
	getManifestCache: (cwd: string) => ReturnType<typeof import("../../runtime/manifest-cache.ts").createManifestCache>;
	getRunSnapshotCache: (cwd: string) => ReturnType<typeof import("../../ui/run-snapshot-cache.ts").createRunSnapshotCache>;
	isCleanedUp: () => boolean;
	getCurrentCtx: () => ExtensionContext | undefined;
}

/**
 * Open the live-run sidebar overlay if autoOpenDashboard is enabled. Gated by
 * ui.autoOpenDashboard / autoOpenDashboardForForegroundRuns / placement.
 *
 * Returns true if the sidebar was opened (or was already open for this runId),
 * false if gated off.
 */
export async function installLiveSidebar(ctx: ExtensionContext, runId: string, state: UiState, deps: UiDeps): Promise<boolean> {
	const uiConfig = loadConfig(ctx.cwd).config.ui;
	const autoOpen = uiConfig?.autoOpenDashboard === true;
	const foregroundAutoOpen = uiConfig?.autoOpenDashboardForForegroundRuns ?? DEFAULT_UI.autoOpenDashboardForForegroundRuns;
	if (!ctx.hasUI || !autoOpen || !foregroundAutoOpen || (uiConfig?.dashboardPlacement ?? DEFAULT_UI.dashboardPlacement) !== "right") {
		return false;
	}
	if (state.liveSidebarRunId === runId) return true;
	state.liveSidebarRunId = runId;
	state.dashboardOpened = true;
	const widgetPlacement = uiConfig?.widgetPlacement ?? DEFAULT_UI.widgetPlacement;
	const placement = toPiWidgetPlacement(widgetPlacement);
	setExtensionWidget(ctx, "pi-crew", undefined, { placement });
	setExtensionWidget(ctx, "pi-crew-active", undefined, { placement });
	deps.widgetState.lastVisibility = "hidden";
	deps.widgetState.lastPlacement = placement;
	deps.widgetState.lastKey = "pi-crew-active";
	deps.widgetState.model = undefined;
	const width = Math.min(90, Math.max(40, uiConfig?.dashboardWidth ?? DEFAULT_UI.dashboardWidth));

	try {
		const LiveRunSidebar = await importLiveRunSidebar();
		if (deps.isCleanedUp() || !deps.getCurrentCtx()) return false;
		void showCustom<undefined>(
			ctx,
			(_tui, theme, _keybindings, done) =>
				new LiveRunSidebar({
					cwd: ctx.cwd,
					runId,
					done,
					theme,
					config: uiConfig,
					snapshotCache: deps.getRunSnapshotCache(ctx.cwd),
				}),
			{
				overlay: true,
				overlayOptions: {
					width,
					minWidth: 40,
					maxHeight: "100%",
					anchor: "top-right",
					offsetX: 0,
					offsetY: 0,
					margin: { top: 0, right: 0, bottom: 0, left: 0 },
					visible: (termWidth: number) => termWidth >= 100,
				},
			},
		).finally(() => {
			if (state.liveSidebarRunId === runId) state.liveSidebarRunId = undefined;
			const c = deps.getCurrentCtx();
			if (!c) return;
			updateCrewWidget(
				c,
				deps.widgetState,
				loadConfig(c.cwd).config.ui,
				deps.getManifestCache(c.cwd),
				deps.getRunSnapshotCache(c.cwd),
			);
		});
		return true;
	} catch (error) {
		logInternalError("register.live-sidebar-lazy-import", error);
		return false;
	}
}

/** Clear the powerbar (called on session switch). */
export function clearDashboardPowerbar(state: UiState, deps: UiDeps): void {
	const c = deps.getCurrentCtx();
	if (c) stopCrewWidget(c, deps.widgetState, loadConfig(c.cwd).config.ui);
	clearPiCrewPowerbar(deps.pi.events);
	resetPowerbarDedupState();
	state.dashboardOpened = false;
}

/** Register powerbar segments for a session. Idempotent. */
export function registerPowerbarSegments(deps: UiDeps, uiConfig: unknown): void {
	registerPiCrewPowerbarSegments(deps.pi.events, uiConfig as Parameters<typeof registerPiCrewPowerbarSegments>[1]);
}

/** Push a powerbar update with current run state. */
export function pushPowerbarUpdate(ctx: ExtensionContext, deps: UiDeps, notificationCount: number): void {
	const config = loadConfig(ctx.cwd).config.ui;
	requestPowerbarUpdate(
		deps.pi.events,
		ctx.cwd,
		config,
		deps.getManifestCache(ctx.cwd),
		deps.getRunSnapshotCache(ctx.cwd),
		ctx,
		notificationCount,
	);
}

/** Initial powerbar update after session_start. */
export function primePowerbarAndWidget(ctx: ExtensionContext, deps: UiDeps, notificationCount: number): void {
	const uiConfig = loadConfig(ctx.cwd).config.ui;
	const cache = deps.getManifestCache(ctx.cwd);
	updateCrewWidget(ctx, deps.widgetState, uiConfig, cache, deps.getRunSnapshotCache(ctx.cwd));
	updatePiCrewPowerbar(deps.pi.events, ctx.cwd, uiConfig, cache, deps.getRunSnapshotCache(ctx.cwd), ctx, notificationCount);
}

/** Force-render the current context (used by sidebar open path). */
export function requestUiRender(ctx: ExtensionContext): void {
	requestRender(ctx);
}
