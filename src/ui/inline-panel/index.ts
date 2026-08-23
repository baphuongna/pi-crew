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

import { existsSync, readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CrewUiConfig } from "../../config/types.ts";
import { isToolError, type PiTeamsToolResult, textFromToolResult } from "../../extension/tool-result.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { requestRender, setExtensionWidget } from "../pi-ui-compat.ts";
import { resetAllAgentTranscriptCursors } from "./agent-transcript.ts";
import { buildAgentViewSessionFile, sessionsRootFromFile, workerSessionSourceStamp } from "./agent-view-session.ts";
import { CrewInlineEditor } from "./crew-editor.ts";
import type { PanelTarget } from "./panel-selection.ts";
import { resetPanelStore, setViewedAgent } from "./panel-store.ts";
import {
	captureCommandCtx,
	clearViewSwitchInFlight,
	currentCommandCtx,
	getCrewViewSessionState,
	isCrewViewSessionFile,
	isViewSwitchInFlight,
	markViewSwitchInFlight,
	resolveReturnSessionFile,
	setCrewViewSessionState,
} from "./view-session-store.ts";

/** Widget key for the transcript pane (fallback when a view session cannot be built). */
export const PANE_WIDGET_KEY = "pi-crew-agent-view";
const PANE_PLACEMENT = "aboveEditor" as const;

/**
 * Live-refresh cadence for the agent view session. The view file is a
 * snapshot, but the agent's events.jsonl keeps growing while it works —
 * periodically rebuild the view file and re-resume it (pi's own session
 * switch) so the view shows the subagent's progress in near real time.
 */
const VIEW_REFRESH_MS = 3000;

/** The active CrewInlineEditor instance, so panelless flows (session view
 *  opening) can route a slash command through pi's normal submit path. */
let currentEditor: CrewInlineEditor | undefined;
let lastCtx: ExtensionContext | undefined;
let lastPi: ExtensionAPI | undefined;
/** Live-refresh timer while a view session is active. */
let viewRefreshTimer: ReturnType<typeof setInterval> | undefined;
/** Content baseline of the view file the last refresh dispatched (avoids
 *  re-switching when the agent hasn't produced anything new). */
let viewRefreshBaseline: string | undefined;
/** Last dispatch timestamp — throttle against switch overlap. */
let lastViewRefreshAt = 0;
let editorInstalled = false;
/** Guards the one-time per-process event hooks. */
let hooksRegistered = false;

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

// ── Stale-ctx hardening ────────────────────────────────────────────────
//
// A pi extension ctx throws on ANY property access once its session is
// replaced or reloaded (`ExtensionRunner.assertActive` guards every getter —
// `ui`, `cwd`, `sessionManager`, …). View-opening flows AWAIT across the
// session's lifetime (build retries, settle polling, switchSession), so a
// continuation can resume AFTER its ctx went stale. An unguarded `ctx.ui.*`
// there rejected the async flow uncaught and killed the whole process
// ("pi exiting due to uncaughtException: This extension ctx is stale…").

/** Whether the ctx's session is still the live one (probe, never throw). */
function ctxAlive(ctx: ExtensionContext | ExtensionCommandContext): boolean {
	try {
		void (ctx as { ui?: unknown }).ui;
		return true;
	} catch {
		return false;
	}
}

/** ctx.ui.notify that cannot reject the caller: on a stale ctx the target
 *  session is gone — the message would both crash and land nowhere. */
function safeNotify(ctx: ExtensionContext | ExtensionCommandContext, text: string, level: "info" | "error"): void {
	if (!ctxAlive(ctx)) return;
	try {
		ctx.ui.notify(text, level);
	} catch {
		/* raced stale between probe and call */
	}
}

/** Invoke a view command handler without leaking a rejection: these are
 *  fire-and-forget (`void …`) call sites, and a rejection there is an
 *  unhandled one — the same crash class as the stale-ctx notify. */
function invokeViewHandler(run: Promise<void>, label: string): void {
	run.catch((error) => {
		logInternalError(label, error);
	});
}

// ── One view-open at a time ────────────────────────────────────────────
//
// Enter on an agent row can dispatch through the editor submit fallback
// (no captured command ctx yet — a run started via the team TOOL never ran a
// crew slash command). While a tool call is mid-flight pi parks that submit
// in pendingUserInputs until the turn ends, so NOTHING appears to happen —
// and every extra Enter queued ANOTHER "/crew-view". When the turn finished
// they all executed back-to-back: each switchSession tore the just-created
// session down again, the abort cascades cancelled live work, and the
// openPane continuations resumed on dead ctxs (the crash above). One
// in-flight open, with feedback, until the command actually runs.

interface PendingViewOpen {
	runId: string;
	taskId: string;
	at: number;
}

let pendingViewOpen: PendingViewOpen | undefined;
/** Safety valve so a dropped queued command can never wedge Enter forever
 *  (the settle path itself is bounded at ~8s). */
const VIEW_OPEN_PENDING_TTL_MS = 30_000;

function clearPendingViewOpen(): void {
	pendingViewOpen = undefined;
}

/**
 * Dispatch a session-level slash command (crew-view / crew-back) so it runs
 * through pi's extension-command executor — the ONLY route that executes "/"
 * commands immediately in every session state (streaming, tool-executing,
 * idle): `prompt()` expands commands first and `_tryExecuteExtensionCommand`
 * runs BEFORE the streaming check.
 *
 * The editor submit path reaches that route: pi wires our editor's `onSubmit`
 * to the default editor's (`setCustomEditorComponent`), whose submit handler
 * calls `prompt(text)` — expansion on, command executed synchronously.
 *
 * pi's `sendUserMessage` CANNOT be used for this: it forces
 * `expandPromptTemplates: false` ("skip command handling" — agent-session's
 * sendUserMessage), so a "/crew-view …" sent through it never ran: while
 * streaming the inner `prompt()` threw ("Agent is already processing") with
 * the rejection swallowed, and when idle the text became a REAL user message
 * in the main session. That was the regression where "the view only changed
 * the input, everything else stayed the main session".
 *
 * Test seam: the pure routing half is exported (`dispatchViewCommandWith`).
 */
function dispatchViewCommand(text: string): void {
	// DIRECT handler invocation whenever a live command ctx is captured for
	// the CURRENT session (crew commands capture one on every run; the
	// switch helpers re-pin it via withSession). The editor submit path
	// parks text in pendingUserInputs until pi's input loop returns to
	// getUserInput() — which a live-refreshing view session rarely does —
	// stranding the command (escape then never returned to main).
	const cmdCtx = liveCommandCtx();
	if (cmdCtx) {
		if (text === "/crew-back") {
			invokeViewHandler(handleCrewBackCommand("", cmdCtx), "view.dispatch.back");
			return;
		}
		const viewMatch = /^\/crew-view (\S+) (\S+)$/.exec(text);
		if (viewMatch) {
			invokeViewHandler(handleCrewViewCommand(`${viewMatch[1]} ${viewMatch[2]}`, cmdCtx), "view.dispatch.view");
			return;
		}
	}
	dispatchViewCommandWith(currentEditor, lastPi, text);
}

/** The captured command ctx when it still belongs to the current session —
 *  the only live handle exposing switchSession for a DIRECT view invocation.
 *  Fails closed (undefined) whenever the match cannot be established. */
function liveCommandCtx(): ExtensionCommandContext | undefined {
	try {
		const currentId = lastCtx?.sessionManager?.getSessionId();
		return currentCommandCtx(currentId) as ExtensionCommandContext | undefined;
	} catch {
		return undefined;
	}
}

/** Route a view command: editor submit when mounted, sendUserMessage only as
 *  a headless fallback (it cannot execute commands — informational only). */
export function dispatchViewCommandWith(
	editor: { dispatchCommandFallback: (text: string) => void } | undefined,
	pi: unknown,
	text: string,
): void {
	if (editor) {
		try {
			editor.dispatchCommandFallback(text);
		} catch (error) {
			logInternalError("view.dispatch.editor", error, text);
		}
		return;
	}
	const sendUserMessage = (
		pi as
			| {
					sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => Promise<void>;
			  }
			| undefined
	)?.sendUserMessage;
	if (typeof sendUserMessage === "function") {
		try {
			// The extension API is FIRE-AND-FORGET: it returns void (rejections
			// are routed to the runner's error channel) — never chain on the
			// return value.
			sendUserMessage.call(pi, text);
		} catch (error) {
			logInternalError("view.dispatch", error, text);
		}
	}
}

/** How long to wait for the parent turn to settle after detaching a foreground
 *  run, before dispatching the switch anyway. */
const VIEW_SETTLE_TIMEOUT_MS = 8000;
const VIEW_SETTLE_POLL_MS = 100;

/**
 * Make the current session switchable.
 *
 * pi's `switchSession` tears the current session down through
 * `session.abort()` → `waitForIdle()`, so it CANNOT land while a FOREGROUND
 * team run keeps the parent turn streaming — the switch just hung until the
 * run finished, which is the "view opened but the screen still shows main"
 * report. Detaching the run releases the tool's waiter (the run itself keeps
 * executing and notifies on completion), the turn settles, and the switch
 * lands within a second.
 *
 * Returns false when switching would DESTROY the main conversation: pi writes
 * a session file only once the session holds an assistant message
 * (`SessionManager._persist`), and `switchSession` disposes the outgoing
 * session, so a still-unflushed main session (team run as the very first turn)
 * would vanish and `/crew-back` would fail on the missing file.
 *
 * The detach itself is kept when we refuse: the run continues in the
 * background and reports into the main session, which is where we stay.
 */
async function settleSessionForViewSwitch(ctx: ExtensionContext, runId: string): Promise<boolean> {
	const isIdle = (): boolean => {
		try {
			return ctx.isIdle?.() !== false;
		} catch {
			return true; // stale ctx — let the switch decide
		}
	};
	if (isIdle()) return mainSessionIsOnDisk(ctx);
	try {
		// LAZY: run-tracker is runtime state, not a UI dependency.
		const { detachRunPromise } = await import("../../runtime/run-tracker.ts");
		if (!detachRunPromise(runId, ctx.cwd)) return mainSessionIsOnDisk(ctx);
		// The detached tool call no longer reports the run's outcome, so the
		// result is delivered to THIS (main) session when the run finishes.
		// LAZY: detached-run-results is runtime state, not a UI dependency.
		const { markRunDetached } = await import("../../runtime/detached-run-results.ts");
		markRunDetached(runId, ctx.cwd);
	} catch (error) {
		logInternalError("view.detachForegroundRun", error, runId);
		return false;
	}
	// The awaits above (lazy imports) can straddle a session switch: the
	// session this settle started in may already be gone — the switch target
	// no longer exists, so the open is moot.
	if (!ctxAlive(ctx)) return false;
	safeNotify(ctx, "Team run detached to background so the agent view can open — its result arrives here when it finishes.", "info");
	const deadline = Date.now() + VIEW_SETTLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		// The settling turn also writes its assistant message, which is what
		// finally puts the main session on disk.
		if (isIdle() && mainSessionIsOnDisk(ctx)) return true;
		await new Promise((resolve) => setTimeout(resolve, VIEW_SETTLE_POLL_MS));
	}
	return mainSessionIsOnDisk(ctx);
}

/** Whether the main session already has a file pi can resume from. */
function mainSessionIsOnDisk(ctx: ExtensionContext): boolean {
	try {
		const file = ctx.sessionManager.getSessionFile();
		return Boolean(file) && existsSync(file as string);
	} catch {
		return false;
	}
}

/**
 * Open an agent "view" — a REAL pi session, whole-screen. No custom UI.
 *
 * Enter on an agent builds a genuine pi session file from the agent's event
 * log (`buildAgentViewSessionFile`) and switches the whole screen to it via
 * `/crew-view` → `switchSession`. Pi renders it exactly like any other
 * session: its transcript (user/assistant/tool cards, thinking blocks, usage),
 * its scrollback, its editor.
 *
 * The command is dispatched through `pi.sendUserMessage(text,
 * { expandPromptTemplates: true })`, which executes "/" commands
 * synchronously in ALL session states (streaming, tool-executing, idle). The
 * legacy editor-submit path would have been queued, because a FOREGROUND team
 * run keeps the main turn busy for its whole lifetime — that is the
 * regression where "the view only changed the input".
 *
 * The view file can only be built once the agent's event file exists (the
 * worker child pi creates it at spawn; a slow provider queue can delay that),
 * so openPane polls for up to ~20s. If it never materialises — phantom row
 * or deleted state — the user is told instead of being handed a substitute
 * (the in-document transcript pane was removed from this path: entering a
 * view must always be a full pi session).
 */
const VIEW_BUILD_RETRY_MS = 500;
const VIEW_BUILD_MAX_RETRIES = 40;

/** pi's sessions ROOT from the main session file (the view build + refresh
 *  locate the worker's own session file under it). Pi nests session files in
 *  `~/.pi/agent/sessions/--<cwd-stem>--/`, so the root is derived by walking
 *  up past the stem dir — the file's own dirname would re-join the stem and
 *  never match (regression: worker-copy silently fell back to synthesis). */
function mainSessionRoot(): string | undefined {
	const state = getCrewViewSessionState();
	const file = state.mainSessionFile ?? lastCtx?.sessionManager.getSessionFile();
	return sessionsRootFromFile(file ?? undefined);
}

/** Build the view file, retrying while the agent's event file appears.
 *  Returns undefined when the state never materialises (caller notifies). */
async function buildViewPath(ctx: ExtensionContext, target: PanelTarget): Promise<string | undefined> {
	// At open time the current session IS the main session — its file is the
	// return path AND must be excluded from the worker-session search (its
	// mtime is "now", so a time-window match alone would make the search
	// ambiguous and fall back to the events synthesis).
	const mainFile = ctx.sessionManager.getSessionFile() ?? getCrewViewSessionState().mainSessionFile;
	for (let attempt = 0; ; attempt += 1) {
		const viewPath = buildAgentViewSessionFile({
			cwd: ctx.cwd,
			runId: target.runId,
			taskId: target.taskId,
			parentSessionFile: mainFile,
			sessionRoot: mainSessionRoot(),
		});
		if (viewPath) return viewPath;
		if (attempt >= VIEW_BUILD_MAX_RETRIES) return undefined;
		await new Promise((resolve) => setTimeout(resolve, VIEW_BUILD_RETRY_MS));
	}
}

function openPane(ctx: ExtensionContext, target: PanelTarget): void {
	// One in-flight open at a time (see PendingViewOpen above): repeats get
	// feedback instead of queueing another parked "/crew-view" command.
	if (pendingViewOpen && Date.now() - pendingViewOpen.at < VIEW_OPEN_PENDING_TTL_MS) {
		safeNotify(ctx, "Already opening an agent view — one moment.", "info");
		return;
	}
	pendingViewOpen = { runId: target.runId, taskId: target.taskId, at: Date.now() };
	void (async () => {
		try {
			const viewPath = await buildViewPath(ctx, target);
			// The awaits above can straddle a session switch (a previously
			// parked command landing, /new, resume…): every ctx access from
			// here on must be guarded — see the stale-ctx section.
			if (!ctxAlive(ctx)) return;
			if (viewPath) {
				// Baseline the worker-session stamp right after the build so the
				// first refresh tick only dispatches when the worker has actually
				// produced NEW content since the copy was taken.
				const stamp = workerSessionSourceStamp({
					cwd: ctx.cwd,
					runId: target.runId,
					taskId: target.taskId,
					parentSessionFile: ctx.sessionManager.getSessionFile() ?? getCrewViewSessionState().mainSessionFile,
					sessionRoot: mainSessionRoot(),
				});
				if (stamp) viewRefreshBaseline = `${stamp.mtimeMs}:${stamp.size}`;
				// A streaming parent turn blocks switchSession — settle it first
				// (detaches a foreground run; the run keeps executing).
				if (!(await settleSessionForViewSwitch(ctx, target.runId))) {
					clearPendingViewOpen();
					safeNotify(
						ctx,
						"Cannot open the agent view yet: this session has not been saved to disk (the team run is its first turn). Wait for the first reply, then press Enter again.",
						"error",
					);
					return;
				}
				if (!ctxAlive(ctx)) return;
				// Switch AFTER the current input tick unwinds: `switchSession`
				// tears the current session down, which would invalidate the
				// editor while we are still inside its key handler otherwise.
				setTimeout(() => {
					// DIRECT handler invocation when we hold a live command ctx:
					// the editor submit path queues the command as a pending
					// input while a tool call is mid-flight (a foreground team
					// run), delaying the view by the whole turn. The pending
					// mark STAYS set in the fallback case — it is what keeps
					// further Enters from queueing more commands — and is
					// cleared when the command actually runs (its handler's
					// entry), on session_start, or by the TTL.
					const cmdCtx = liveCommandCtx();
					if (cmdCtx) {
						invokeViewHandler(handleCrewViewCommand(`${target.runId} ${target.taskId}`, cmdCtx), "view.open.dispatch");
						return;
					}
					dispatchViewCommand(`/crew-view ${target.runId} ${target.taskId}`);
				}, 0);
				return;
			}
			clearPendingViewOpen();
			safeNotify(ctx, `Could not open a view for ${target.taskId} — no transcript yet. Try again in a moment.`, "error");
		} catch (error) {
			clearPendingViewOpen();
			logInternalError("view.openPane", error, target.taskId);
		}
	})();
}

function closePane(ctx: ExtensionContext): void {
	setViewedAgent(undefined);
	// Any legacy in-document transcript pane (pre-session-view builds) is
	// cleaned up so a stale session never leaves it mounted.
	try {
		setExtensionWidget(ctx, PANE_WIDGET_KEY, undefined, { placement: PANE_PLACEMENT });
	} catch {
		/* stale ctx */
	}
	requestRender(ctx);
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
// working editor). `/crew-back` — return to the main session. The dock's enter
// key takes this path (openPane builds the file and dispatches the command),
// and typing the command works too.
//
// `switchSession` is only exposed on the extension COMMAND context (not the
// plain ExtensionContext), so the panel opens views by dispatching these
// commands through pi's immediate command-execution path instead of calling
// pi directly.

async function handleCrewViewCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	captureCommandCtx(ctx);
	// The command finally RUNNING is what ends an in-flight open (a parked
	// fallback submit executes here) — release the Enter guard. Failure paths
	// below also release it, so a refused view can be retried immediately.
	clearPendingViewOpen();
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
			sessionRoot: sessionsRootFromFile(mainSessionFile ?? currentFile ?? undefined),
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
		// Typed `/crew-view` runs INSIDE the streaming turn of a foreground run
		// (pi executes extension commands immediately). switchSession would then
		// block on waitForIdle for the whole run — settle first.
		if (!(alreadyViewing || (await settleSessionForViewSwitch(ctx, runId)))) {
			clearViewSwitchInFlight();
			setCrewViewSessionState({ ...prev, active: false });
			safeNotify(
				ctx,
				"Cannot open the agent view yet: this session has not been saved to disk (the team run is its first turn). Wait for the first reply, then try again.",
				"error",
			);
			return;
		}
		let result: { cancelled?: boolean } | undefined;
		try {
			result = await ctx.switchSession(viewPath, {
				// Pin the VIEW session's command ctx as the live one, so
				// escape / ↓-navigation can invoke /crew-back DIRECTLY. The
				// editor submit path parks text in pendingUserInputs until
				// pi's input loop returns to getUserInput(), which a
				// live-refreshing view session rarely does — a submitted
				// "/crew-back" would strand there indefinitely.
				withSession: async (viewCtx) => {
					captureCommandCtx(viewCtx);
				},
			});
		} catch (error) {
			clearViewSwitchInFlight();
			setCrewViewSessionState({ ...prev, active: false });
			safeNotify(ctx, `crew-view failed — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (result?.cancelled) clearViewSwitchInFlight();
	} catch (error) {
		clearViewSwitchInFlight();
		setCrewViewSessionState({ ...prev, active: false });
		safeNotify(ctx, `crew-view failed — ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function handleCrewBackCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	captureCommandCtx(ctx);
	// Leaving (or trying to leave) a view ends any in-flight open too.
	clearPendingViewOpen();
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
	// Do NOT clear the view state before the switch: a cancelled switch
	// (e.g. the live-refresh re-switch racing this one) would then leave the
	// user stranded IN the view with escape dead — `active` is what routes
	// escape back to /crew-back. The session_start reconcile clears it once
	// the MAIN session actually lands, which is also what prevents a stale
	// `active` flag from relabeling main as a view.
	markViewSwitchInFlight();
	try {
		const result = await ctx.switchSession(mainSessionFile, {
			// Same pinning as /crew-view: after returning to main, escape and
			// panel actions must keep a live ctx for the MAIN session.
			withSession: async (mainCtx) => {
				captureCommandCtx(mainCtx);
			},
		});
		if (result?.cancelled) clearViewSwitchInFlight();
	} catch (error) {
		clearViewSwitchInFlight();
		safeNotify(ctx, `crew-back failed — ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/** Stop the live-refresh timer (session left the view / view done). */
function stopViewAutoRefresh(): void {
	if (viewRefreshTimer) {
		clearInterval(viewRefreshTimer);
		viewRefreshTimer = undefined;
	}
	viewRefreshBaseline = undefined;
	lastViewRefreshAt = 0;
}

/**
 * Live-refresh tick: rebuild the view file from the agent's latest events and
 * re-resume the view session (pi's own session switch) whenever the content
 * actually changed. The view is a real pi session — pi only reads the file
 * when the session opens, so a snapshot alone would freeze the subagent's
 * transcript mid-work; this keeps it following the agent.
 *
 * Guards: only while a view session is active, the agent is still non-
 * terminal, the user isn't mid-draft in the editor, and no refresh was just
 * dispatched (avoid overlapping switches).
 */
async function viewRefreshTick(): Promise<void> {
	const ctx = lastCtx;
	const state = getCrewViewSessionState();
	if (!ctx || !state.active || !state.runId || !state.taskId) return stopViewAutoRefresh();
	// A view/back switch is still landing — starting ANOTHER switch now is
	// what cancels the in-flight one (escape then strands the user in the
	// view). The next tick retries.
	if (isViewSwitchInFlight()) return;
	const now = Date.now();
	if (now - lastViewRefreshAt < VIEW_REFRESH_MS - 500) return;
	// Never yank the screen away while the user is composing in the view.
	if (typeof currentEditor?.getText === "function" && currentEditor.getText() !== "") return;
	try {
		const [{ loadRunManifestById }, { agentEventsPath }] = await Promise.all([
			import("../../state/stores/state-store.ts"),
			import("../../runtime/crew-agent-records.ts"),
		]);
		const loaded = loadRunManifestById(ctx.cwd, state.runId);
		if (!loaded) return stopViewAutoRefresh();
		const task = loaded.tasks.find((candidate) => candidate.id === state.taskId);
		if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) return stopViewAutoRefresh();
		// Worker-session-backed views: only act when the SOURCE file grew
		// (copy is authoritative — a content comparison vs the rebuilt view
		// would loop on pi-appended entries the copy drops). openPane already
		// baselined the stamp at open, so the first tick after a change
		// dispatches instead of silently swallowing it.
		const stamp = workerSessionSourceStamp({
			cwd: ctx.cwd,
			runId: state.runId,
			taskId: state.taskId,
			parentSessionFile: state.mainSessionFile,
			sessionRoot: mainSessionRoot(),
		});
		if (stamp) {
			const stampKey = `${stamp.mtimeMs}:${stamp.size}`;
			if (stampKey === viewRefreshBaseline) return;
			viewRefreshBaseline = stampKey;
			lastViewRefreshAt = now;
			const refreshed = buildAgentViewSessionFile({
				cwd: ctx.cwd,
				runId: state.runId,
				taskId: state.taskId,
				parentSessionFile: state.mainSessionFile,
				sessionRoot: mainSessionRoot(),
			});
			if (refreshed) dispatchViewCommand(`/crew-view ${state.runId} ${state.taskId}`);
			return;
		}
		const viewPath = buildAgentViewSessionFile({
			cwd: ctx.cwd,
			runId: state.runId,
			taskId: state.taskId,
			parentSessionFile: state.mainSessionFile,
			sessionRoot: mainSessionRoot(),
		});
		if (!viewPath) return;
		const fresh = readFileSync(viewPath, "utf8");
		// First tick after opening: baseline only, don't re-switch a session
		// that was just opened with this exact content.
		if (viewRefreshBaseline === undefined) {
			viewRefreshBaseline = fresh;
			lastViewRefreshAt = now;
			return;
		}
		if (fresh === viewRefreshBaseline) return;
		viewRefreshBaseline = fresh;
		lastViewRefreshAt = now;
		dispatchViewCommand(`/crew-view ${state.runId} ${state.taskId}`);
	} catch {
		// Transient disk/timing — the next tick retries.
	}
}

/** Start the live-refresh timer (view session just opened). */
function startViewAutoRefresh(): void {
	if (viewRefreshTimer) return;
	viewRefreshTimer = setInterval(() => void viewRefreshTick(), VIEW_REFRESH_MS);
	viewRefreshTimer.unref?.();
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
	// …and any in-flight open is moot: its session is gone or its command ran.
	clearPendingViewOpen();
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
	// Live-refresh the view while it is the active session; stop the moment
	// the store snaps back (escape/back/resume …).
	if (getCrewViewSessionState().active && isCrewViewSessionFile(ctx.sessionManager.getSessionFile())) {
		startViewAutoRefresh();
	} else {
		stopViewAutoRefresh();
	}

	const enabled = uiConfig?.inlinePanel !== false;
	try {
		if (enabled && !editorInstalled && !ctx.ui.getEditorComponent()) {
			ctx.ui.setEditorComponent((tui, theme, kb) => {
				// Fresh instance per session; options close over the current ctx.
				const editor = new CrewInlineEditor(tui, theme, kb, {
					onOpenPane: (target) => openPane(ctx, target),
					onClosePane: () => closePane(ctx),
					onScrollPane: () => undefined,
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
			stopViewAutoRefresh();
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

/** Test seam for openPane (the panel wires it as the dock's Enter action). */
export { openPane as __test__openPane };

/** Test isolation: clear the one-open-at-a-time mark + refresh baseline. */
export function __test__resetViewOpenState(): void {
	clearPendingViewOpen();
	viewRefreshBaseline = undefined;
	lastViewRefreshAt = 0;
}
