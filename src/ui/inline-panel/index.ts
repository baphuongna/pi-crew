/**
 * inline-panel/index.ts — install/uninstall of the inline agent panel.
 *
 * Owns the two half-mounted surfaces:
 *  - the `CrewInlineEditor` wrapper (installed via `setEditorComponent` when no
 *    other extension owns the editor), which translates ↓/↑/enter/x/escape
 *    into panel-store changes and host calls;
 *  - the FULL-SCREEN agent view overlay (`ctx.ui.custom` with `overlay:
 *    true`, width "100%"), the LIVE transcript of the viewed agent.
 *
 * Entering an agent row takes over the whole terminal with that agent's live
 * transcript — a separate view, not content appended under the main session.
 * The overlay tails the agent's on-disk event log (events.jsonl, appended in
 * real time by the running child pi worker) and renders through pi's own
 * transcript components. The main session is never switched, resumed, or torn
 * down to look at an agent, so viewing can never kill a run or strand the
 * editor. (The previous design — copy the worker's session file and
 * `switchSession` to it, re-switching every few seconds — cancelled live runs
 * on teardown, froze at the copy timestamp, and crashed on stale extension
 * ctxs; see the "fix(view)" chain in git history.)
 *
 * All heavy team-tool interaction (steer, cancel) is lazy-imported so this
 * module never pulls the runtime chain at startup (AGENTS.md lazy boundary).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CrewUiConfig } from "../../config/types.ts";
import { isToolError, type PiTeamsToolResult, textFromToolResult } from "../../extension/tool-result.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { requestRender } from "../pi-ui-compat.ts";
import type { CrewAgentPane } from "./agent-pane.ts";
import { resetAllAgentTranscriptCursors } from "./agent-transcript.ts";
import { CrewAgentOverlay } from "./agent-view-overlay.ts";
import { CrewInlineEditor } from "./crew-editor.ts";
import type { PanelTarget } from "./panel-selection.ts";
import { resetPanelStore, setViewedAgent } from "./panel-store.ts";

/**
 * Live repaint cadence while the view is open. The pane re-reads the agent's
 * event log during render() (throttled internally), so a periodic
 * requestRender keeps it following the worker even when pi's own repaints
 * are idle (no spinner, no typing). pi-subtask drives this from child RPC
 * events; our workers write to disk, so the pane is disk-tailed instead.
 */
const PANE_LIVE_TICK_MS = 700;

let livePane: CrewAgentPane | undefined;
let liveOverlay: CrewAgentOverlay | undefined;
let paneTickTimer: ReturnType<typeof setInterval> | undefined;
let editorInstalled = false;
/** Guards the one-time per-process event hooks. */
let hooksRegistered = false;

function startPaneTicker(): void {
	if (paneTickTimer) return;
	paneTickTimer = setInterval(() => livePane?.requestRender(), PANE_LIVE_TICK_MS);
	paneTickTimer.unref?.();
}

function stopPaneTicker(): void {
	if (paneTickTimer) {
		clearInterval(paneTickTimer);
		paneTickTimer = undefined;
	}
	livePane = undefined;
}

async function runTeamTool(params: Record<string, unknown>, ctx: ExtensionContext): Promise<PiTeamsToolResult> {
	// LAZY: team-tool.ts pulls in the entire runtime chain (same boundary as
	// run-action-dispatcher.ts).
	// LAZY: (marker on the import line's previous line, per check-lazy-imports)
	const { handleTeamTool } = await import("../../extension/team-tool.ts");
	return handleTeamTool(params as never, ctx);
}

function notifyResult(ctx: ExtensionContext, result: PiTeamsToolResult): void {
	const text = textFromToolResult(result);
	ctx.ui.notify(isToolError(result) ? `panel: ${text}` : text, isToolError(result) ? "error" : "info");
}

/**
 * Open the viewed agent's LIVE transcript as a FULL-SCREEN overlay (or, when
 * one is already open, just re-target it — the pane follows the panel store).
 * Pure overlay wiring — no session is touched, so there is nothing to settle,
 * detach, or guard: the view works in every session state, for foreground and
 * async runs alike, and closing it never affects the run.
 */
function openPane(ctx: ExtensionContext, target: PanelTarget): void {
	setViewedAgent(target);
	if (!liveOverlay) {
		try {
			void ctx.ui
				.custom(
					(tui, theme, _keybindings, done) => {
						const overlay = new CrewAgentOverlay(tui as never, theme as never, ctx.cwd, {
							close: () => {
								liveOverlay = undefined;
								livePane = undefined;
								setViewedAgent(undefined);
								stopPaneTicker();
								try {
									done(undefined);
								} catch {
									/* already closed by the host */
								}
							},
							steer: (steerTarget, message) => void steerAgent(ctx, steerTarget, message),
						});
						liveOverlay = overlay;
						livePane = overlay.pane;
						return overlay as never;
					},
					{
						overlay: true,
						overlayOptions: { width: "100%", margin: 0, maxHeight: "100%", anchor: "top-left" },
					},
				)
				.catch((error) => {
					// Factory throw or the host tearing the overlay down: drop the
					// view state so the dock does not point at a view that no
					// longer exists.
					liveOverlay = undefined;
					livePane = undefined;
					setViewedAgent(undefined);
					stopPaneTicker();
					logInternalError("view.openOverlay", error, target.taskId);
				});
		} catch (error) {
			// A stale ctx (session replaced between keypress and here) drops the
			// overlay spawn; the fallback editor path still closes cleanly.
			logInternalError("view.openPane", error, target.taskId);
		}
	}
	startPaneTicker();
	try {
		requestRender(ctx);
	} catch {
		/* stale ctx — nothing to repaint */
	}
}

/** Close the view and return to the main conversation. Never touches the run. */
function closePane(_ctx: ExtensionContext): void {
	if (liveOverlay) {
		// The overlay owns its teardown (state reset + host `done()`); the
		// requestClose path is idempotent.
		liveOverlay.requestClose();
		return;
	}
	setViewedAgent(undefined);
	stopPaneTicker();
}

async function steerAgent(ctx: ExtensionContext, target: PanelTarget, message: string): Promise<void> {
	try {
		notifyResult(ctx, await runTeamTool({ action: "steer", runId: target.runId, taskId: target.taskId, message }, ctx));
		// Delivery is at the child's next turn boundary, not mid-tool-call;
		// say so explicitly so the user does not read silence as a dropped message.
		ctx.ui.notify("Will be delivered at the worker's next turn boundary.", "info");
	} catch (error) {
		ctx.ui.notify(`panel: steer failed — ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function actOnAgent(ctx: ExtensionContext, target: PanelTarget, finished: boolean): Promise<void> {
	if (finished) {
		// Finished rows age out of the linger window on their own. `x` here
		// only returns focus to typing; resume/inspect stays in the dashboard
		// so a single keystroke never mutates anything.
		ctx.ui.notify("Agent is finished — use /team-dashboard to inspect or resume.", "info");
		return;
	}
	// Cancel is run-level in the team tool, so a single-keystroke `x` must not
	// silently destroy a whole run: confirm first.
	const confirmed = await ctx.ui.confirm(
		"Cancel entire run?",
		`This cancels run ${target.runId} and all its workers. Ongoing work stops; resume re-queues what was left.`,
	);
	if (!confirmed) {
		ctx.ui.notify("Cancel aborted.", "info");
		return;
	}
	try {
		notifyResult(ctx, await runTeamTool({ action: "cancel", runId: target.runId }, ctx));
	} catch (error) {
		ctx.ui.notify(`panel: cancel failed — ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

// ── Agent view commands ────────────────────────────────────────────────
//
// `/crew-view <runId> <taskId>` and `/crew-back` are thin aliases for the
// pane wiring above (open / close). They never switch sessions — the dock's
// enter key takes the same path.

async function handleCrewViewCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length < 2) {
		ctx.ui.notify("Usage: /crew-view <runId> <taskId>", "error");
		return;
	}
	const [runId, taskId] = tokens;
	// LAZY: state-store is runtime state, not a UI dependency.
	// LAZY: (marker on the import line's previous line, per check-lazy-imports)
	const { loadRunManifestById } = await import("../../state/stores/state-store.ts");
	if (!loadRunManifestById(ctx.cwd, runId)) {
		ctx.ui.notify(`No run ${runId} in this project.`, "error");
		return;
	}
	openPane(ctx, { runId, taskId });
}

async function handleCrewBackCommand(_args: string, ctx: ExtensionContext): Promise<void> {
	closePane(ctx);
}

/**
 * Install the panel for a session. Call from session_start AFTER the widget
 * has been registered, with the already-loaded UI config.
 *
 * Yields to any other extension that owns the editor component (pi-subtask
 * rule §2.6): without the editor wrapper there is no keyboard access, so the
 * panel stays display-only and /team-dashboard remains the full path.
 */
export function installInlinePanel(pi: ExtensionAPI, ctx: ExtensionContext, uiConfig?: CrewUiConfig): void {
	if (!ctx.hasUI) return;

	const enabled = uiConfig?.inlinePanel !== false;
	try {
		if (enabled && !editorInstalled && !ctx.ui.getEditorComponent()) {
			ctx.ui.setEditorComponent((tui, theme, kb) => {
				// Fresh instance per session; options close over the current ctx.
				return new CrewInlineEditor(tui, theme, kb, {
					onOpenPane: (target) => openPane(ctx, target),
					onClosePane: () => closePane(ctx),
					onScrollPane: (delta) => livePane?.scrollBy(delta),
					onSteer: (target, message) => void steerAgent(ctx, target, message),
					onAct: (target, finished) => void actOnAgent(ctx, target, finished),
				});
			});
			editorInstalled = true;
		}
	} catch {
		/* editor context can be transient across session replacement */
	}

	// Commands must be re-registered for EVERY session: pi rebuilds the
	// extension command table on session replacement. registerCommand is
	// idempotent on the current session's runner.
	pi.registerCommand("crew-view", {
		description: "Open an agent's live full-screen transcript view (usage: crew-view <runId> <taskId>)",
		handler: handleCrewViewCommand,
	});
	pi.registerCommand("crew-back", {
		description: "Close the agent transcript view and return to the main conversation",
		handler: handleCrewBackCommand,
	});

	if (!hooksRegistered) {
		hooksRegistered = true;
		pi.on("session_shutdown", () => {
			stopPaneTicker();
			livePane = undefined;
			liveOverlay = undefined;
			resetPanelStore();
			resetAllAgentTranscriptCursors();
		});
		pi.on("session_start", () => {
			// pi may have replaced or dropped its editor between sessions; the
			// "installed" flag is reset so the next install re-registers the
			// factory. The open overlay outlives the session swap (it belongs
			// to the interactive-mode UI, not the session's ctx) — keep it, but
			// stop ticking until it is re-targeted.
			editorInstalled = false;
			stopPaneTicker();
		});
	}
}

/** Test hook: force the next install to re-attempt the editor. */
export function __resetInlinePanelForTest(): void {
	editorInstalled = false;
	liveOverlay = undefined;
	stopPaneTicker();
}

/** Test seam for openPane (the panel wires it as the dock's Enter action). */
/** Test seam for closePane. */
export { closePane as __test__closePane, openPane as __test__openPane };
