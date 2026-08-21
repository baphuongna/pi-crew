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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CrewUiConfig } from "../../config/types.ts";
import { isToolError, type PiTeamsToolResult, textFromToolResult } from "../../extension/tool-result.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { requestRender, setExtensionWidget } from "../pi-ui-compat.ts";
import { CrewAgentPane } from "./agent-pane.ts";
import { resetAllAgentTranscriptCursors } from "./agent-transcript.ts";
import { buildAgentViewSessionFile } from "./agent-view-session.ts";
import { CrewInlineEditor } from "./crew-editor.ts";
import type { PanelTarget } from "./panel-selection.ts";
import { resetPanelStore, setViewedAgent } from "./panel-store.ts";
import {
	clearViewSwitchInFlight,
	getCrewViewSessionState,
	isCrewViewSessionFile,
	markViewSwitchInFlight,
	resolveReturnSessionFile,
	setCrewViewSessionState,
} from "./view-session-store.ts";

/** Widget key for the transcript pane (fallback when a view session cannot be built). */
export const PANE_WIDGET_KEY = "pi-crew-agent-view";
const PANE_PLACEMENT = "aboveEditor" as const;

let currentPane: CrewAgentPane | undefined;
/** The active CrewInlineEditor instance, so panelless flows (session view
 *  opening) can route a slash command through pi's normal submit path. */
let currentEditor: CrewInlineEditor | undefined;
let lastCtx: ExtensionContext | undefined;
let lastPi: ExtensionAPI | undefined;
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

/**
 * Dispatch a session-level slash command (crew-view / crew-back) through pi's
 * IMMEDIATE command-execution path: `sendUserMessage(text, { expandPromptTemplates:
 * true })` → session.prompt → extension commands execute synchronously in ALL
 * session states (streaming, tool-executing, idle).
 *
 * The legacy editor submit path was unreliable for this: a FOREGROUND team run
 * keeps the main turn busy for its whole lifetime, so the submitted text was
 * queued as a plain user input and only ran after the run ended — or never,
 * leaving "/crew-view …" sitting in the input (regression: "view won't open,
 * only the input changes").
 */
function dispatchViewCommand(text: string): void {
	const pi = lastPi;
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }) => Promise<void> } | undefined)
		?.sendUserMessage;
	if (typeof sendUserMessage === "function") {
		try {
			// The extension API is FIRE-AND-FORGET: it returns void (rejections
			// are routed to the runner's error channel) — never chain on the
			// return value.
			sendUserMessage.call(pi, text, { expandPromptTemplates: true });
		} catch (error) {
			logInternalError("view.dispatch", error, text);
		}
		return;
	}
	// Very old pi without sendUserMessage — legacy editor submit path.
	currentEditor?.dispatchCommandFallback(text);
}

/**
 * Open an agent "view".
 *
 * Preferred path: build a REAL pi session file from the agent's event log and
 * switch the whole screen to it (`/crew-view` — entered via the editor's
 * submit path so pi's own command dispatch handles the session swap). The
 * command is dispatched AFTER the current input tick unwinds: `switchSession`
 * tears the current session down, which would invalidate the editor while we
 * are still inside its key handler otherwise.
 *
 * Fallback: when the session file cannot be built (run missing, events file
 * absent), keep the in-document transcript pane.
 */
const VIEW_BUILD_RETRY_MS = 500;
const VIEW_BUILD_MAX_RETRIES = 16;

/** Build the view file, retrying briefly while the run's state settles
 *  (enter can land in the gap between a task row appearing and its event
 *  files flushing). Falls back to the in-document pane after exhausting
 *  the attempts. */
async function buildViewPath(ctx: ExtensionContext, target: PanelTarget): Promise<string | undefined> {
	for (let attempt = 0; ; attempt += 1) {
		const viewPath = buildAgentViewSessionFile({ cwd: ctx.cwd, runId: target.runId, taskId: target.taskId });
		if (viewPath) return viewPath;
		if (attempt >= VIEW_BUILD_MAX_RETRIES) return undefined;
		await new Promise((resolve) => setTimeout(resolve, VIEW_BUILD_RETRY_MS));
	}
}

function openPane(ctx: ExtensionContext, target: PanelTarget): void {
	setViewedAgent(target);

	void (async () => {
		const viewPath = await buildViewPath(ctx, target);
		if (viewPath) {
			setTimeout(() => {
				dispatchViewCommand(`/crew-view ${target.runId} ${target.taskId}`);
			}, 0);
			return;
		}
		// State never materialised — keep the live in-document pane.
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
	})();
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

// ── Agent session view commands ───────────────────────────────────────
//
// `/crew-view <runId> <taskId>` — switch the WHOLE screen to a real pi session
// built from that agent's event log (pi's own transcript rendering, tool cards,
// working editor). `/crew-back` — return to the main session. These are also
// reachable by typing, which keeps the feature usable without the panel.
//
// `switchSession` is only exposed on the extension COMMAND context (not the
// plain ExtensionContext), so the panel opens views by submitting these
// commands through the editor's submit path instead of calling pi directly.

async function handleCrewViewCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length < 2) {
		ctx.ui.notify("Usage: /crew-view <runId> <taskId>", "error");
		return;
	}
	if (typeof ctx.switchSession !== "function") {
		ctx.ui.notify("This pi version does not support session views (needs switchSession).", "error");
		return;
	}
	const [runId, taskId] = tokens;
	const prev = getCrewViewSessionState();
	const currentFile = ctx.sessionManager.getSessionFile();
	// When /crew-view runs FROM a view session (↓-switching agents), the
	// current session is another view — its file/session id must NOT become
	// the store's return path. Keep the ORIGINAL main session instead.
	const alreadyViewing = isCrewViewSessionFile(currentFile);
	const mainSessionFile = alreadyViewing ? prev.mainSessionFile : currentFile;
	try {
		const viewPath = buildAgentViewSessionFile({
			cwd: ctx.cwd,
			runId,
			taskId,
			parentSessionFile: mainSessionFile ?? prev.mainSessionFile,
		});
		if (!viewPath) {
			ctx.ui.notify(`No transcript for agent ${taskId} in run ${runId}.`, "error");
			return;
		}
		// Remember the return path BEFORE the switch tears this session down.
		const sessionId = alreadyViewing
			? prev.mainSessionId
			: typeof ctx.sessionManager?.getSessionId === "function"
				? ctx.sessionManager.getSessionId()
				: undefined;
		setCrewViewSessionState({
			active: true,
			runId,
			taskId,
			mainSessionFile: mainSessionFile ?? prev.mainSessionFile,
			mainSessionId: typeof sessionId === "string" && sessionId ? sessionId : prev.mainSessionId,
		});
		// Navigational switch: session-lifecycle cleanup must NOT abort the
		// run's workers/children while this is in flight (see
		// stopSessionBoundSubagents). Cleared when the switch lands (next
		// session_start) or cancels.
		markViewSwitchInFlight();
		let result: { cancelled?: boolean } | undefined;
		try {
			result = await ctx.switchSession(viewPath);
		} catch (error) {
			clearViewSwitchInFlight();
			setCrewViewSessionState({ ...prev, active: false });
			ctx.ui.notify(`crew-view failed — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (result?.cancelled) clearViewSwitchInFlight();
	} catch (error) {
		clearViewSwitchInFlight();
		setCrewViewSessionState({ ...prev, active: false });
		ctx.ui.notify(`crew-view failed — ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function handleCrewBackCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const prev = getCrewViewSessionState();
	// Self-healing return path: when the CURRENT session is a crew view, the
	// view file's header records the main session even if the store was reset
	// by a stale reconcile (a session_start for the old session can fire
	// before the view's own start lands).
	const currentFile = ctx.sessionManager.getSessionFile();
	const mainSessionFile = resolveReturnSessionFile(currentFile, prev);
	if (!prev.active && !isCrewViewSessionFile(currentFile)) {
		ctx.ui.notify("Not viewing an agent session.", "info");
		return;
	}
	if (!mainSessionFile) {
		ctx.ui.notify("Not viewing an agent session.", "info");
		return;
	}
	if (typeof ctx.switchSession !== "function") {
		ctx.ui.notify("This pi version does not support session views (needs switchSession).", "error");
		return;
	}
	// Clear BEFORE switching: session_start reconciles the store against the
	// file that ends up active, and a stale `active` flag would relabel the
	// main session as a view.
	setCrewViewSessionState({ active: false });
	// Same navigational guarantee as /crew-view: the run's workers survive
	// the return switch.
	markViewSwitchInFlight();
	try {
		const result = await ctx.switchSession(mainSessionFile);
		if (result?.cancelled) clearViewSwitchInFlight();
	} catch (error) {
		clearViewSwitchInFlight();
		ctx.ui.notify(`crew-back failed — ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/**
 * Reconcile the view-session store against the CURRENT session file.
 *
 * Runs on every session_start (main AND view sessions): when the active file
 * is one of our agent-view sessions, the store stays "viewing" (so the editor
 * rebinds escape→back); otherwise the store snaps back to not-viewing and
 * refreshes the main session path (covers /crew-back, /resume, /new …).
 */
function reconcileViewSessionState(ctx: ExtensionContext): void {
	const file = ctx.sessionManager.getSessionFile();
	// Any session start means a pending view switch has landed (or aborted) —
	// the destructive-cleanup suppression window for that switch is over.
	clearViewSwitchInFlight();
	// The session file may not be bound yet when session_start fires right
	// after a switchSession — never clear the view state based on a missing
	// file (that race would silently disable escape-to-back).
	if (!file) return;
	const nextActive = isCrewViewSessionFile(file);
	const prev = getCrewViewSessionState();
	if (nextActive) {
		setCrewViewSessionState(prev);
		return;
	}
	setCrewViewSessionState({
		active: false,
		// Keep the last known main file (a view that was abandoned via /new
		// still has a return path; a fresh session keeps its own file).
		mainSessionFile: file ?? prev.mainSessionFile,
	});
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
	lastPi = pi;
	if (!ctx.hasUI) return;

	// The active session may be an agent view (or we may have returned from
	// one) — reconcile before wiring the editor so escape/enter behave right.
	reconcileViewSessionState(ctx);

	const enabled = uiConfig?.inlinePanel !== false;
	try {
		if (enabled && !editorInstalled && !ctx.ui.getEditorComponent()) {
			ctx.ui.setEditorComponent((tui, theme, kb) => {
				// Fresh instance per session; options close over the current ctx.
				const editor = new CrewInlineEditor(tui, theme, kb, {
					onOpenPane: (target) => openPane(ctx, target),
					onClosePane: () => closePane(ctx),
					onScrollPane: (delta) => scrollPane(delta),
					onSteer: (target, message) => void steerAgent(ctx, target, message),
					onAct: (target, finished) => void actOnAgent(ctx, target, finished),
					onDispatchCommand: (text) => void dispatchViewCommand(text),
				});
				currentEditor = editor;
				return editor;
			});
			editorInstalled = true;
		}
	} catch {
		/* editor context can be transient across session replacement */
	}

	// Commands must be re-registered for EVERY session: pi's switchSession
	// (our /crew-view) builds a fresh extension command table for the new
	// session, and a classic once-per-process guard leaves the view session
	// without crew-back (its submit would then become a REAL user message).
	// registerCommand is idempotent on the current session's runner.
	pi.registerCommand("crew-view", {
		description: "Open a real pi session view of a crew agent (usage: crew-view <runId> <taskId>)",
		handler: handleCrewViewCommand,
	});
	pi.registerCommand("crew-back", {
		description: "Return from an agent session view to the main session",
		handler: handleCrewBackCommand,
	});

	if (!hooksRegistered) {
		hooksRegistered = true;
		pi.on("session_shutdown", () => {
			if (lastCtx) closePane(lastCtx);
			resetPanelStore();
			resetAllAgentTranscriptCursors();
		});
		pi.on("session_start", () => {
			// pi may have replaced or dropped its editor between sessions. The
			// EDITOR instance is process-wide (pi creates it once from our
			// factory and keeps it across session switches), so `currentEditor`
			// stays valid for the dispatch path — only the "installed" flag is
			// reset so the next install re-registers the factory if needed.
			editorInstalled = false;
		});
	}
}

/** Test hook: force the next install to re-attempt the editor. */
export function __resetInlinePanelForTest(): void {
	editorInstalled = false;
	currentEditor = undefined;
}
