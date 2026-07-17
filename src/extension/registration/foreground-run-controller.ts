/**
 * Foreground run controller for pi-crew.
 *
 * Owns the three helpers consumed by the team-tool / subagent-tools /
 * team-commands modules:
 *   • `startForegroundRun` — spawn a foreground team run with watchdog,
 *     abort signal, and completion-handling (status notification + widget
 *     refresh + crew.run.* event emission).
 *   • `abortForegroundRun` — abort a foreground team run by runId.
 *   • `openLiveSidebar`     — open the per-run live sidebar UI overlay.
 *
 * These three are conceptually one unit (all manipulate the same
 * foreground-team-run controllers + live sidebar state), so they share
 * a single file.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRunManifestById, updateRunStatus } from "../../state/state-store.ts";
import { setWorkingIndicator } from "../../ui/pi-ui-compat.ts";
import {
	requestPowerbarUpdate,
	updatePiCrewPowerbar,
} from "../../ui/powerbar-publisher.ts";
import { updateCrewWidget } from "../../ui/widget/index.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { loadConfig } from "../../config/config.ts";
import type { RegistrationContext } from "./registration-types.ts";

/**
 * Install the foreground-run controller helpers into the registration
 * context. Re-call safe — each call rebinds `ctx.startForegroundRun`,
 * `ctx.abortForegroundRun`, and `ctx.openLiveSidebar` to fresh closures
 * (the underlying state lives on `ctx`).
 */
export function installForegroundRunController(pi: ExtensionAPI, ctx: RegistrationContext): void {
	ctx.openLiveSidebar = (extCtx, runId) => {
		void openLiveSidebarImpl(pi, ctx, extCtx, runId);
	};
	ctx.startForegroundRun = (extCtx, runner, runId) => startForegroundRunImpl(pi, ctx, extCtx, runner, runId);
	ctx.abortForegroundRun = (runId) => {
		const controller = ctx.foregroundTeamRunControllers.get(runId);
		if (!controller) return false;
		controller.abort();
		return true;
	};
}

/**
 * Open the live sidebar for a specific run.
 *
 * Defers the actual install to registration/ui.ts via a lazy dynamic
 * import — only invoked when a sidebar is actually requested, never at
 * module load.
 */
async function openLiveSidebarImpl(
	pi: ExtensionAPI,
	ctx: RegistrationContext,
	extensionCtx: ExtensionContext,
	runId: string,
): Promise<void> {
	// LAZY: registration/ui pulls in transcript-viewer + heavy UI modules.
	const uiModule = await import("./ui.ts");
	await uiModule.installLiveSidebar(extensionCtx, runId, ctx.uiState, {
		pi,
		widgetState: ctx.widgetState,
		getManifestCache: ctx.getManifestCache,
		getRunSnapshotCache: ctx.getRunSnapshotCache,
		isCleanedUp: () => ctx.cleanedUp,
		getCurrentCtx: () => ctx.currentCtx,
	});
}

/**
 * Spawn a foreground team run.
 *
 * The runner executes on the next macrotask (`setImmediate`) so this
 * function returns synchronously to Pi. The runner receives an AbortSignal
 * that fires when:
 *   • `abortForegroundRun(runId)` is called (e.g., from a tool cancel),
 *   • `cleanupRuntime()` fires (session shutdown with reason=quit/reload).
 *
 * A foreground-watchdog is started per runId to surface hung runs to the
 * assistant. The .finally block handles: abort propagation, working-message
 * clearing, status notification, run-completed session entry, and crew.run.*
 * event emission.
 */
function startForegroundRunImpl(
	pi: ExtensionAPI,
	ctx: RegistrationContext,
	extensionCtx: ExtensionContext,
	runner: (signal?: AbortSignal) => Promise<void>,
	runId?: string,
): void {
	const ownerGeneration = ctx.captureSessionGeneration();
	const controller = new AbortController();
	const key = runId ?? Symbol();
	ctx.foregroundTeamRunControllers.set(key, controller);
	if (extensionCtx.hasUI) {
		setWorkingIndicator(extensionCtx, {
			frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
			intervalMs: 80,
		});
		extensionCtx.ui.setWorkingMessage(runId ? `pi-crew foreground run ${runId}...` : "pi-crew foreground run...");
	}
	if (runId) {
		void import("../../runtime/foreground-watchdog.ts")
			.then(({ startForegroundWatchdog }) => {
				startForegroundWatchdog({ pi, cwd: extensionCtx.cwd, runId });
			})
			.catch((error) => {
				logInternalError("register.foreground-watchdog-import", error);
			});
	}
	setImmediate(() => {
		void runner(controller.signal)
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (runId) {
					try {
						const loaded = loadRunManifestById(extensionCtx.cwd, runId);
						if (
							loaded &&
							loaded.manifest.status !== "completed" &&
							loaded.manifest.status !== "failed" &&
							loaded.manifest.status !== "cancelled" &&
							loaded.manifest.status !== "blocked"
						)
							updateRunStatus(loaded.manifest, "failed", message);
					} catch (statusError) {
						logInternalError("register.foreground-run-failure", statusError, `runId=${runId}`);
					}
				}
				if (ctx.isContextCurrent(extensionCtx, ownerGeneration)) {
					extensionCtx.ui.notify(`pi-crew foreground run failed: ${message}`, "error");
				} else {
					logInternalError("register.foreground-run-failure", error, `runId=${runId} context disposed`);
				}
			})
			.finally(() => {
				ctx.foregroundTeamRunControllers.delete(key);
				if (runId) {
					void import("../../runtime/foreground-watchdog.ts")
						.then(({ stopWatchdog }) => {
							stopWatchdog(runId);
						})
						.catch((error) => logInternalError("register.foreground-watchdog", error, `runId=${runId}`));
				}
				const ownerCurrent = ctx.isContextCurrent(extensionCtx, ownerGeneration);
				if (extensionCtx.hasUI) {
					try {
						setWorkingIndicator(extensionCtx);
						extensionCtx.ui.setWorkingMessage();
					} catch {
						/* ignore */
					}
				}
				if (ownerCurrent && runId) {
					const loaded = loadRunManifestById(extensionCtx.cwd, runId);
					const status = loaded?.manifest.status ?? "finished";
					const level = status === "failed" || status === "blocked" ? "error" : status === "cancelled" ? "warning" : "info";
					extensionCtx.ui.notify(
						`pi-crew run ${runId} ${status}. Use /team-summary ${runId} or /team-status ${runId}.`,
						level as "info" | "warning" | "error",
					);
					pi.appendEntry("crew:run-completed", {
						runId,
						team: loaded?.manifest.team,
						workflow: loaded?.manifest.workflow,
						goal: loaded?.manifest.goal,
						status,
						taskCount: loaded?.tasks.length,
						timestamp: Date.now(),
					});
					const eventType =
						status === "completed"
							? "crew.run.completed"
							: status === "failed" || status === "blocked"
								? "crew.run.failed"
								: status === "cancelled"
									? "crew.run.cancelled"
									: undefined;
					if (eventType) {
						pi.events?.emit?.(eventType, {
							runId,
							team: loaded?.manifest.team,
							workflow: loaded?.manifest.workflow,
							status,
							taskCount: loaded?.tasks.length,
							goal: loaded?.manifest.goal,
						});
					}
				}
				if (ownerCurrent && ctx.currentCtx) {
					const config = loadConfig(ctx.currentCtx.cwd).config.ui;
					updateCrewWidget(
						ctx.currentCtx,
						ctx.widgetState,
						config,
						ctx.getManifestCache(ctx.currentCtx.cwd),
						ctx.getRunSnapshotCache(ctx.currentCtx.cwd),
					);
					requestPowerbarUpdate(
						pi.events,
						ctx.currentCtx.cwd,
						config,
						ctx.getManifestCache(ctx.currentCtx.cwd),
						ctx.getRunSnapshotCache(ctx.currentCtx.cwd),
						ctx.currentCtx,
						ctx.widgetState.notificationCount ?? 0,
					);
				}
			});
	});
}
