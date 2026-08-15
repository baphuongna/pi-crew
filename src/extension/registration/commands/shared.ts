import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../../config/config.ts";
// Lazy-loaded: team-tool.ts pulls in entire runtime chain (1.4s+).
import type { handleTeamTool as HandleTeamToolFn } from "../../team-tool.ts";
import * as path from "node:path";
import { DEFAULT_UI } from "../../../config/defaults.ts";
import type { MetricRegistry } from "../../../observability/metric-registry.ts";
import { listRecentDiagnostic } from "../../../runtime/diagnostic-export.ts";
import type { TeamAction } from "../../../schema/team-tool-schema.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../state/types.ts";
import type { AnimatedMascot as AnimatedMascotType } from "../../../ui/mascot.ts";
import type { AgentPickerOverlay as AgentPickerOverlayType } from "../../../ui/overlays/agent-picker-overlay.ts";
import type { ConfirmOptions, ConfirmOverlay as ConfirmOverlayType } from "../../../ui/overlays/confirm-overlay.ts";
import type {
	MailboxComposeOverlay as MailboxComposeOverlayType,
	MailboxComposeResult,
} from "../../../ui/overlays/mailbox-compose-overlay.ts";
import type { MailboxAction, MailboxDetailOverlay as MailboxDetailOverlayType } from "../../../ui/overlays/mailbox-detail-overlay.ts";
import { requestRenderTarget } from "../../../ui/pi-ui-compat.ts";
import {
	dispatchDiagnosticExport,
	dispatchHealthRecovery,
	dispatchKillStaleWorkers,
	dispatchMailboxAck,
	dispatchMailboxAckAll,
	dispatchMailboxCompose,
	dispatchMailboxNudge,
} from "../../../ui/run-action-dispatcher.ts";
import type { RunDashboardSelection, RunDashboard as RunDashboardType } from "../../../ui/run-dashboard.ts";
import type { createRunSnapshotCache } from "../../../ui/run-snapshot-cache.ts";
import type { DurableTextViewer as DurableTextViewerType } from "../../../ui/transcript-viewer.ts";
import { commandText, notifyCommandResult } from "../command-utils.ts";
import { withSessionId } from "../../team-tool/context.ts";
import type { UiState } from "../ui.ts";
import { openLiveConversation, openTranscriptViewer, selectAgentTask } from "../viewers.ts";

let _cachedHandleTeamTool: typeof HandleTeamToolFn | undefined;
let _handleTeamToolPromise: Promise<typeof HandleTeamToolFn> | undefined;
export async function handleTeamTool(
	params: Parameters<typeof HandleTeamToolFn>[0],
	ctx: Parameters<typeof HandleTeamToolFn>[1],
): Promise<Awaited<ReturnType<typeof HandleTeamToolFn>>> {
	if (!_cachedHandleTeamTool) {
		if (!_handleTeamToolPromise) {
			_handleTeamToolPromise = import("../../team-tool.ts").then((mod) => {
				_cachedHandleTeamTool = mod.handleTeamTool;
				return mod.handleTeamTool;
			});
		}
		const fn = await _handleTeamToolPromise;
		return fn(params, ctx);
	}
	return _cachedHandleTeamTool(params, ctx);
}

/**
 * TEST SEAM (STEP 1.9a) — substitute the lazy-loaded team-tool facade.
 * Production `handleTeamTool` populates `_cachedHandleTeamTool` on first use
 * via `import("../../team-tool.ts")` (1.4s+ runtime chain). This lets unit tests
 * inject a recording stub and exercise command handlers without importing the
 * chain. No production behavior change: the lazy-import path is untouched when
 * this is never called, and handlers always resolve through the same cache.
 */
export function __test__setHandleTeamTool(fn: typeof HandleTeamToolFn | undefined): void {
	_cachedHandleTeamTool = fn;
	_handleTeamToolPromise = undefined;
}

export interface RegisterTeamCommandsDeps {
	startForegroundRun: (ctx: ExtensionContext, runner: (signal?: AbortSignal) => Promise<void>, runId?: string) => void;
	abortForegroundRun: (runId: string) => boolean;
	openLiveSidebar: (ctx: ExtensionContext, runId: string) => void;
	getManifestCache: (cwd: string) => {
		list(max?: number): TeamRunManifest[];
	};
	getRunSnapshotCache?: (cwd: string) => ReturnType<typeof createRunSnapshotCache>;
	getMetricRegistry?: () => MetricRegistry | undefined;
	uiState?: UiState;
	dismissNotifications?: () => void;
}

// Lazy-loaded UI module cache — avoids importing 900ms+ of UI at Pi startup.
// These modules are only needed when user invokes /crew commands.
let _uiCache:
	| {
			RunDashboard: typeof RunDashboardType;
			DurableTextViewer: typeof DurableTextViewerType;
			ConfirmOverlay: typeof ConfirmOverlayType;
			MailboxDetailOverlay: typeof MailboxDetailOverlayType;
			MailboxComposeOverlay: typeof MailboxComposeOverlayType;
			AgentPickerOverlay: typeof AgentPickerOverlayType;
			AnimatedMascot: typeof AnimatedMascotType;
	  }
	| undefined;
let _uiCachePromise: Promise<NonNullable<typeof _uiCache>> | undefined;
export async function ui(): Promise<NonNullable<typeof _uiCache>> {
	if (!_uiCache) {
		if (!_uiCachePromise) {
			_uiCachePromise = (async () => {
				const [rd, tv, co, md, mc, ap, ma] = await Promise.all([
					import("../../../ui/run-dashboard.ts"),
					import("../../../ui/transcript-viewer.ts"),
					import("../../../ui/overlays/confirm-overlay.ts"),
					import("../../../ui/overlays/mailbox-detail-overlay.ts"),
					import("../../../ui/overlays/mailbox-compose-overlay.ts"),
					import("../../../ui/overlays/agent-picker-overlay.ts"),
					import("../../../ui/mascot.ts"),
				]);
				const cache = {
					RunDashboard: rd.RunDashboard,
					DurableTextViewer: tv.DurableTextViewer,
					ConfirmOverlay: co.ConfirmOverlay,
					MailboxDetailOverlay: md.MailboxDetailOverlay,
					MailboxComposeOverlay: mc.MailboxComposeOverlay,
					AgentPickerOverlay: ap.AgentPickerOverlay,
					AnimatedMascot: ma.AnimatedMascot,
				};
				_uiCache = cache;
				return cache;
			})();
		}
		return _uiCachePromise;
	}
	return _uiCache;
}

async function openConfirm(ctx: ExtensionCommandContext, options: ConfirmOptions): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const { ConfirmOverlay } = await ui();
	return await ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) => new ConfirmOverlay(options, done, theme), {
		overlay: true,
		overlayOptions: { width: 64, maxHeight: "70%", anchor: "center" },
	});
}

async function handleMailboxDashboardAction(ctx: ExtensionCommandContext, runId: string): Promise<void> {
	if (!ctx.hasUI) return;
	const { MailboxDetailOverlay } = await ui();
	const action = await ctx.ui.custom<MailboxAction | undefined>(
		(_tui, theme, _keybindings, done) => new MailboxDetailOverlay({ runId, cwd: ctx.cwd, done, theme }),
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				maxHeight: "85%",
				anchor: "center",
			},
		},
	);
	if (!action || action.type === "close") return;
	let resultMessage: string | undefined;
	let ok = true;
	if (action.type === "ack") {
		const result = await dispatchMailboxAck(ctx as ExtensionContext, runId, action.messageId);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "ackAll") {
		const confirmed = await openConfirm(ctx, {
			title: "Acknowledge all unread messages?",
			body: "This cannot be undone. Y=ack all, N=cancel.",
			dangerLevel: "medium",
			defaultAction: "cancel",
		});
		if (!confirmed) return;
		const result = await dispatchMailboxAckAll(ctx as ExtensionContext, runId);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "compose") {
		const { MailboxComposeOverlay } = await ui();
		const compose = await ctx.ui.custom<MailboxComposeResult>(
			(_tui, theme, _keybindings, done) => new MailboxComposeOverlay({ done, theme }),
			{
				overlay: true,
				overlayOptions: {
					width: "90%",
					maxHeight: "85%",
					anchor: "center",
				},
			},
		);
		if (compose.type === "cancel") return;
		const result = await dispatchMailboxCompose(ctx as ExtensionContext, runId, compose.payload);
		ok = result.ok;
		resultMessage = result.message;
	} else if (action.type === "nudge") {
		let agentId = action.agentId;
		if (!agentId) {
			const { AgentPickerOverlay } = await ui();
			const picked = await ctx.ui.custom<{ agentId: string } | undefined>(
				(_tui, theme, _keybindings, done) =>
					new AgentPickerOverlay({
						cwd: ctx.cwd,
						runId,
						done,
						theme,
					}),
				{
					overlay: true,
					overlayOptions: {
						width: 72,
						maxHeight: "75%",
						anchor: "center",
					},
				},
			);
			agentId = picked?.agentId;
		}
		if (!agentId) return;
		const result = await dispatchMailboxNudge(
			ctx as ExtensionContext,
			runId,
			agentId,
			"Please report your current status, blocker, or smallest next step.",
		);
		ok = result.ok;
		resultMessage = result.message;
	}
	depsNotify(ctx, resultMessage ?? "Mailbox action complete.", ok ? "info" : "error");
}

function depsNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

export function teamCommandContext(ctx: ExtensionCommandContext): ExtensionCommandContext & { sessionId?: string } {
	return withSessionId(ctx);
}

/**
 * Open the pi-crew settings overlay (config editor + theme picker).
 *
 * Extracted from the `team-settings` command so it is reusable from a
 * keyboard shortcut. Takes the base `ExtensionContext` (the shortcut
 * handler's context) — uses only `hasUI`, `cwd`, and `ui` fields, so both
 * `ExtensionContext` and `ExtensionCommandContext` satisfy it.
 */
export async function openTeamSettingsOverlay(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const [{ updateConfig, parseConfig }, { asCrewTheme }, { createSettingsOverlay }] = await Promise.all([
		import("../../../config/config.ts"),
		import("../../../ui/theme-adapter.ts"),
		import("../../../ui/settings-overlay.ts"),
	]);
	const loaded = loadConfig(ctx.cwd);
	const config = loaded.config as Record<string, unknown>;
	await ctx.ui.custom<undefined>(
		(_tui, _theme, _keybindings, done) => {
			const theme = asCrewTheme(_theme);
			const { overlay } = createSettingsOverlay(
				config,
				theme,
				(id: string, value: unknown) => {
					try {
						const patch: Record<string, unknown> = {};
						const keys = id.split(".");
						let target: Record<string, unknown> = patch;
						for (let i = 0; i < keys.length - 1; i++) {
							if (!target[keys[i]!] || typeof target[keys[i]!] !== "object") target[keys[i]!] = {};
							target = target[keys[i]!] as Record<string, unknown>;
						}
						target[keys[keys.length - 1]!] = value;
						if (value === undefined) {
							updateConfig({}, { unsetPaths: [id] });
						} else {
							updateConfig(parseConfig(patch));
						}
					} catch (error) {
						ctx.ui.notify(`Failed to save: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				},
				() => done(undefined),
				async (action: string, value: unknown) => {
					// Action callbacks (Pi theme switch) write to a different store
					// than pi-crew config (e.g. ~/.pi/agent/settings.json).
					try {
						if (action === "piTheme" && typeof value === "string") {
							// Live theme switch: ctx.ui.setTheme() swaps the global theme,
							// persists it to settings.json, and triggers a UI redraw — no
							// restart needed. Falls back to file-write + restart hint if
							// the live API is unavailable (e.g. non-TUI mode).
							if (typeof ctx.ui.setTheme === "function") {
								const res = ctx.ui.setTheme(value);
								if (res.success) {
									ctx.ui.notify(`Theme: ${value} (applied live)`, "info");
								} else {
									// LAZY: defer dynamic import of ../../ui/theme-discovery.ts to its call site.
									const { setPiTheme } = await import("../../../ui/theme-discovery.ts");
									setPiTheme(value);
									ctx.ui.notify(
										`Theme saved as '${value}' but failed to apply: ${res.error ?? "unknown"}. Restart Pi.`,
										"warning",
									);
								}
							} else {
								// LAZY: defer dynamic import of ../../ui/theme-discovery.ts to its call site.
								const { setPiTheme } = await import("../../../ui/theme-discovery.ts");
								setPiTheme(value);
								ctx.ui.notify(`Pi theme set to '${value}'. Restart Pi to apply.`, "info");
							}
						}
					} catch (error) {
						ctx.ui.notify(`Failed: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				},
			);
			return overlay;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "90%",
				maxHeight: "85%",
				anchor: "center",
			},
		},
	);
}

async function handleHealthDashboardAction(ctx: ExtensionCommandContext, selection: RunDashboardSelection): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, selection.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) {
		depsNotify(ctx, `Run '${selection.runId}' not found.`, "error");
		return;
	}
	if (selection.action === "health-recovery") {
		if (loaded.manifest.async) {
			depsNotify(ctx, "Recovery is only available for foreground runs.", "warning");
			return;
		}
		const confirmed = await openConfirm(ctx, {
			title: "Interrupt foreground run?",
			body: "Tasks may be marked failed. Y=interrupt, N=cancel.",
			dangerLevel: "high",
			defaultAction: "cancel",
		});
		if (!confirmed) return;
		const result = await dispatchHealthRecovery(ctx as ExtensionContext, selection.runId);
		depsNotify(ctx, result.message, result.ok ? "info" : "error");
		return;
	}
	if (selection.action === "health-kill-stale") {
		const confirmed = await openConfirm(ctx, {
			title: "Mark stale workers dead?",
			body: "This updates worker heartbeat state. Y=mark dead, N=cancel.",
			dangerLevel: "medium",
			defaultAction: "cancel",
		});
		if (!confirmed) return;
		const result = await dispatchKillStaleWorkers(ctx as ExtensionContext, selection.runId);
		depsNotify(ctx, result.message, result.ok ? "info" : "error");
		return;
	}
	if (selection.action === "health-diagnostic-export") {
		const diagDir = path.join(loaded.manifest.artifactsRoot, "diagnostic");
		const recent = listRecentDiagnostic(diagDir, 60_000);
		if (recent) {
			const confirmed = await openConfirm(ctx, {
				title: "Recent diagnostic exists",
				body: `File ${recent} was created <1min ago. Export another diagnostic?`,
				defaultAction: "cancel",
			});
			if (!confirmed) return;
		}
		const result = await dispatchDiagnosticExport(ctx as ExtensionContext, selection.runId, {
			registry: depsRef?.getMetricRegistry?.(),
		});
		depsNotify(ctx, result.message, result.ok ? "info" : "error");
	}
}

let depsRef: RegisterTeamCommandsDeps | undefined;

/**
 * Internal setter for `depsRef` (Phase 2.1 split). ESM import bindings are
 * read-only, so `registerTeamCommands` in index.ts cannot assign to the
 * shared binding directly; this setter preserves the original single-module
 * behavior (module-level state set once at registration).
 */
export function setTeamCommandsDeps(deps: RegisterTeamCommandsDeps): void {
	depsRef = deps;
}

/**
 * Open the pi-crew run dashboard overlay and run its action loop.
 *
 * Extracted verbatim from the `team-dashboard` command so it is reusable from
 * a keyboard shortcut (alt+c, see crew-shortcuts.ts). Takes the base
 * `ExtensionContext` (the shortcut handler's context) — uses only `hasUI`,
 * `cwd`, `ui`, and `sessionManager` fields, so both `ExtensionContext` and
 * `ExtensionCommandContext` satisfy it. Reads run caches via the module-level
 * `depsRef` (set by `registerTeamCommands`), so it is a no-op if commands
 * have not been registered yet. `deps` is captured into a local const so the
 * non-undefined narrowing survives the awaited overlay call.
 *
 * The dashboard action helpers (handleMailboxDashboardAction, the viewers,
 * notifyCommandResult, teamCommandContext/handleTeamTool) are declared for
 * `ExtensionCommandContext` but only ever read base `ExtensionContext` fields
 * (verified). The keyboard-shortcut path supplies an `ExtensionContext`, so we
 * bridge those over-typed helpers with a single cast rather than relaxing
 * signatures across several modules (some outside this file's scope).
 */
export async function openTeamDashboard(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const deps = depsRef;
	if (!deps) return;
	if (deps.uiState) deps.uiState.dashboardOpen = true;
	const cmdCtx = ctx as ExtensionCommandContext;
	for (;;) {
		// Extract sessionId for workspace-scoped filtering
		const sessionId = cmdCtx.sessionManager?.getSessionId?.();
		const runs = deps.getManifestCache(cmdCtx.cwd).list(50);
		const uiConfig = loadConfig(cmdCtx.cwd).config.ui;
		const rightPanel = (uiConfig?.dashboardPlacement ?? DEFAULT_UI.dashboardPlacement) === "right";
		const width = rightPanel ? Math.min(90, Math.max(40, uiConfig?.dashboardWidth ?? DEFAULT_UI.dashboardWidth)) : "90%";
		const { RunDashboard } = await ui();
		const selection = await cmdCtx.ui.custom<RunDashboardSelection | undefined>(
			(tui, theme, _keybindings, done) =>
				new RunDashboard(runs, done, theme, {
					placement: rightPanel ? "right" : "center",
					showModel: uiConfig?.showModel,
					showTokens: uiConfig?.showTokens,
					showTools: uiConfig?.showTools,
					snapshotCache: deps.getRunSnapshotCache?.(cmdCtx.cwd),
					runProvider: () => deps.getManifestCache(cmdCtx.cwd).list(50),
					registry: deps.getMetricRegistry?.(),
					workspaceId: sessionId,
					requestRender: () => requestRenderTarget(tui),
				}),
			{
				overlay: true,
				overlayOptions: rightPanel
					? {
							width,
							minWidth: 40,
							maxHeight: "100%",
							anchor: "top-right",
							offsetX: 0,
							offsetY: 0,
							margin: { top: 0, right: 0, bottom: 0, left: 0 },
						}
					: { width, maxHeight: "90%", anchor: "center", margin: 2 },
			},
		);
		if (!selection) break;
		if (selection.action === "reload") continue;
		if (selection.action === "notifications-dismiss") {
			deps.dismissNotifications?.();
			cmdCtx.ui.notify("pi-crew notifications dismissed.", "info");
			continue;
		}
		if (selection.action === "mailbox-detail") {
			await handleMailboxDashboardAction(cmdCtx, selection.runId);
			deps.getRunSnapshotCache?.(cmdCtx.cwd).invalidate(selection.runId);
			continue;
		}
		if (
			selection.action === "health-recovery" ||
			selection.action === "health-kill-stale" ||
			selection.action === "health-diagnostic-export"
		) {
			await handleHealthDashboardAction(cmdCtx, selection);
			deps.getRunSnapshotCache?.(cmdCtx.cwd).invalidate(selection.runId);
			continue;
		}
		if (selection.action === "agent-transcript" && (await openTranscriptViewer(cmdCtx, selection.runId))) continue;
		if (selection.action === "agent-live" && (await openLiveConversation(cmdCtx, selection.runId))) continue;
		if (selection.action === "agent-live") {
			await notifyCommandResult(
				cmdCtx,
				commandText({
					content: [
						{
							type: "text",
							text: "No live agent found for this run.",
						},
					],
				}),
			);
			continue;
		}
		const result =
			selection.action === "api"
				? await handleTeamTool(
						{
							action: "api",
							runId: selection.runId,
							config: { operation: "read-manifest" },
						},
						teamCommandContext(cmdCtx),
					)
				: selection.action === "agents"
					? await handleTeamTool(
							{
								action: "api",
								runId: selection.runId,
								config: { operation: "agent-dashboard" },
							},
							teamCommandContext(cmdCtx),
						)
					: selection.action === "mailbox"
						? await handleTeamTool(
								{
									action: "api",
									runId: selection.runId,
									config: { operation: "read-mailbox" },
								},
								teamCommandContext(cmdCtx),
							)
						: selection.action === "agent-events"
							? await handleTeamTool(
									{
										action: "api",
										runId: selection.runId,
										config: {
											operation: "read-agent-events",
											limit: 50,
										},
									},
									teamCommandContext(cmdCtx),
								)
							: selection.action === "agent-output"
								? await handleTeamTool(
										{
											action: "api",
											runId: selection.runId,
											config: {
												operation: "read-agent-output",
												maxBytes: 32_000,
											},
										},
										teamCommandContext(cmdCtx),
									)
								: selection.action === "agent-transcript"
									? await handleTeamTool(
											{
												action: "api",
												runId: selection.runId,
												config: {
													operation: "read-agent-transcript",
												},
											},
											teamCommandContext(cmdCtx),
										)
									: await handleTeamTool(
											{
												action: selection.action as TeamAction,
												runId: selection.runId,
											},
											teamCommandContext(cmdCtx),
										);
		await notifyCommandResult(cmdCtx, commandText(result));
		break;
	}
	if (deps.uiState) deps.uiState.dashboardOpen = false;
}

