/**
 * surface-worker.ts — worker-side surface lifecycle (spec §5.2 D7 + §5.3).
 *
 * Runs INSIDE a surface worker pane (the worker is a full pi session that also
 * loads this extension). Three independently-gated blocks, registered by
 * `registerSurfaceWorkerLifecycle` from prompt-runtime:
 *
 *   A. RECORDER (gate: PI_CREW_SURFACE + PI_CREW_AGENT_EVENTS_PATH) — a
 *      surface worker has NO stdout JSON stream (`stripHeadlessModeArgs`
 *      removes it), so nothing would reach `agents/<taskId>/events.jsonl` and
 *      the agent-view overlay would render an empty pane. The recorder
 *      subscribes the in-process session event stream instead and writes the
 *      SAME `{seq,time,event}` JSONL lines the host writes for headless
 *      workers (crew-agent-records.ts appendCrewAgentEvent), using the same
 *      compaction (compactChildPiEvent) so ONE parser — agent-transcript.ts —
 *      reads both shapes. seq is counted locally from 1: another process
 *      cannot share the host's cursor/sidecar bookkeeping.
 *
 *   B. AUTO-EXIT (gate: PI_CREW_AUTO_EXIT=1, spec D7) — when the agent run has
 *      fully settled on a naturally-finished turn and NOTHING is pending
 *      (ask / delegate / steer), append the terminal run-level event
 *      `worker.completed` FIRST (D7 ordering: report before dying) and only
 *      then shut the session down, which closes the pane.
 *
 *   C. PARENT-GUARD (gate: PI_CREW_PARENT_PID [+ surface/auto-exit context]) —
 *      a 5s poll: if the parent disappears (pid gone OR starttime mismatch —
 *      the PID-reuse Critical-4 fix) emit `worker.parent-lost` and terminate
 *      like (B) so no orphaned pane keeps burning tokens.
 *
 * The stopReason contract differs from the spec's literal wording on purpose:
 * pi normalizes provider stop reasons to StopReason = "pending"|"stop"|
 * "length"|"toolUse"|"error"|"aborted"|"deferred" (@earendil-works/pi-ai).
 * A finished task arrives as "stop"; there is no "done"/"end_turn" value
 * today, but both aliases are accepted so a future pi surfacing them keeps
 * working. error/aborted/length turns deliberately stay alive: the pane stays
 * open for inspection and the host watchdog (taskTimeoutMs / degrade path)
 * owns that lifecycle.
 *
 * Verified decisions (2026-08-26):
 *   - Shutdown uses ExtensionContext.shutdown() ("Gracefully shutdown pi and
 *     exit", pi extensions types.d.ts; interactive-mode.js binds it via
 *     shutdownHandler and process.exit(0)s after emitting session_shutdown) —
 *     the same seam pi-interactive-subagents/subagent-done.ts calls from
 *     inside handlers. process.exit(0) remains a logged last-resort fallback.
 *   - Event recording uses extension API hooks (message_end /
 *     tool_execution_start / tool_execution_end): they expose exactly what the
 *     host-side stdout bridge consumes. Tailing pi's own session file (the
 *     spec §11.2 fallback) would duplicate offsets handling for less data.
 *   - fsync is intentionally omitted: each record is one synchronous O_APPEND
 *     write of a single line and the consumer reads the same machine's page
 *     cache, so it sees the bytes immediately. fsync only matters for power
 *     loss, and a per-terminal-write fsync re-introduces the measured ~13ms
 *     stall flagged in perf round 3 for no reader-visible gain.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getCrewEnv } from "../config/env-vars.ts";
import type { ExtensionAPI } from "../extension/pi-api.ts";
import { compactChildPiEvent } from "../runtime/child-pi/child-pi-streams.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { createWorkerEventsChannel } from "./worker-events-channel.ts";

/** Worker-owned per-agent events log (prepareSurfaceSpawn derives the path). */
export const PI_CREW_AGENT_EVENTS_PATH_ENV = "PI_CREW_AGENT_EVENTS_PATH";
/** "1" → auto-exit (D7): terminate the session after the final settled turn. */
export const PI_CREW_AUTO_EXIT_ENV = "PI_CREW_AUTO_EXIT";
/** Surface kind written by prepareSurfaceSpawn ("tmux" | "herdr"). */
export const PI_CREW_SURFACE_ENV = "PI_CREW_SURFACE";
/** Parent starttime ticks (field 22 of /proc/<pid>/stat) captured at spawn. */
export const PI_CREW_PARENT_START_TIME_ENV = "PI_CREW_PARENT_START_TIME";

/** Poll cadence of the parent-guard (spec §5.2: every 5s). */
export const PARENT_GUARD_INTERVAL_MS = 5000;
/**
 * Gap between an idle-looking settled turn and the actual exit. It closes the
 * race where a steer/inbox item was being handed to the queue while the turn
 * wound down: 600ms spans one steering-file poll tick (500ms), so anything
 * durable shows up as pending (or has already started its own run) BEFORE we
 * decide to die.
 */
export const AUTO_EXIT_SETTLE_CONFIRM_MS = 600;

// ── shouldAutoExit ────────────────────────────────────────────────────────

/**
 * Stop reasons that mean "the task finished": pi's normalized `"stop"` plus
 * the two aliases the spec names (defensive forward-compat — pi never emits
 * them today).
 */
export const AUTO_EXIT_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "end_turn", "done"]);

export interface AutoExitSignals {
	/** pi StopReason of the LAST assistant message. */
	stopReason?: string | null;
	askPending?: boolean;
	delegatesRunning?: boolean;
	steersPending?: boolean;
}

/** Pure decision core of D7: exit ONLY on a natural finish with zero pending work. */
export function shouldAutoExit(signals: AutoExitSignals): boolean {
	if (typeof signals.stopReason !== "string") return false;
	if (!AUTO_EXIT_STOP_REASONS.has(signals.stopReason)) return false;
	return !signals.askPending && !signals.delegatesRunning && !signals.steersPending;
}

// ── parent liveness ───────────────────────────────────────────────────────

/**
 * Extract field 22 (starttime in clock ticks since boot) from a
 * `/proc/<pid>/stat` buffer. Paren-aware: comm (field 2) may contain spaces
 * AND closing parens, so everything up to the LAST ")" is skipped rather than
 * whitespace-split. Returns undefined for unparseable input.
 */
export function parseProcStartTick(stat: string): string | undefined {
	const lastParen = stat.lastIndexOf(")");
	if (lastParen === -1) return undefined;
	const fieldsAfterComm = stat
		.slice(lastParen + 1)
		.trim()
		.split(/\s+/);
	const raw = fieldsAfterComm[19];
	return raw && Number.isFinite(Number(raw)) ? raw : undefined;
}

/**
 * Pure parent-liveness decision.
 *   - stat unreadable → parent is GONE (/proc ENOENT means dead on Linux).
 *   - readable + expected ticks present + mismatch → PID REUSE, treat as lost.
 *   - expected ticks absent (macOS, or spawn never recorded them) →
 *     alive-with-caveat: pid-only semantics. Never kills on SIGSTOP or an
 *     unreadable clock field — a false "alive" falls back to the host
 *     watchdog, while a false "dead" kills a healthy worker.
 */
export function parentAlive(pid: number, expectedStartTime: string | undefined, readStat?: (pid: number) => string | undefined): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	const reader =
		readStat ??
		((p: number): string | undefined => {
			try {
				return fs.readFileSync(`/proc/${p}/stat`, "utf8");
			} catch {
				return undefined;
			}
		});
	let stat: string | undefined;
	try {
		stat = reader(pid);
	} catch {
		stat = undefined;
	}
	if (stat === undefined) return false;
	if (!expectedStartTime) return true;
	const observed = parseProcStartTick(stat);
	if (!observed) return true;
	return observed === expectedStartTime;
}

// ── ask/delegate activity tracking ────────────────────────────────────────

export type WorkerActivityKind = "ask" | "delegate";

export interface WorkerActivityTracker {
	begin(kind: WorkerActivityKind): void;
	end(kind: WorkerActivityKind): void;
	busy(): { askPending: boolean; delegatesRunning: boolean };
}

/** Counters backing the ask/delegate signals of shouldAutoExit. */
export function createWorkerActivityTracker(): WorkerActivityTracker {
	const counts = { ask: 0, delegate: 0 };
	return {
		begin(kind) {
			counts[kind] += 1;
		},
		end(kind) {
			counts[kind] = Math.max(0, counts[kind] - 1);
		},
		busy() {
			return { askPending: counts.ask > 0, delegatesRunning: counts.delegate > 0 };
		},
	};
}

/**
 * Wrap a tool definition so its in-flight state feeds the activity tracker.
 * The ask/delegate tools stay untouched — wrapping replaces `execute` only,
 * and a throwing execute still clears its flag via `finally`.
 */
export function trackToolActivity<TTool extends { execute: (...args: never[]) => Promise<unknown> }>(
	tool: TTool,
	tracker: WorkerActivityTracker,
	kind: WorkerActivityKind,
): TTool {
	async function trackedExecute(this: unknown, ...args: never[]): Promise<unknown> {
		tracker.begin(kind);
		try {
			return await tool.execute.apply(this, args);
		} finally {
			tracker.end(kind);
		}
	}
	return { ...tool, execute: trackedExecute };
}

// ── per-agent event recorder ──────────────────────────────────────────────

export interface AgentEventRecorderOptions {
	eventsPath: string;
	/** Default: one synchronous O_APPEND appendFileSync of the whole line. */
	appendLine?: (path: string, line: string) => void;
	now?: () => number;
	/** Default: redactSecrets — the host applies the same filter to stdout records. */
	redact?: (value: unknown) => unknown;
}

export interface RecorderStats {
	written: number;
	failed: number;
}

export interface TurnSnapshot {
	resultText: string;
	usage: Record<string, unknown>;
	stopReason: string | undefined;
}

export interface AgentEventRecorder {
	record(event: unknown): void;
	turnSnapshot(): TurnSnapshot;
	stats(): RecorderStats;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function costTotal(usage: Record<string, unknown>): number {
	const cost = record(usage.cost);
	return num(cost.total ?? usage.cost);
}

function assistantText(message: Record<string, unknown>): string {
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.flatMap((part) => {
			const item = record(part);
			return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n")
		.trim();
}

function mergeUsage(into: Record<string, unknown>, incoming: Record<string, unknown>): void {
	into.input = num(into.input) + num(incoming.input);
	into.output = num(into.output) + num(incoming.output);
	into.cacheRead = num(into.cacheRead) + num(incoming.cacheRead);
	into.cacheWrite = num(into.cacheWrite) + num(incoming.cacheWrite);
	into.cost = { total: costTotal(into) + costTotal(incoming) };
}

/**
 * Worker-side mirror of appendCrewAgentEvent: bounded `{seq,time,event}` JSONL
 * lines into the per-agent events log, counting seq locally (a separate
 * process cannot share the host's cursor/sidecar bookkeeping). Uses the exact
 * host-side compaction, so agent-transcript.ts parses headless and surface
 * logs identically. Write failures are counted, never thrown — telemetry must
 * not take down a live worker.
 */
export function createAgentEventRecorder(options: AgentEventRecorderOptions): AgentEventRecorder {
	const { eventsPath } = options;
	const now = options.now ?? Date.now;
	const redact = options.redact ?? redactSecrets;
	const appendLine =
		options.appendLine ??
		((target: string, line: string) => {
			try {
				fs.appendFileSync(target, line, "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT" || dirEnsured) throw error;
				fs.mkdirSync(path.dirname(target), { recursive: true });
				dirEnsured = true;
				fs.appendFileSync(target, line, "utf-8");
			}
		});

	// Same layout contract as the host writer: agents/<taskId>/ may not exist
	// yet (the host normally creates it via status.json — never assume). The
	// default writer creates it lazily on the first ENOENT, so injected sinks
	// (tests) and already-existing dirs never trigger filesystem side effects.
	let dirEnsured = false;

	let seq = 0;
	let lastAssistantText = "";
	let lastStopReason: string | undefined;
	const usage: Record<string, unknown> = {};
	const stats = { written: 0, failed: 0 };

	// Fold compacted events into the running turn summary backing
	// `worker.completed` (final text, cumulative usage, final stopReason).
	const observeTurnState = (compacted: Record<string, unknown>): void => {
		// Event-level usage wins over message-level (a usage-only tail record
		// carries the delta), and only one side contributes — merging both
		// would double-count pi messages that repeat their own usage.
		const eventUsage = record(compacted.usage);
		const message = record(compacted.message);
		const delta = Object.keys(eventUsage).length > 0 ? eventUsage : message.usage !== undefined ? record(message.usage) : null;
		if (delta) mergeUsage(usage, delta);

		if (message.role !== "assistant") return;
		const text = assistantText(message);
		if (text) lastAssistantText = text;
		if (typeof message.stopReason === "string") lastStopReason = message.stopReason;
		else if (typeof compacted.stopReason === "string") lastStopReason = compacted.stopReason;
	};

	return {
		record(rawEvent: unknown): void {
			const compactedValue = compactChildPiEvent(rawEvent);
			if (compactedValue === undefined) return;
			const compacted = record(compactedValue);
			observeTurnState(compacted);

			seq += 1;
			let line: string;
			try {
				line = `${JSON.stringify(redact({ seq, time: new Date(now()).toISOString(), event: compacted }))}\n`;
			} catch {
				// Unserializable payload — drop the RECORD but keep advancing seq
				// so consumers never see a duplicated id.
				stats.failed += 1;
				return;
			}
			try {
				appendLine(eventsPath, line);
				stats.written += 1;
			} catch (error) {
				stats.failed += 1;
				logInternalError("prompt-runtime.surface-recorder-write", error as Error, `eventsPath=${eventsPath}`);
			}
		},
		turnSnapshot(): TurnSnapshot {
			return { resultText: lastAssistantText, usage: { ...usage }, stopReason: lastStopReason };
		},
		stats(): RecorderStats {
			return { ...stats };
		},
	};
}

// ── wiring ────────────────────────────────────────────────────────────────

/** The slice of ExtensionContext the lifecycle relies on (kept structural so
 *  older pi runtimes degrade instead of throwing). */
interface LifecycleCtx {
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	shutdown?: () => void;
}

export interface SurfaceWorkerDeps {
	/** Env source override (tests). Production reads via getCrewEnv. */
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Per-agent JSONL append sink (tests inject a collector). */
	appendLine?: (path: string, line: string) => void;
	/** Run-level terminal-event sink (tests inject a collector). Default:
	 *  emitTerminal + immediate flush on the WP-9 worker-events channel —
	 *  flush-before-shutdown is the D7 durability order. */
	emitRunEvent?: (type: string, data: Record<string, unknown>) => void;
	/** /proc reader override for parentAlive (tests). */
	readStat?: (pid: number) => string | undefined;
	setIntervalFn?: (fn: () => void, ms: number) => unknown;
	clearIntervalFn?: (timer: unknown) => void;
	setTimeoutFn?: (fn: () => void, ms?: number) => unknown;
	clearTimeoutFn?: (timer: unknown) => void;
	/** Last-resort exit when pi hands us no shutdown-capable ctx (tests spy). */
	exit?: (code: number) => never;
	/** Shared ask/delegate counters owned by prompt-runtime (so wrapping the
	 *  tools feeds the signals even when this lifecycle is dormant). */
	activity?: WorkerActivityTracker;
}

export interface SurfaceWorkerHandle {
	recorder: AgentEventRecorder;
	activity: WorkerActivityTracker;
	/** Deferred settle confirmation, runnable early (tests). Returns whether
	 *  the terminal path fired. */
	confirmSettle(pendingOverride?: boolean): boolean;
	dispose(): void;
}

/**
 * Register all three blocks against a worker's ExtensionAPI. Returns
 * undefined when no gate is present (main user sessions and other non-team
 * contexts) so nothing is armed there.
 */
export function registerSurfaceWorkerLifecycle(
	pi: Pick<ExtensionAPI, "on">,
	deps: SurfaceWorkerDeps = {},
): SurfaceWorkerHandle | undefined {
	const get = (name: string): string | undefined => (deps.env ? deps.env[name] : getCrewEnv(name));
	const surfaceKind = get(PI_CREW_SURFACE_ENV);
	const agentEventsPath = get(PI_CREW_AGENT_EVENTS_PATH_ENV);
	const autoExitEnabled = get(PI_CREW_AUTO_EXIT_ENV) === "1";
	const parentPid = Number.parseInt(get("PI_CREW_PARENT_PID") ?? "", 10);
	const parentStartTime = get(PI_CREW_PARENT_START_TIME_ENV);

	const recorderActive = Boolean(surfaceKind && agentEventsPath);
	if (surfaceKind && !agentEventsPath) {
		// Surface without a per-agent log = an empty agent-view pane later;
		// say so now instead of debugging from the missing transcript.
		logInternalError(
			"prompt-runtime.surface-worker-config",
			new Error("PI_CREW_SURFACE set without PI_CREW_AGENT_EVENTS_PATH — recording disabled"),
			undefined,
			"warn",
		);
	}
	// The guard rides along ONLY with surface/auto-exit context: arming it for
	// every crew worker would change headless + async-run lifecycles (their
	// parents outlive the run by design), which A1 does not own.
	const guardArmed = Number.isFinite(parentPid) && parentPid > 0 && (Boolean(surfaceKind) || autoExitEnabled);
	if (!recorderActive && !autoExitEnabled && !guardArmed) return undefined;

	const now = deps.now ?? Date.now;
	const timers = {
		setInterval: deps.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms)),
		clearInterval: deps.clearIntervalFn ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>)),
		setTimeout: deps.setTimeoutFn ?? ((fn: () => void, ms?: number) => setTimeout(fn, ms)),
		clearTimeout: deps.clearTimeoutFn ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
	};

	const channel = createWorkerEventsChannel({ env: deps.env });
	const emitRunEvent =
		deps.emitRunEvent ??
		((type: string, data: Record<string, unknown>) => {
			// D7 ordering, spelled out: append the terminal event synchronously,
			// drain any queued retry buffer, THEN hand control to shutdown.
			channel.emitTerminal(type, data);
			channel.flush();
		});

	const recorder = createAgentEventRecorder({
		eventsPath: agentEventsPath ?? "",
		appendLine: deps.appendLine ?? undefined,
		now,
	});
	const activity = deps.activity ?? createWorkerActivityTracker();

	// pi hands every handler an ExtensionContext; keep the freshest one around,
	// because the parent-guard fires OUTSIDE any handler yet still needs
	// ctx.shutdown().
	let latestCtx: LifecycleCtx | undefined;
	let terminated = false;
	let confirmTimer: unknown;
	let guardTimer: unknown;

	const stopParentGuard = (): void => {
		if (guardTimer === undefined) return;
		timers.clearInterval(guardTimer);
		guardTimer = undefined;
	};
	const clearConfirmTimer = (): void => {
		if (confirmTimer === undefined) return;
		timers.clearTimeout(confirmTimer);
		confirmTimer = undefined;
	};

	const requestShutdown = (): void => {
		const shutdown = latestCtx?.shutdown;
		if (typeof shutdown === "function") {
			shutdown.call(latestCtx);
			return;
		}
		logInternalError(
			"prompt-runtime.surface-worker-shutdown",
			new Error("no ctx.shutdown() available — falling back to process.exit"),
			undefined,
			"warn",
		);
		(deps.exit ?? ((code: number) => process.exit(code)))(0);
	};

	/** Terminal path shared by auto-exit and parent-lost: report, then die. */
	const terminate = (type: string, data: Record<string, unknown>): void => {
		if (terminated) return;
		terminated = true;
		stopParentGuard();
		clearConfirmTimer();
		emitRunEvent(type, data);
		requestShutdown();
	};

	/** Deferred confirmation armed by agent_settled (runs off the 600ms window). */
	const confirmSettle = (pendingOverride?: boolean): boolean => {
		clearConfirmTimer();
		if (terminated) return false;

		// steersPending is really "the session still has work queued or
		// running": pi keeps hasPendingMessages precise, and isIdle guards the
		// case where a queued steer already STARTED its own agent run.
		const ctx = latestCtx;
		const steersPending =
			pendingOverride ?? (Boolean(ctx?.hasPendingMessages?.()) || (typeof ctx?.isIdle === "function" ? !ctx.isIdle() : false));

		const snapshot = recorder.turnSnapshot();
		if (
			!shouldAutoExit({
				stopReason: snapshot.stopReason,
				...activity.busy(),
				steersPending,
			})
		) {
			return false;
		}
		terminate("worker.completed", {
			result: snapshot.resultText,
			usage: snapshot.usage,
			stopReason: snapshot.stopReason ?? "",
		});
		return true;
	};

	if (autoExitEnabled) {
		pi.on("agent_settled", (_event, ctx) => {
			if (terminated) return;
			latestCtx = (ctx as LifecycleCtx) ?? latestCtx;
			// Anything obviously still in flight → skip; the next settled event
			// re-evaluates with fresh signals (no timer churn while asking).
			const busy = activity.busy();
			if (busy.askPending || busy.delegatesRunning || ctx.hasPendingMessages?.()) return;
			clearConfirmTimer();
			confirmTimer = timers.setTimeout(() => {
				confirmSettle();
			}, AUTO_EXIT_SETTLE_CONFIRM_MS);
		});
	}

	if (guardArmed) {
		guardTimer = timers.setInterval(() => {
			if (terminated) return;
			if (parentAlive(parentPid, parentStartTime, deps.readStat)) return;
			terminate("worker.parent-lost", { parentPid, expectedStartTicks: parentStartTime ?? "" });
		}, PARENT_GUARD_INTERVAL_MS);
		(guardTimer as { unref?: () => void })?.unref?.();
	}

	// Block A: recorder (in-process session stream → per-agent JSONL).
	if (recorderActive) {
		// message_end carries assistant + toolResult messages (usage, stopReason);
		// tool_execution_start/end carry the tool cards the pane folds them into.
		const capture = (event: unknown): void => {
			if (terminated) return;
			recorder.record(event);
		};
		pi.on("tool_execution_start", capture);
		pi.on("tool_execution_end", capture);
		pi.on("message_end", capture);
	}

	// Teardown hygiene: never leak the timers across a quit/reload/resume.
	pi.on("session_shutdown", (_event, ctx) => {
		latestCtx = (ctx as LifecycleCtx) ?? latestCtx;
		stopParentGuard();
		clearConfirmTimer();
	});

	// Capture a context EARLY: the parent-guard fires from its own timer, and
	// grabbing ctx here means the shutdown seam exists even if the parent dies
	// before the worker ever ran a turn.
	pi.on("session_start", (_event, ctx) => {
		latestCtx = (ctx as LifecycleCtx) ?? latestCtx;
	});

	return {
		recorder,
		activity,
		confirmSettle,
		dispose() {
			terminated = true;
			stopParentGuard();
			clearConfirmTimer();
		},
	};
}
