import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { AgentConfig } from "../../agents/agent-config.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import { registerChildProcess, unregisterChildProcess } from "../../extension/crew-cleanup.ts";
import type { WorkerExitStatus } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecretString } from "../../utils/redaction.ts";
import { getActiveBrokerIssuer } from "../broker/broker-issuer.ts";
import { BoundedTail } from "../compaction/compact-stages/bounded-tail.ts";
import { FINAL_DRAIN_MS, HARD_KILL_MS, POST_EXIT_STDIO_GUARD_MS, RESPONSE_TIMEOUT_MS } from "./child-pi-constants.ts";
import { clearHardKillTimer, killProcessTree, registerActiveChild, unregisterActiveChild } from "./child-pi-kill.ts";
import { buildFinalChildPiSpawnOptions, prepareSpawnContext } from "./child-pi-spawn.ts";
import { ChildPiSteeringController } from "./child-pi-steering.ts";
// Internal helpers for active-child bookkeeping (extracted to child-pi-kill.ts).
import { ChildPiLineObserver } from "./child-pi-streams.ts";
// Phase 2.3: the six timer constructs moved to child-pi-timers.ts (pure motion).
import { createChildPiTimers } from "./child-pi-timers.ts";
import { runMockChildPi } from "./mock-fixtures.ts";

// ── Re-exports from child-pi-kill.ts (H-7 decomposition step 2) ──
// killProcessTree is internal (not previously exported) — keep that invariant.
export {
	killProcessPid,
	terminateActiveChildPiProcesses,
} from "./child-pi-kill.ts";
// ── Re-export from child-pi-spawn.ts (H-7 decomposition step 6) ──
// buildChildPiSpawnOptions was previously exported from child-pi.ts. Keep the
// public API surface stable by re-exporting from the new module.
// buildFinalChildPiSpawnOptions (BLOCKER 2 / S5) — composed spawn helper that
// owns the canary + filter + spread sequence; lives in child-pi-spawn.ts.
export { buildChildPiSpawnOptions, buildFinalChildPiSpawnOptions } from "./child-pi-spawn.ts";
// ── Re-export from child-pi-streams.ts (H-7 decomposition step 4) ──
export { ChildPiLineObserver } from "./child-pi-streams.ts";

import { checkCrewDepth, cleanupTempDir } from "../model/pi-args.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../process/post-exit-stdio-guard.ts";
import { classifyProcessCrash } from "../recovery/crash-classification.ts";

/** Maximum size (bytes) for the ChildPiLineObserver's line accumulation buffer.
 * When exceeded, the buffer is force-flushed to prevent unbounded memory growth
 * from chatty child processes that produce output without newlines.
 * (Constant moved to child-pi-constants.ts.) */

// Periodic cleanup of dead child process entries to prevent memory leaks.
/**
 * SEC-1: Extract a redacted stderr/stdout excerpt for embedding in lifecycle
 * events and error messages. The in-memory stdout/stderr accumulators receive
 * RAW worker output (only structurally compacted via compactChildPiEvent —
 * NOT secret-redacted), so any slice embedded into a persisted event must be
 * redacted here. Otherwise worker-emitted secrets (API keys, tokens returned
 * from a tool call) leak through diagnostic logs that bypass artifact-store
 * redaction.
 *
 * Extracted as a single helper (8 call sites were duplicating this) so the
 * redaction boundary is unit-testable directly. The real spawn error/timeout
 * paths are integration-level and NOT reachable via PI_TEAMS_MOCK_CHILD_PI
 * (the mock returns before the lifecycle-event handlers run), so a behavior
 * test must target this helper rather than the full runChildPi path.
 */
export function redactStderrExcerpt(stderr: string, maxChars: number): string {
	return redactSecretString(stderr.slice(-maxChars));
}

/**
 * B6: spawn taskkill and attach an 'error' listener. spawn() emits ENOENT/EACCES
 * asynchronously via the 'error' event (not as a throw), so an unlistened spawn
 * can crash the parent as an uncaught exception. taskkill is a standard Windows
 * binary so this is defensive, but the listener keeps failures bounded.
 */

/** Structured lifecycle event emitted by child-pi for critical transitions. */
export interface ChildPiLifecycleEvent {
	/** Event discriminator. */
	type: "spawned" | "spawn_error" | "response_timeout" | "final_drain" | "hard_kill" | "exit" | "close";
	/** Process ID when available. */
	pid?: number;
	/** Exit code for exit/close events. */
	exitCode?: number | null;
	/** Error message for error events. */
	error?: string;
	/** Stderr captured at timeout moment (for response_timeout events). */
	stderr?: string;
	/** Last N chars of stderr for error context (exit/error events). */
	stderrExcerpt?: string;
	/** Timestamp (ISO). */
	ts: string;
	/** F12: optional cause for `final_drain` events. `"stdout-quiet"` indicates
	 *  the drain was triggered by the quiet-window early-exit rather than the
	 *  default 5 s ceiling. Other drain reasons (default) leave this undefined. */
	reason?: "stdout-quiet";
	/** Phase-0 diagnostic (HB-003a): the signal that killed the child (when
	 *  available). Was previously discarded after building the error string. */
	signal?: string;
	/** Phase-0 diagnostic (HB-003a): final-drain race timing, present only on
	 *  exit events where a drain timer was armed. Surfaces the exit-null race. */
	diagnostic?: {
		finalDrainArmed: boolean;
		forcedFinalDrain: boolean;
		finalDrainFiredMonotonicMs?: number;
		finalAssistantEventMonotonicMs?: number;
		exitMonotonicMs: number;
	};
}

export interface ChildPiRunInput {
	cwd: string;
	task: string;
	agent: AgentConfig;
	model?: string;
	skillPaths?: string[];
	signal?: AbortSignal;
	transcriptPath?: string;
	onStdoutLine?: (line: string) => void;
	onJsonEvent?: (event: unknown) => void;
	onSpawn?: (pid: number) => void;
	/** Structured lifecycle events for durable logging (spawn, crash, timeout, kill, exit). */
	onLifecycleEvent?: (event: ChildPiLifecycleEvent) => void;
	maxDepth?: number;
	finalDrainMs?: number;
	/** F12: early-exit the drain when stdout has been silent for this many ms
	 *  after the final assistant event. Set to ≥ finalDrainMs to disable. */
	finalDrainQuietMs?: number;
	hardKillMs?: number;
	responseTimeoutMs?: number;
	/** Soft limit on assistant turns — inject steer at this count. */
	maxTurns?: number;
	/** Extra turns after soft limit before hard abort. Default: 5. */
	graceTurns?: number;
	/** Parent conversation context to inherit when inheritContext is true. */
	parentContext?: string;
	/** When true, prepend parentContext to the task prompt. */
	inheritContext?: boolean;
	/** Pass to pi to mark certain commands as context-excluded. Default: false */
	excludeContextBash?: boolean;
	/** pi session ID for session naming (aligns with pi-crew run ID) */
	sessionId?: string;
	/** Path to steering JSONL file for real-time steer injection. */
	steeringFile?: string;
	/** Run ID for cleanup tracking */
	runId?: string;
	/** Agent ID for cleanup tracking */
	agentId?: string;
	/** Role for tool restrictions (from role-tools.ts) */
	role?: string;
	/** Team-role thinking override (takes precedence over agent.thinking). */
	thinkingOverride?: string;
	/** Root directory for artifacts (used to validate transcriptPath). */
	artifactsRoot?: string;
	/** I5: run events JSONL path — threaded to the worker so its scratchpad
	 * execute handler can append fire-and-forget metric events. Optional;
	 * absent in non-team contexts (emission silently skipped). */
	eventsPath?: string;
	/** Phase 1 scratchpad: model-fallback attempt index (0-based) for per-attempt
	 * snapshot relativePath `scratchpad/<taskId>.attempt-<attempt>.snapshot.json`
	 * (C3). Optional — worker defaults to attempt 0 when unset (e.g. custom
	 * agent spawn outside child-executor). */
	attempt?: number;
	/**
	 * Optional broker spawn context (Phase 0 inter-pi broker). When present,
	 * `prepareSpawnContext` injects `PI_CREW_BROKER_SOCKET` and
	 * `PI_CREW_BROKER_TOKEN` into the child env (control-namespace keys,
	 * accepted by `assertOnlyControlEnvKeys`). The token is a 128-bit random
	 * value issued by the parent's CrewBroker at spawn time; it lives only
	 * in the parent's in-memory `Map<runId, token>` and in the child's env.
	 * NEVER persisted to manifest, events, mailbox, or any run-dir file.
	 */
	brokerSpawn?: { socketPath: string; token: string };
	/**
	 * Optional Phase 0 broker credentials issuer. Called only when
	 * `brokerSpawn` is not already set on the input. The default no-op
	 * issuer returns undefined, leaving the child to run without broker
	 * credentials (today's behavior — file paths remain authoritative).
	 * The production wiring passes a closure that delegates to the
	 * session's `CrewBrokerLifecycleController.issueForChild`.
	 *
	 * ADR-5 §4: the third parameter carries the child's depth for
	 * delegate-spawned grandchildren — the issuer gates token minting on
	 * `childDepth < resolved maxDepth` (see BrokerIssuer).
	 */
	brokerIssuer?: (runId: string, taskId?: string, childDepth?: number) => Promise<{ socketPath: string; token: string } | undefined>;
	/**
	 * ADR-5 §3 (governed nesting): explicit child depth for delegate-spawned
	 * grandchildren. The spawn policy computes this from the PARENT TASK
	 * RECORD (task.depth) — never from this process's env (the root has depth
	 * 0, so env-derived depth would wrongly be 1). Expressed as the parent's
	 * depth in the base env so the existing `parentDepth + 1` spawn math and
	 * the `checkCrewDepth` gate both see the parent's true depth. Undefined =
	 * normal worker spawn (unchanged env-derived behavior).
	 */
	depthOverride?: number;
	/** Base env for depth computation (defaults to process.env). Advanced —
	 * used with depthOverride by the root-side delegate handler. */
	env?: NodeJS.ProcessEnv;
}

export interface ChildPiRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
	/** RAW (uncapped) final assistant text, captured at stream-parse time BEFORE
	 *  the 16K transcript compaction. This is the AUTHORITATIVE worker output —
	 *  it becomes results/<id>.txt so downstream dependencies are not bounded by
	 *  the transcript's telemetry cap. Undefined when no assistant text was seen
	 *  (mock paths, error paths) — callers MUST fall back to transcript-derived
	 *  finalText. See research-findings/output-handling-deep-dive.md §A. */
	rawFinalText?: string;
	exitStatus?: WorkerExitStatus;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted?: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered?: boolean;
	/** #7 hardening: bounded digest of intermediate findings (last N tool results or
	 *  assistant text lines) from the run. Populated by ChildPiLineObserver so that
	 *  workers that exhaust their budget on tool calls (never emit final assistant
	 *  text) still produce a non-empty result. Consumers should prefer rawFinalText
	 *  first — this is a last-resort fallback. */
	intermediateFindings?: string;
}

// Base allowlist of non-provider env vars always passed to child workers.
// ── Transcript batching + compaction (H-7 decomposition step 1) ────────
// Extracted to ./child-pi-transcript.ts. Re-exported here to preserve the
// existing public API surface.
export {
	appendTranscript,
	compactString,
	compactValue,
	flushPendingTranscriptWrites,
	resetTranscriptBatchState,
} from "./child-pi-transcript.ts";

/** Mock-only path — real code path reuses a single observer.
 *  OPT-06 follow-up: returns a Promise so callers can await the transcript
 *  drain before resolving runChildPi. Without this, mock-mode callers that
 *  read the transcript file post-run see ENOENT (the async file handle had
 *  not yet been opened). */
async function observeStdoutChunk(input: ChildPiRunInput, text: string): Promise<void> {
	const observer = new ChildPiLineObserver(input);
	observer.observe(text);
	await observer.flush();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isFinalAssistantEvent(event: unknown): boolean {
	const obj = asRecord(event);
	if (obj?.type !== "message_end") return false;
	const message = asRecord(obj.message);
	const role = message?.role;
	if (role !== undefined && role !== "assistant") return false;
	const stopReason =
		typeof message?.stopReason === "string" ? message.stopReason : typeof obj.stopReason === "string" ? obj.stopReason : undefined;
	if (stopReason !== undefined && stopReason !== "stop") return false;
	const content = Array.isArray(message?.content) ? message.content : [];
	return !content.some((part) => asRecord(part)?.type === "toolCall");
}

export async function runChildPi(input: ChildPiRunInput): Promise<ChildPiRunResult> {
	// Phase 1 (live-session parity): prepend parent context when inheritContext is true.
	// This mirrors the effectivePrompt logic in live-session-runtime.ts so that
	// child-process workers receive the same inherited-context treatment.
	const effectiveTask =
		input.inheritContext === true && input.parentContext
			? `${input.parentContext}\n\n---\n# Child Worker Task\n${input.task}`
			: input.task;
	// ADR-5 §3 depthOverride: delegate-spawned grandchildren carry their depth
	// from the parent task RECORD. Expressed as the parent's depth in the base
	// env so BOTH the depth gate and the spawn env builder (parentDepth + 1)
	// see the parent's true depth — the root process's env (depth 0) is never
	// consulted for grandchildren.
	const depthEnv =
		input.depthOverride !== undefined
			? {
					...(input.env ?? process.env),
					PI_CREW_DEPTH: String(input.depthOverride - 1),
					PI_TEAMS_DEPTH: String(input.depthOverride - 1),
				}
			: undefined;
	const depth = checkCrewDepth(input.maxDepth, depthEnv);
	if (depth.blocked)
		return {
			exitCode: 1,
			stdout: "",
			stderr: `pi-crew depth guard blocked child worker: depth ${depth.depth} >= max ${depth.maxDepth}`,
		};
	// H3 phase 3 (2026-08-10): mock-mode fixtures extracted to mock-fixtures.ts.
	// Returns undefined when mock mode is NOT active → fall through to spawn.
	const mockResult = await runMockChildPi(input, effectiveTask, observeStdoutChunk);
	if (mockResult) return mockResult;
	// H-7 step 6: spawn/env/args preparation extracted to child-pi-spawn.ts.
	// prepareSpawnContext builds the worker args, attaches the steering file env,
	// and handles the pre-spawn abort check (returns an immediate-abort result
	// if the parent signal has already fired).
	//
	// Phase 0 broker: if the caller did not pre-fill `brokerSpawn`, ask the
	// optional issuer for one. The issuer is gated by the lifecycle controller
	// (root-session + flag); a no-op issuer yields undefined (no credentials).
	let brokerSpawn = input.brokerSpawn;
	const brokerIssuer = input.brokerIssuer ?? getActiveBrokerIssuer();
	if (!brokerSpawn && brokerIssuer && input.runId) {
		try {
			// ADR-5 §4: thread the child depth so the issuer can contain broker
			// credentials at depths that may not delegate (a child at the default
			// maxDepth=4 cap gets NO socket/token — env containment AC).
			brokerSpawn = await brokerIssuer(input.runId, input.agentId, input.depthOverride);
		} catch (error) {
			// H8 (2026-08-10): surface the silent degradation. Previously this
			// swallowed ALL issuer failures (token-rotation race, broker socket
			// down, key fetch network error) with zero observability — the child
			// spawned without broker credentials and the run just looked "slow".
			// logInternalError writes to the internal-error channel (sampled +
			// bounded); it does NOT propagate, so the child still runs without
			// broker acceleration (the durable-first invariant is preserved).
			logInternalError(
				"child-pi.broker-issuer-failed",
				error instanceof Error ? error : new Error(String(error)),
				`runId=${input.runId} agentId=${input.agentId ?? "?"} — child will spawn without broker credentials`,
			);
			brokerSpawn = undefined;
		}
	}
	const spawnPrep = prepareSpawnContext(brokerSpawn ? { ...input, brokerSpawn } : input, effectiveTask, depthEnv);
	if (spawnPrep.kind === "aborted") return spawnPrep.result;
	const { spawnSpec, mergedEnv, tempDir, builtEnv } = spawnPrep.ctx;
	try {
		return await new Promise<ChildPiRunResult>((resolve) => {
			// Compose the final SpawnOptions: canary + filter + spread are now
			// owned by buildFinalChildPiSpawnOptions (see child-pi-spawn.ts, BLOCKER 2 / S5).
			const spawnOptions = buildFinalChildPiSpawnOptions(input.cwd, mergedEnv, builtEnv, input.model);
			const child = spawn(spawnSpec.command, spawnSpec.args, spawnOptions);
			if (child.pid) {
				registerActiveChild(child.pid, child);
				input.onSpawn?.(child.pid);
				input.onLifecycleEvent?.({
					type: "spawned",
					pid: child.pid,
					ts: new Date().toISOString(),
				});
				// Register with cleanup handler for graceful shutdown (RT-11):
				// ALWAYS register — every spawned child must be visible to host-SIGTERM
				// cleanup. Use synthetic IDs when the caller omitted runId/agentId so the
				// PID is still tracked for killProcessPid on session shutdown.
				registerChildProcess(
					child.pid,
					input.runId ?? `untracked-run-${child.pid}`,
					input.agentId ?? `untracked-agent-${child.pid}`,
				);
			} else {
				input.onLifecycleEvent?.({
					type: "spawn_error",
					error: "spawn returned no pid",
					ts: new Date().toISOString(),
				});
			}
			// P0-1: O(1)-amortized bounded accumulators (segment ring) — replaces the O(n²)
			// appendBoundedTail rebuild-per-line pattern that re-scanned 512 KiB every line.
			const stdoutTail = new BoundedTail();
			const stderrTail = new BoundedTail();
			let settled = false;
			let childExited = false;
			let postExitGuardCleanup: (() => void) | undefined;
			const finalDrainMs = input.finalDrainMs ?? FINAL_DRAIN_MS;
			const hardKillMs = input.hardKillMs ?? HARD_KILL_MS;
			// Phase-0 diagnostic (HB-003a): track the final-drain race that produces
			// `exit null` for ctx.agent({disableTools:true}). These vars are READ-ONLY
			// instrumentation — no behavior change. finalDrainArmed lets the close
			// handler know a drain timer existed even after clearFinalDrainTimers() ran;
			// spawnMonotonicMs gives us relative timing to distinguish a race from a crash.
			let finalDrainArmed = false;
			// F12: monotonic timestamp of the last stdout JSON event (any event —
			// we want to know when stdout *stopped*, not when the final assistant
			// event arrived). Updated on every onJsonEvent dispatch.
			let lastStdoutActivityMonotonicMs = performance.now();
			let finalDrainFiredMonotonicMs: number | undefined;
			const spawnMonotonicMs = performance.now();
			let finalAssistantEventMonotonicMs: number | undefined;
			// FIX (Round 14): Bound the env-controlled response timeout to
			// [1_000ms, 3_600_000ms] (1s–1h) so a hostile or accidental value
			// (e.g. 1, or 999_999_999) cannot disable the timeout or cause
			// instant kills. Out-of-range values fall back to the input or
			// built-in default.
			const RESPONSE_TIMEOUT_MIN_MS = 1_000;
			const RESPONSE_TIMEOUT_MAX_MS = 3_600_000;
			const responseTimeoutEnv = Number.parseInt(getCrewEnv("PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS") ?? "", 10);
			const envInRange =
				Number.isFinite(responseTimeoutEnv) &&
				responseTimeoutEnv >= RESPONSE_TIMEOUT_MIN_MS &&
				responseTimeoutEnv <= RESPONSE_TIMEOUT_MAX_MS;
			const responseTimeoutMs = envInRange ? responseTimeoutEnv : (input.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS);
			let responseTimeoutHit = false;
			let forcedFinalDrain = false;
			let abortRequested = input.signal?.aborted === true;
			let hardKilled = false;
			const cleanupErrors: string[] = [];
			const steeringController = new ChildPiSteeringController(input.maxTurns, input.graceTurns);
			let abortDueToParentSignal = false;
			// CP-1: track whether the turn-limit hard-abort has been initiated. Once
			// true, we must NOT restart the no-response timer — the child is already
			// being killed via killProcessTree (SIGTERM → SIGKILL after 3s), and
			// restarting the timer would delay detection of a SIGTERM-ignoring child.
			// Round 27 (BUG 4): extract to a named handler so settle() can remove it.
			// The previous anonymous listener was never removed → on runs with >10
			// tasks sharing one AbortSignal (background-runner), Node emitted
			// MaxListenersExceededWarning and each leaked listener pinned the task's
			// stack frame (abortDueToParentSignal closure) in memory. { once: true }
			// only auto-removes AFTER the signal fires; on normal completion it leaks.
			const onParentAbort = (): void => {
				abortDueToParentSignal = true;
			};
			input.signal?.addEventListener("abort", onParentAbort, {
				once: true,
			});
			// Phase 2.3: the six timer constructs (noResponseTimer, finalDrainTimer,
			// hardKillTimer, safetyTimer, cancelHardKill, pollHandle) live in
			// child-pi-timers.ts. Mutable flags are shared via getters/setters so
			// the timer callbacks observe the same values as the handlers below.
			// The methods are destructured so the call sites keep their original
			// source shape (HB-003a source-contract test asserts the steering guard
			// directly precedes `restartNoResponseTimer()`).
			const {
				restartNoResponseTimer,
				clearNoResponseTimer,
				clearFinalDrainTimers,
				armFinalDrain,
				hasFinalDrainTimer,
				armCancelHardKill,
				clearAll,
			} = createChildPiTimers({
				child,
				input,
				responseTimeoutMs,
				finalDrainMs,
				hardKillMs,
				stdoutTail,
				stderrTail,
				cleanupErrors,
				getSettle: () => settle,
				redactStderrExcerpt,
				state: {
					getSettled: () => settled,
					getChildExited: () => childExited,
					setResponseTimeoutHit: (value) => {
						responseTimeoutHit = value;
					},
					getHardKilled: () => hardKilled,
					setHardKilled: (value) => {
						hardKilled = value;
					},
					setForcedFinalDrain: (value) => {
						forcedFinalDrain = value;
					},
					getLastStdoutActivityMonotonicMs: () => lastStdoutActivityMonotonicMs,
					setFinalDrainFiredMonotonicMs: (value) => {
						finalDrainFiredMonotonicMs = value;
					},
					getAbortRequested: () => abortRequested,
				},
			});
			restartNoResponseTimer();
			const lineObserver = new ChildPiLineObserver({
				...input,
				onStdoutLine: (line) => {
					if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
					stdoutTail.push(`${line}\n`);
					input.onStdoutLine?.(line);
				},
				onJsonEvent: (event) => {
					if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
					// Turn-count-based steering: soft limit steer + hard abort after graceTurns
					if (event && typeof event === "object" && !Array.isArray(event)) {
						const obj = event as Record<string, unknown>;
						if (obj.type === "turn_end") {
							// H-7 step 5: steering state machine extracted to ChildPiSteeringController.
							const action = steeringController.onTurnEnd(child.pid, child, input.steeringFile);
							if (action.kind === "hardAbort") killProcessTree(action.pid, action.child);
						}
					}
					// F12: capture monotonic timestamp BEFORE dispatching — any stdout
					// JSON event counts as activity. This lets the quiet-window
					// detection measure "time since last byte of stdout" accurately
					// regardless of what onJsonEvent does.
					lastStdoutActivityMonotonicMs = performance.now();
					input.onJsonEvent?.(event);
					if (!isFinalAssistantEvent(event) || childExited || settled || hasFinalDrainTimer()) return;
					finalAssistantEventMonotonicMs = performance.now();
					finalDrainArmed = true; // Phase-0 diagnostic: track that a drain timer was created.
					armFinalDrain();
				},
			});

			const clearPostExitGuard = (): void => {
				if (postExitGuardCleanup) {
					postExitGuardCleanup();
					postExitGuardCleanup = undefined;
				}
			};
			const clearChildPiTimeouts = (): void => {
				// R6-F1: clearAll() covers all six timer constructs
				// (incl. cancelHardKill — previously a local const inside abort()
				// that leaked past settle on short-lived children).
				clearAll();
				clearPostExitGuard();
			};

			const settle = (result: ChildPiRunResult): Promise<void> => {
				if (settled) return Promise.resolve();
				settled = true;
				clearChildPiTimeouts();
				// OPT-06 follow-up: lineObserver.flush() is now async (returns
				// Promise<void>) and drains the module-scoped transcript batch buffer
				// before resolving. We must await it before calling `resolve()`
				// below so callers that read the transcript file post-`runChildPi`
				// see all written lines. Caller invocations of `settle` from
				// sync event handlers (`child.on('close'|'exit'|'error')`,
				// safety timer) use `void settle(...)` — errors are caught and
				// logged inside, and `resolve()` only fires after the drain
				// completes, so runChildPi's outer Promise resolves with a
				// durable transcript on disk.
				return lineObserver
					.flush()
					.then(() => {
						input.signal?.removeEventListener("abort", abort);
						input.signal?.removeEventListener("abort", onParentAbort);
						try {
							cleanupTempDir(tempDir);
						} catch (error) {
							cleanupErrors.push(error instanceof Error ? error.message : String(error));
						}
						// Catch all errors from settle to prevent unhandled rejection from propagating
						try {
							resolve({
								...result,
								rawFinalText: lineObserver.getRawFinalText(),
								intermediateFindings: lineObserver.getIntermediateFindings(),
								exitStatus: result.exitStatus ?? {
									exitCode: result.exitCode,
									cancelled: abortRequested,
									timedOut: responseTimeoutHit,
									killed: hardKilled,
									// Phase-0 diagnostic (HB-003a): surface the final-drain race state.
									// finalDrainArmed lets Phase 1 decide whether a signal-death (exitCode=null)
									// should be treated as a forced final drain. READ-ONLY for now.
									...(finalDrainArmed || forcedFinalDrain
										? {
												finalDrainArmed,
												forcedFinalDrain,
												finalDrainFiredMonotonicMs,
											}
										: {}),
									cleanupErrors,
									finalDrainMs,
								},
							});
						} catch (resolveError) {
							logInternalError(
								"child-pi.settle-resolve",
								resolveError,
								`result=${JSON.stringify({ exitCode: result.exitCode })}`,
							);
						}
					})
					.catch((flushError) => {
						// Drain failed — log and still resolve so runChildPi doesn't hang.
						logInternalError(
							"child-pi.settle-flush-failed",
							flushError,
							`result=${JSON.stringify({ exitCode: result.exitCode })}`,
						);
						input.signal?.removeEventListener("abort", abort);
						input.signal?.removeEventListener("abort", onParentAbort);
						try {
							cleanupTempDir(tempDir);
						} catch (error) {
							cleanupErrors.push(error instanceof Error ? error.message : String(error));
						}
						try {
							resolve({
								...result,
								rawFinalText: lineObserver.getRawFinalText(),
								intermediateFindings: lineObserver.getIntermediateFindings(),
								exitStatus: result.exitStatus ?? {
									exitCode: result.exitCode,
									cancelled: abortRequested,
									timedOut: responseTimeoutHit,
									killed: hardKilled,
									...(finalDrainArmed || forcedFinalDrain
										? {
												finalDrainArmed,
												forcedFinalDrain,
												finalDrainFiredMonotonicMs,
											}
										: {}),
									cleanupErrors,
									finalDrainMs,
								},
							});
						} catch (resolveError) {
							logInternalError(
								"child-pi.settle-resolve",
								resolveError,
								`result=${JSON.stringify({ exitCode: result.exitCode })}`,
							);
						}
					});
			};

			const abort = (): void => {
				abortRequested = true;
				clearNoResponseTimer();
				killProcessTree(child.pid, child);
				if (process.platform !== "win32") {
					trySignalChild(child, "SIGTERM");
				}
				try {
					child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				} catch {
					// Ignore kill races.
				}
				// 3.5 — fast-escalate to SIGKILL within 200ms on explicit cancel
				// so /team-cancel completes round-trip well under the operator
				// expectation. The standard finalDrainMs / HARD_KILL_MS paths
				// are for graceful drain, not user-initiated cancel. R6-F1: the
				// timer handle is owned by child-pi-timers.ts and cleared by
				// clearAll() on settle (was previously an unreachable local const).
				armCancelHardKill();
			};

			input.signal?.addEventListener("abort", abort, { once: true });
			// 3.1 — soft watermark backpressure. When inbound stdout exceeds
			// 256KB before the next macrotask, pause for 50ms so the line
			// observer + ancillary handlers get to drain. Prevents the runaway
			// case where a chatty child saturates the parent event loop.
			const BACKPRESSURE_HIGH = 256 * 1024;
			let backpressureBytes = 0;
			const releaseBackpressure = (): void => {
				backpressureBytes = 0;
				try {
					child.stdout?.resume();
				} catch {
					/* ignore */
				}
			};
			child.stdout?.on("data", (chunk: Buffer) => {
				if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
				const text = chunk.toString("utf-8");
				backpressureBytes += text.length;
				try {
					lineObserver.observe(text);
				} catch (err) {
					logInternalError("child-pi.line-observer-observe", err, `text=${text.slice(0, 100)}`);
				}
				if (backpressureBytes > BACKPRESSURE_HIGH && child.stdout && !child.stdout.isPaused()) {
					try {
						child.stdout.pause();
					} catch {
						/* ignore */
					}
					const timer = setTimeout(releaseBackpressure, 50);
					timer.unref();
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
				stderrTail.push(chunk.toString("utf-8"));
			});
			child.on("error", (error) => {
				// P0-1: snapshot the bounded accumulators once for this handler.
				const stdout = stdoutTail.value();
				const stderr = stderrTail.value();
				// SEC-1: redact stderr secrets embedded in the error message + excerpt.
				const processError = new Error(
					`Child Pi process error: ${error.message}. Stderr: ${redactStderrExcerpt(stderr, 500) || "(none)"}`,
				);
				try {
					input.onLifecycleEvent?.({
						type: "spawn_error",
						pid: child.pid,
						error: processError.message,
						ts: new Date().toISOString(),
						stderrExcerpt: redactStderrExcerpt(stderr, 500) || undefined,
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=error, pid=${child.pid}`);
				}
				void settle({
					exitCode: null,
					stdout,
					stderr,
					error: processError.message,
					exitStatus: {
						exitCode: null,
						cancelled: abortRequested,
						timedOut: responseTimeoutHit,
						killed: false,
						cleanupErrors,
						finalDrainMs,
						crashClass: classifyProcessCrash({
							exitCode: null,
							cancelled: abortRequested,
							timedOut: responseTimeoutHit,
							spawnError: error,
							stderrSnippet: stderr ? redactStderrExcerpt(stderr, 1000) : undefined,
						}).crashClass,
					},
				});
			});
			child.on("exit", (code, signal) => {
				// P0-1: snapshot the bounded stderr accumulator once for this handler.
				const stderr = stderrTail.value();
				if (child.pid) {
					unregisterActiveChild(child.pid);
					clearHardKillTimer(child.pid);
					// Unregister from cleanup handler
					unregisterChildProcess(child.pid);
				}
				// Build comprehensive exit error for unexpected exits
				// Round-10 test fix: also require non-zero exit code OR a known abnormal condition.
				// Previously fired "exited unexpectedly" on every clean exit (code=0) because the
				// OS-level 'exit' event fires BEFORE pi's 'agent_end' JSON event reaches the line
				// observer (race). Worker actually succeeded but onLifecycleEvent reported an error.
				const abnormalExit = code !== 0 && code !== null;
				const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested && abnormalExit;
				const exitError = isUnexpectedExit
					? new Error(
							`Child Pi process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}). ` +
								`Stderr: ${redactStderrExcerpt(stderr, 1000) || "(none)"}`,
						)
					: null;
				try {
					// Phase-0 diagnostic (HB-003a): capture signal + drain timing in the
					// exit lifecycle event so the exit-null race is diagnosable instead of
					// opaque. `signal` was previously discarded after building the error msg.
					input.onLifecycleEvent?.({
						type: "exit",
						pid: child.pid,
						exitCode: code,
						ts: new Date().toISOString(),
						error: exitError?.message,
						stderrExcerpt: isUnexpectedExit ? redactStderrExcerpt(stderr, 1000) || undefined : undefined,
						// Phase-0 diagnostic fields (kept optional — no type change required).
						...(signal ? { signal } : {}),
						...(finalDrainArmed || forcedFinalDrain
							? {
									diagnostic: {
										finalDrainArmed,
										forcedFinalDrain,
										finalDrainFiredMonotonicMs,
										finalAssistantEventMonotonicMs,
										exitMonotonicMs: performance.now() - spawnMonotonicMs,
									},
								}
							: {}),
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=exit, pid=${child.pid}`);
				}
				childExited = true;
				clearNoResponseTimer();
				clearFinalDrainTimers();
				if (!postExitGuardCleanup) {
					postExitGuardCleanup = attachPostExitStdioGuard(child, {
						idleMs: POST_EXIT_STDIO_GUARD_MS,
						hardMs: HARD_KILL_MS,
					});
				}
			});
			child.on("close", (exitCode) => {
				// P0-1: snapshot the bounded accumulators once for this handler.
				const stdout = stdoutTail.value();
				const stderr = stderrTail.value();
				if (child.pid) {
					unregisterActiveChild(child.pid);
					clearHardKillTimer(child.pid);
					// Unregister from cleanup handler
					unregisterChildProcess(child.pid);
				}
				try {
					input.onLifecycleEvent?.({
						type: "close",
						pid: child.pid,
						exitCode,
						ts: new Date().toISOString(),
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=close, pid=${child.pid}`);
				}
				const timeoutError =
					responseTimeoutHit && !stderr.trim()
						? {
								error: `Child Pi produced no new output for ${responseTimeoutMs}ms; process was terminated as unresponsive.`,
							}
						: responseTimeoutHit && stderr.trim()
							? {
									error: `Child Pi timed out after ${responseTimeoutMs}ms with stderr: ${redactStderrExcerpt(stderr, 500)}`,
								}
							: undefined;
				// M6 fix: log when forced final drain converts non-zero exit to 0.
				// This is expected in normal operation (child finished cleanly but linger was killed),
				// but the telemetry helps detect regressions where crashes are hidden.
				if (forcedFinalDrain && !timeoutError && exitCode !== 0) {
					logInternalError(
						"child-pi.final-drain-zero-exit",
						new Error(`Child exit code overridden to 0 after forced final drain (original=${exitCode})`),
						`pid=${child.pid}, finalDrainMs=${finalDrainMs}`,
					);
				}
				const finalExitCode = forcedFinalDrain && !timeoutError ? 0 : exitCode;
				const wasGraceAborted =
					steeringController.isSoftLimitReached() &&
					steeringController.getTurnCount() >=
						(steeringController.getMaxTurns() ?? 0) + (steeringController.getGraceTurns() ?? 5);
				const wasParentAborted = abortDueToParentSignal && !wasGraceAborted;
				// P0 crash taxonomy: classify the exit so callers/dashboards can bucket
				// failure modes (timeout vs cancel vs native panic vs signal …).
				// The classifier is a pure function; this is the single integration point.
				const crashClassification = classifyProcessCrash({
					exitCode: finalExitCode,
					signal: child.signalCode ?? undefined,
					cancelled: abortRequested,
					timedOut: responseTimeoutHit,
					killed: hardKilled,
					spawnError: undefined,
					stderrSnippet: stderr ? redactStderrExcerpt(stderr, 1000) : undefined,
				});
				void settle({
					exitCode: finalExitCode,
					stdout,
					stderr,
					...(timeoutError ? { error: timeoutError.error } : {}),
					aborted: wasGraceAborted || wasParentAborted,
					steered: steeringController.isSoftLimitReached() && !wasGraceAborted,
					exitStatus: {
						exitCode: finalExitCode,
						cancelled: abortRequested,
						timedOut: responseTimeoutHit,
						killed: hardKilled,
						cleanupErrors,
						finalDrainMs,
						crashClass: crashClassification.crashClass,
					},
				});
			});
		});
	} finally {
		// cleanupTempDir is already called inside settle(), but guard against
		// the case where settle() was never reached (spawn throws synchronously).
		if (tempDir && fs.existsSync(tempDir)) {
			cleanupTempDir(tempDir);
		}
	}
}
