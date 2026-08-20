/**
 * inline-panel/index.ts — install/uninstall of the inline agent panel.
 *
 * Owns the two half-mounted surfaces:
 *  - the `CrewInlineEditor` wrapper (installed via `setEditorComponent` when no
 *    other extension owns the editor), which translates ↓/↑/enter/x/escape
 *    into panel-store changes and host calls;
 *  - the `pi-crew-agent-view` widget (placement `aboveEditor`), the live
 *    transcript pane for the viewed agent.
 *
 * All heavy team-tool interaction (steer, cancel) is lazy-imported so this
 * module never pulls the runtime chain at startup (AGENTS.md lazy boundary).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CrewUiConfig } from "../../config/types.ts";
import { isToolError, type PiTeamsToolResult, textFromToolResult } from "../../extension/tool-result.ts";
import { requestRender, setExtensionWidget } from "../pi-ui-compat.ts";
import { CrewAgentPane } from "./agent-pane.ts";
import { resetAllAgentTranscriptCursors } from "./agent-transcript.ts";
import { CrewInlineEditor } from "./crew-editor.ts";
import type { PanelTarget } from "./panel-selection.ts";
import { resetPanelStore, setViewedAgent } from "./panel-store.ts";

/** Widget key for the transcript pane. */
export const PANE_WIDGET_KEY = "pi-crew-agent-view";
const PANE_PLACEMENT = "aboveEditor" as const;

let currentPane: CrewAgentPane | undefined;
let lastCtx: ExtensionContext | undefined;
let editorInstalled = false;
/** Guards the one-time per-process event hooks. */
let hooksRegistered = false;

async function runTeamTool(params: Record<string, unknown>, ctx: ExtensionContext): Promise<PiTeamsToolResult> {
	// LAZY: team-tool.ts pulls in the entire runtime chain (same boundary as
	// run-action-dispatcher.ts).
	const { handleTeamTool } = await import("../../extension/team-tool.ts");
	return handleTeamTool(params as never, ctx);
}

function notifyResult(ctx: ExtensionContext, result: PiTeamsToolResult): void {
	const text = textFromToolResult(result);
	ctx.ui.notify(isToolError(result) ? `panel: ${text}` : text, isToolError(result) ? "error" : "info");
}

function openPane(ctx: ExtensionContext, target: PanelTarget): void {
	setViewedAgent(target);
	try {
		setExtensionWidget(
			ctx,
			PANE_WIDGET_KEY,
			((tui: unknown, theme: unknown) => {
				currentPane = new CrewAgentPane(tui as never, theme as never, ctx.cwd);
				return currentPane;
			}) as never,
			{ placement: PANE_PLACEMENT },
		);
	} catch {
		/* stale ctx across session replacement */
	}
	requestRender(ctx);
}

function closePane(ctx: ExtensionContext): void {
	setViewedAgent(undefined);
	currentPane = undefined;
	try {
		setExtensionWidget(ctx, PANE_WIDGET_KEY, undefined, { placement: PANE_PLACEMENT });
	} catch {
		/* stale ctx */
	}
	requestRender(ctx);
}

function scrollPane(delta: number): void {
	currentPane?.scrollBy(delta);
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

/**
 * Install the panel for a session. Call from session_start AFTER the widget
 * has been registered, with the already-loaded UI config.
 *
 * Yields to any other extension that owns the editor component (pi-subtask
 * rule §2.6): without the editor wrapper there is no keyboard access, so the
 * panel stays display-only and /team-dashboard remains the full path.
 */
export function installInlinePanel(pi: ExtensionAPI, ctx: ExtensionContext, uiConfig?: CrewUiConfig): void {
	lastCtx = ctx;
	if (!ctx.hasUI) return;

	const enabled = uiConfig?.inlinePanel !== false;
	try {
		if (enabled && !editorInstalled && !ctx.ui.getEditorComponent()) {
			ctx.ui.setEditorComponent((tui, theme, kb) => {
				// Fresh instance per session; options close over the current ctx.
				return new CrewInlineEditor(tui, theme, kb, {
					onOpenPane: (target) => openPane(ctx, target),
					onClosePane: () => closePane(ctx),
					onScrollPane: (delta) => scrollPane(delta),
					onSteer: (target, message) => void steerAgent(ctx, target, message),
					onAct: (target, finished) => void actOnAgent(ctx, target, finished),
				});
			});
			editorInstalled = true;
		}
	} catch {
		/* editor context can be transient across session replacement */
	}

	if (!hooksRegistered) {
		hooksRegistered = true;
		pi.on("session_shutdown", () => {
			if (lastCtx) closePane(lastCtx);
			resetPanelStore();
			resetAllAgentTranscriptCursors();
		});
		pi.on("session_start", () => {
			// pi may have replaced or dropped its editor between sessions.
			editorInstalled = false;
		});
	}
}

/** Test hook: force the next install to re-attempt the editor. */
export function __resetInlinePanelForTest(): void {
	editorInstalled = false;
}
