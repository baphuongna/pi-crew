import * as fs from "node:fs";
import * as path from "node:path";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { loadConfig } from "../config/config.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { withRunLockSync } from "../state/coordination/locks.ts";
import { appendEvent, appendEventFireAndForget } from "../state/event-log/event-log.ts";
import { createRunPaths, loadRunManifestById, saveRunManifestAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { errorMessage } from "../utils/guards.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { assertSafePathId } from "../utils/safe-paths.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
// Heavy runtime — lazy-loaded to avoid pulling team-runner into background-runner
// at module load time. Only needed when a background run actually starts.
import { primePeerDep } from "./peer-dep.ts";
import type { executeTeamRun as ExecuteTeamRunFn } from "./team-runner.ts";

let _cachedExecuteTeamRun: typeof ExecuteTeamRunFn | undefined;

/** Maximum runtime for a single background run before the watchdog force-aborts
 *  it. Prevents zombie background-runner processes when a team run hangs forever
 *  (e.g. a hung child Pi process, a stuck lock, or a test that spawns a run
 *  without cleanup). Default 2h — generous for legitimate long runs (research
 *  workflows, goal-loops) but catches true zombies (observed: 10h+ stale test
 *  runs). Override via PI_CREW_MAX_RUN_MS env (milliseconds). The watchdog
 *  aborts via the shared AbortController, then force-exits after a grace
 *  period in case the abort signal does not propagate to all execution paths. */
const MAX_BACKGROUND_RUN_MS = (() => {
	const env = Number.parseInt(process.env.PI_CREW_MAX_RUN_MS ?? "", 10);
	return Number.isFinite(env) && env > 0 ? env : 2 * 60 * 60 * 1000;
})();
async function executeTeamRun(...args: Parameters<typeof ExecuteTeamRunFn>): Promise<Awaited<ReturnType<typeof ExecuteTeamRunFn>>> {
	if (!_cachedExecuteTeamRun) {
		// FIX (split-scope install): prime the ESM peer dep BEFORE team-runner is
		// imported, so its transitive skill-instructions.ts can read getAgentDir()
		// from the primed cache instead of crashing on `Cannot find module`.
		await primePeerDep().catch(() => undefined);
		// LAZY: avoid pulling team-runner into background-runner at module load time.
		const mod = await import("./team-runner.ts");
		_cachedExecuteTeamRun = mod.executeTeamRun;
	}
	return _cachedExecuteTeamRun(...args);
}

import { logInternalError } from "../utils/internal-error.ts";
import { writeAsyncStartMarker } from "./async-marker.ts";
import { terminateActiveChildPiProcesses } from "./child-pi/child-pi.ts";
import { directTeamAndWorkflowFromRun } from "./direct-run.ts";
import { resolveCrewRuntime, runtimeResolutionState } from "./model/runtime-resolver.ts";
import { registryFromModelContext } from "./model/session-model.ts";
import { unregisterWorker } from "./orphan-worker-registry.ts";
import { startParentGuard, stopParentGuard } from "./parent-guard.ts";
import { expandParallelResearchWorkflow } from "./scheduling/parallel-research.ts";

/**
 * Debug logger gated behind PI_CREW_DEBUG env var. Writes to background.log
 * (console is redirected there). Eliminates log noise in normal operation
 * while keeping diagnostics available when explicitly enabled.
 */
function debugLog(message: string): void {
	if (process.env.PI_CREW_DEBUG) console.log(message);
}

/**
 * Re-hydrate the model routing inputs a detached background run cannot obtain
 * from an ExtensionContext. Absent `modelContext` (older manifests) yields an
 * empty object, preserving previous behaviour exactly.
 */
function restoredModelRouting(manifest: TeamRunManifest): {
	modelOverride?: string;
	parentModel?: string;
	modelRegistry?: { getAvailable: () => unknown[] };
} {
	const context = manifest.modelContext;
	if (!context) return {};
	const modelRegistry = registryFromModelContext(context);
	return {
		...(context.override ? { modelOverride: context.override } : {}),
		...(context.parentModel ? { parentModel: context.parentModel } : {}),
		...(modelRegistry ? { modelRegistry } : {}),
	};
}

/**
 * Heartbeat mechanism: periodically write a heartbeat file so the stale reconciler
 * can distinguish "process died" from "process still alive but quiet".
 * Without this, the reconciler relies solely on process.kill(pid, 0) which can
 * false-positive when a process is SIGKILLed and the PID hasn't been recycled yet.
 */
function startHeartbeat(stateRoot: string, eventsPath: string, runId: string): () => void {
	const heartbeatPath = path.join(stateRoot, "heartbeat.json");
	const writeHeartbeat = (): void => {
		try {
			const mem = process.memoryUsage();
			atomicWriteFile(
				heartbeatPath,
				JSON.stringify({
					pid: process.pid,
					at: Date.now(),
					runId,
					memory: {
						heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
						rssMb: Math.round(mem.rss / 1024 / 1024),
					},
				}),
			);
		} catch {
			/* ignore — best-effort */
		}
	};
	// Write immediately so the stale reconciler can use heartbeat age as liveness evidence.
	writeHeartbeat();
	const interval = setInterval(writeHeartbeat, 15_000);
	interval.unref();
	return () => clearInterval(interval);
}

/**
 * Remove macOS malloc-stack-logging vars that get inherited by child shells.
 * Without this, every subprocess prints "MallocStackLogging: can't turn off..." to stderr.
 */
function scrubProcessEnv(): void {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
}

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

/**
 * Signals the catch-all loop registers that do NOT terminate the background
 * runner (SIGWINCH = terminal resize, SIGPIPE = closed pipe, SIGCONT etc.).
 * Logging these as fatal `async.failed` poisons dead-run detection:
 * async-notifier's isAsyncTerminalEvent treats async.failed as terminal, so a
 * single benign signal (e.g. a terminal resize) would permanently disable
 * markDeadAsyncRunIfNeeded for the run. Benign signals are logged as
 * non-terminal `async.signal` instead.
 */
export const BENIGN_SIGNALS = new Set([
	"SIGWINCH",
	"SIGPIPE",
	"SIGCONT",
	"SIGTSTP",
	"SIGTTIN",
	"SIGTTOU",
	"SIGURG",
	"SIGPROF",
	"SIGVTALRM",
	"SIGALRM",
	"SIGIO",
	"SIGPWR",
]);

/**
 * Classify a caught signal as terminal (`async.failed` — the process is
 * dying) or benign (`async.signal` — the process keeps running).
 */
export function signalEventType(sig: string): "async.signal" | "async.failed" {
	return BENIGN_SIGNALS.has(sig) ? "async.signal" : "async.failed";
}

/**
 * Fire-and-forget event log for signal handlers. Extracted to module level
 * (from inside main()) so the exported SIGINT handler installer (test seam)
 * and the inline signal-handler loop inside main() can both use it.
 * Pure function of its arguments — no closure captures from main().
 */
function signalLog(sig: string, eventsPath: string): void {
	const runId = argValue("--run-id");
	if (runId && eventsPath) {
		const type = signalEventType(sig);
		appendEventFireAndForget(eventsPath, {
			type,
			runId,
			// Benign signals don't exit the runner — don't claim they do.
			message: type === "async.failed" ? `Background runner received ${sig} — exiting.` : `Background runner received ${sig}.`,
			data: { signal: sig, pid: process.pid },
		});
	}
}

/**
 * RT-2 SIGINT handler installer — exported as a test seam so integration tests
 * can exercise the REAL handler logic (process.exitCode = 130, NOT
 * process.exit(130)) without re-implementing it in a harness copy.
 *
 * Behavior is IDENTICAL to the previous inline handler in main() — pure
 * extraction, zero logic change.
 */
export function installBackgroundRunnerSigintHandler(abortController: AbortController, eventsPath: string): void {
	process.on("SIGINT", () => {
		signalLog("SIGINT", eventsPath);
		// RT-2 FIX: Mirror the CORE-7 pattern at the interrupt guard (:146-151).
		// Do NOT call process.exit(130) — it bypasses the finally/runCleanup block
		// in main(), orphaning child-pi workers (they have no parent-guard, see
		// RT-19). Setting exitCode lets the event loop drain naturally so main()'s
		// finally block runs terminateActiveChildPiProcesses + unregisterWorker.
		abortController.abort();
		stopParentGuard();
		process.exitCode = 130;
	});
}

export function startInterruptGuard(
	manifest: { runId: string; stateRoot: string; eventsPath: string },
	abortController: AbortController,
	stopParentGuard: () => void,
): () => void {
	const controlPath = path.join(manifest.stateRoot, "foreground-control.json");
	// FIX: Made configurable via PI_CREW_INTERRUPT_GUARD_INTERVAL_MS env var.
	// Default 250ms balances fast SIGINT response against filesystem overhead.
	const interruptGuardInterval = Number(process.env.PI_CREW_INTERRUPT_GUARD_INTERVAL_MS) || 250;
	// RT-4 FIX: Module-local gate so the interrupt body runs only once per
	// interrupt request. Without this, the guard re-fires every
	// interruptGuardInterval (250ms) — each tick does a full
	// terminateActiveChildPiProcesses sweep + sync appendEvent = ~4×/s steady
	// state. The ack write stops the re-fire; this gate is defense-in-depth if
	// the ack write fails (e.g. transient fs error).
	let interruptHandled = false;
	const interval = setInterval(() => {
		try {
			if (!fs.existsSync(controlPath)) return;
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
				requests?: Array<{ type: string; acknowledged?: boolean }>;
			};
			const last = parsed.requests?.at(-1);
			if (last?.type === "interrupt" && last?.acknowledged !== true) {
				// RT-4 FIX: Gate ensures the interrupt body runs only once even if
				// the synchronous ack write below fails.
				if (interruptHandled) return;
				interruptHandled = true;

				// RT-4 FIX: Write acknowledged:true back to foreground-control.json
				// SYNCHRONOUSLY. This stops the guard from re-firing on the next tick
				// (250ms). Must be sync because this is a setInterval polling callback
				// — we cannot await in a polling callback.
				try {
					const reqs = parsed.requests ?? [];
					if (reqs.length > 0) {
						reqs[reqs.length - 1].acknowledged = true;
						atomicWriteFile(controlPath, JSON.stringify(parsed, null, 2));
					}
				} catch {
					/* best-effort ack — interruptHandled gate prevents re-fire */
				}

				appendEvent(manifest.eventsPath, {
					type: "async.interrupt_detected",
					runId: manifest.runId,
					message: "Background runner detected foreground interrupt — killing child processes and exiting.",
				});
				// FIX: Terminate ALL child-pi processes IMMEDIATELY before exiting.
				// Previously this was missing, causing orphaned child processes to run forever
				// after the background-runner exited. terminateActiveChildPiProcesses sends
				// SIGTERM then SIGKILL (after HARD_KILL_MS=3s) to every active child.
				const killed = terminateActiveChildPiProcesses();
				console.log(`[background-runner] interrupt: killed ${killed} child processes`);
				// Also abort the run signal so executeTeamRun exits quickly via its signal check.
				abortController.abort();
				// Call stopParentGuard() explicitly in addition to the finally block in
				// main() — defense-in-depth ensures the guard is torn down promptly.
				stopParentGuard();
				// CORE-7 fix: Do NOT call process.exit() — it skips the finally block in
				// main() (which runs unregisterWorker + stopParentGuard), leaving a stale
				// orphan registry entry. Setting exitCode lets the event loop drain and
				// main()'s finally block run cleanup before the process exits naturally
				// with code 130.
				process.exitCode = 130;
			} else if (last) {
				console.warn(`[background-runner] Ignoring unknown foreground control request: ${last.type}`);
			}
		} catch {
			/* ignore read/parse errors */
		}
	}, interruptGuardInterval);
	interval.unref();
	return () => clearInterval(interval);
}

/**
 * CRITICAL: Node.js v24 throws on unhandled rejections by default.
 * Without this handler, any unhandled promise rejection (e.g., from cleanupTempDir,
 * terminateLiveAgentsForRun, or other async cleanup) will crash the background runner
 * BEFORE async.completed is written to the event log.
 * This causes the async notifier to falsely detect a stuck run after quietMs expires.
 */
function setupUnhandledRejectionGuard(
	state: {
		cwd?: string;
		runId?: string;
		eventsPath?: string;
	},
	abortController: AbortController,
	setExitFlag: () => void,
): void {
	process.on("unhandledRejection", (reason, promise) => {
		const message = errorMessage(reason);
		console.error("[background-runner] UNHANDLED REJECTION:", reason);
		console.error("[background-runner] Stack:", reason instanceof Error ? reason.stack : "N/A");
		try {
			if (state.eventsPath && state.runId) {
				appendEvent(state.eventsPath, {
					type: "async.failed",
					runId: state.runId,
					message: `Unhandled rejection: ${message}`,
					data: {
						reason: String(reason),
						stack: reason instanceof Error ? reason.stack : undefined,
						handled: false,
					},
				});
			}
		} catch (appendErr) {
			console.error("[background-runner] Failed to write async.failed event:", appendErr);
		}
		// FIX Issues #2& #4: Signal child processes to terminate via abortController,
		// set the exit flag so main() exits after the finally block runs cleanup.
		// Previously this called process.exit(1) directly, bypassing the finally block
		// and leaving child processes orphaned.
		abortController.abort();
		setExitFlag();
	});
}

/**
 * FIX Issue #4: Shared cleanup function called by both the finally block
 * and error handlers. This ensures consistent cleanup regardless of how
 * the process exits (normal flow, unhandled rejection, or main() exception).
 */
function runCleanup(
	stopInterruptGuard: () => void,
	stopParentGuard: () => void,
	stopHeartbeat: () => void,
	keepAlive: NodeJS.Timeout,
	watchdogTimer: NodeJS.Timeout,
	exitDueToRejection: boolean,
	eventsPath?: string,
): void {
	console.log(`[background-runner] runCleanup, exitDueToRejection=${exitDueToRejection}`);
	stopInterruptGuard();
	stopParentGuard();
	stopHeartbeat();
	// FIX: clearInterval FIRST, then kill children. This ensures the heartbeat
	// interval is always cleaned up even if terminateActiveChildPiProcesses throws.
	clearInterval(keepAlive);
	// Clear the anti-zombie watchdog so a normally-completing run does not
	// carry a pending force-exit timer into the exit path.
	clearTimeout(watchdogTimer);
	// FIX Issues #1, #2, #4: Wrap child process termination in try/catch so errors
	// don't prevent the cleanup from completing. We log but don't re-throw since
	// we're already exiting.
	let killed = 0;
	try {
		killed = terminateActiveChildPiProcesses();
	} catch (error) {
		console.log(`[background-runner] runCleanup: terminateActiveChildPiProcesses error: ${errorMessage(error)}`);
	}
	console.log(`[background-runner] runCleanup: killed ${killed} child processes`);
	// FIX Issue #5: Unregister this worker from the orphan registry on exit.
	// Previously this was only cleaned up on the next session_start cleanup cycle,
	// causing unnecessary delay in removing stale registrations.
	try {
		unregisterWorker(process.pid);
	} catch (error) {
		console.log(`[background-runner] runCleanup: unregisterWorker error: ${errorMessage(error)}`);
		if (eventsPath) {
			try {
				appendEvent(eventsPath, {
					type: "background.unregister_worker_failed",
					runId: argValue("--run-id") ?? "unknown",
					message: `unregisterWorker failed: ${errorMessage(error)}`,
					data: { pid: process.pid },
				});
			} catch {
				/* best-effort */
			}
		}
	}
	// FIX Issues #2 & #4: If an unhandled rejection occurred, exit with code 1
	// after cleanup completes. This ensures the finally block runs cleanup first,
	// then we exit with the appropriate code.
	if (exitDueToRejection) {
		process.exit(1);
	}
}

// Module-level flag: set by unhandled rejection guard and main() catch.
// Used by the module-level catch to signal that finally should call process.exit(1).
let exitDueToRejection = false;

async function main(): Promise<void> {
	// FIX: Store logFd so it can be closed on exit to prevent file descriptor leak
	let logFd: number | undefined;
	// Redirect console to background.log since stdio is "ignore" in detached mode.
	// This is the ABSOLUTE FIRST thing main() does after reading --cwd/--run-id
	// (which are required to build the log path). Any later — after heavy imports,
	// scrubProcessEnv, or signal handler setup — and JS-level crashes during those
	// steps would lose their console output.
	//
	// NOTE on native crashes: a V8 heap-OOM abort() or segfault bypasses this
	// console redirect entirely (it writes straight to the process stderr fd).
	// Those are now captured two other ways: (1) the parent drains the child's
	// stderr pipe into background.log (see async-runner.ts spawn), and (2) the
	// V8 --report-on-fatalerror flag (ON by default) writes a report file into
	// the run stateRoot. This console redirect only covers JS-level output.
	const _cwd = argValue("--cwd");
	const _runId = argValue("--run-id");
	if (_cwd && _runId) {
		// R11-2 (LOW, §ROUND 11 security hardening): assert the argv-supplied
		// runId at the argValue boundary BEFORE any path construction — the
		// background.log join would otherwise embed an untrusted runId (future
		// user-supplied --resume) → path traversal outside the run root. Throws
		// at startup for unsafe ids (intended fail-fast; placed OUTSIDE the
		// best-effort try/catch so the hardening is never silently swallowed).
		assertSafePathId("runId", _runId);
		try {
			// Use projectCrewRoot() so the background log lives next to the
			// manifest in either .crew/state/runs/ or .pi/teams/state/runs/
			// depending on the project's chosen layout (issue #29).
			const logPath = path.join(projectCrewRoot(_cwd), "state", "runs", _runId, "background.log");
			logFd = fs.openSync(logPath, "a");
			const origWrite =
				(_prefix: string) =>
				(data: unknown, ...args: unknown[]) => {
					// FIX: Never let the in-process console redirect crash the background
					// runner. If logFd is missing/invalid or the write fails, swallow the
					// error silently — losing one debug line is far better than killing the
					// scheduler (a previous version only redirected console.log/error, so
					// console.debug/.warn still wrote to the original stdout/stderr pipe
					// which is closed after the parent detaches, producing EPIPE → process
					// crash mid-workflow → runs hang at 25% forever).
					if (logFd === undefined) return;
					const msg = [data, ...args].map(String).join(" ") + "\n";
					try {
						fs.writeSync(logFd, msg);
					} catch {
						/* best-effort: never crash the scheduler over a log write */
					}
				};
			console.log = origWrite("OUT");
			console.error = origWrite("ERR");
			// FIX: Also redirect console.debug and console.warn — otherwise they still
			// hit the original stdout/stderr pipe, which is closed once the parent
			// process detaches, causing EPIPE unhandled errors that kill the scheduler.
			console.debug = origWrite("DBG");
			console.warn = origWrite("WARN");
			// FIX: Close logFd on process exit to prevent file descriptor leak
			process.on("exit", () => {
				try {
					if (logFd !== undefined) fs.closeSync(logFd);
				} catch {
					/* ignore */
				}
			});
		} catch {
			/* best-effort */
		}
	}

	// Scrub macOS malloc vars BEFORE anything else — must be clean for all child processes
	scrubProcessEnv();
	// signalLog is now defined at module level (shared by the exported SIGINT
	// handler installer and the inline signal-handler loop below).
	// BUG #17 FIX: Compute exitCodePath at module load time using args,
	// NOT by referencing `manifest` (declared inside main() and not in scope at module load).
	const exitCodePath = ((): string | undefined => {
		const cwd = argValue("--cwd");
		const runId = argValue("--run-id");
		if (!cwd || !runId) return undefined;
		// R11-2 (LOW, §ROUND 11): same argv boundary hardening as main() — this
		// IIFE runs at MODULE LOAD, so an unsafe runId throws before the runner
		// starts (intended fail-fast, matching run-import.ts:105 pattern).
		assertSafePathId("runId", runId);
		// Use projectCrewRoot() to honour the .pi/teams/ fallback (issue #29).
		return path.join(projectCrewRoot(cwd), "state", "runs", runId, "exit-code.txt");
	})();
	if (exitCodePath) {
		process.on("exit", (code) => {
			// Only log non-zero exit codes to avoid noise in exit-code.txt
			if (code === 0 || code === undefined) return;
			try {
				fs.appendFileSync(exitCodePath, `${new Date().toISOString()} exit_code=${code} pid=${process.pid}\n`);
			} catch (error) {
				logInternalError("background-runner.exit-code-write", error, `exitCodePath=${exitCodePath}`, "debug");
			}
		});
	}

	// FIX Issue #1: Load manifest and create abortController BEFORE signal handlers
	// are installed, since the handlers reference manifest.eventsPath and abortController.
	const cwd = argValue("--cwd");
	const runId = argValue("--run-id");
	if (!cwd || !runId) throw new Error("Usage: background-runner.ts --cwd <cwd> --run-id <runId>");
	// FIX Issue #3: Wrap in withRunLockSync to prevent concurrent background-runners
	// for the same runId from reading stale manifest state. If lock cannot be
	// be acquired within 5s, fail immediately rather than proceeding with stale data.
	//
	// BUGFIX (caught by E2E parallel-spawn, 2026-06-27): the lock manifest must
	// carry the REAL per-run stateRoot, NOT an empty string. lockPath() derives
	// `<stateRoot>/run.lock`, so `stateRoot: ""` collapses every concurrent
	// background-runner (different runIds, same spawn instant) onto a SINGLE
	// shared `run.lock` at cwd — 1 acquires, the rest fail-fast and die. Compute
	// the per-run stateRoot from (cwd, runId) via createRunPaths (same helper
	// resolveRunStateRoot uses internally), so each run locks its own
	// `<cwd>/.crew/state/runs/<runId>/run.lock`. Matches locks-race.test.ts.
	const bootstrapStateRoot = createRunPaths(cwd, runId).stateRoot;
	let loaded: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
	try {
		loaded = withRunLockSync({ stateRoot: bootstrapStateRoot, runId, cwd } as TeamRunManifest, () => loadRunManifestById(cwd, runId), {
			staleMs: 30_000,
		});
	} catch (lockErr) {
		throw new Error(`Failed to acquire lock for run '${runId}': ${errorMessage(lockErr)}`);
	}
	if (!loaded) throw new Error(`Run '${runId}' not found.`);
	let { manifest, tasks } = loaded;
	const abortController = new AbortController();

	process.on("SIGTERM", () => {
		// BUG #17 FIX: Handle SIGTERM for graceful shutdown. Real I/O (appendEvent) flushes io_uring state before abort to prevent corruption..
		// IMPORTANT: Perform real I/O here to flush io_uring state after EINTR.
		// Without I/O, io_uring can enter corrupted state and cause silent crash.
		// FIX Issue #3: Trigger graceful shutdown via abortController signal,
		// allowing the finally block to run and clean up child processes.
		// The io_uring I/O is still performed before abort takes effect.
		const runId = argValue("--run-id");
		if (runId && manifest.eventsPath) {
			try {
				appendEvent(manifest.eventsPath, {
					type: "async.sigterm_received_graceful_shutdown",
					runId,
					message: `SIGTERM received, graceful shutdown via abort pid=${process.pid}`,
					data: { pid: process.pid, ppid: process.ppid },
				});
			} catch {
				/* best-effort */
			}
		}
		// Trigger graceful shutdown via abort signal so finally block runs
		abortController.abort();
	});
	installBackgroundRunnerSigintHandler(abortController, manifest.eventsPath);
	// BUG #17: Catch ALL signals to identify what kills the background runner
	for (const sig of [
		"SIGHUP",
		"SIGUSR1",
		"SIGUSR2",
		"SIGPIPE",
		"SIGALRM",
		"SIGPROF",
		"SIGIO",
		"SIGPWR",
		"SIGSYS",
		"SIGURG",
		"SIGWINCH",
		"SIGCONT",
		"SIGTSTP",
		"SIGTTIN",
		"SIGTTOU",
		"SIGVTALRM",
		"SIGXCPU",
		"SIGXFSZ",
	] as const) {
		try {
			process.on(sig, () => {
				signalLog(sig, manifest.eventsPath);
			});
		} catch {
			/* some signals not supported on this platform */
		}
	}
	// Hook Node.js abort — if process.exit is called with code 1 (uncaught exception, assert failure)
	// we log it before exiting so it appears in background.log.
	// NOTE: process.exit is monkey-patched here (not using process.on('exit')) because
	// we need the log write to happen synchronously before the process actually exits.
	// process.on('exit') handlers run too late for I/O to complete reliably.
	// Wrapped in try/catch to guard against failures in the patch itself.
	try {
		const origExit = process.exit.bind(process);
		// Intercept all exit(code) calls to log them as async.exit events before exiting.
		// This surfaces uncaught exceptions / early exits that would otherwise vanish silently.
		process.exit = ((code?: number | string): never => {
			const runId2 = argValue("--run-id");
			const codeStr = code === undefined ? "<none>" : String(code);
			if (runId2 && manifest.eventsPath) {
				try {
					appendEvent(manifest.eventsPath, {
						type: "async.exit",
						runId: runId2,
						message: `Background runner exit(${codeStr}) pid=${process.pid}`,
						data: { code, pid: process.pid },
					});
				} catch {
					/* best-effort */
				}
			}
			return origExit(code);
		}) as typeof process.exit;
	} catch {
		// If patching process.exit fails (e.g. frozen process object), continue
		// without the exit log — the run will still proceed normally.
	}

	// Setup unhandled rejection guard FIRST — must be before any async operations
	// that might produce unhandled rejections during cleanup. Without this, any unhandled
	// rejection would crash the worker BEFORE async.failed events are written.
	const rejectionGuardState = {
		cwd,
		runId,
		eventsPath: manifest.eventsPath,
	};
	// FIX Issues #2& #4: Flag to signal that an unhandled rejection occurred.
	// When set, runCleanup() will ensure process.exit(1) is called after cleanup.
	exitDueToRejection = false;
	const setExitFlag = (): void => {
		exitDueToRejection = true;
	};
	setupUnhandledRejectionGuard(rejectionGuardState, abortController, setExitFlag);

	// Start parent guard — if parent is already dead, exit immediately
	const parentPid = Number(process.env.PI_CREW_PARENT_PID);
	if (parentPid > 0) startParentGuard(parentPid);
	// NOTE: intentionally no unref() — the guard keeps the event loop alive
	// to prevent premature worker exit. See parent-guard.ts:86 for rationale.

	appendEvent(manifest.eventsPath, {
		type: "async.started",
		runId: manifest.runId,
		data: { pid: process.pid },
	});
	debugLog(`[background-runner] async.started written, pid=${process.pid}`);
	writeAsyncStartMarker(manifest, {
		pid: process.pid,
		startedAt: new Date().toISOString(),
	});
	const stopHeartbeat = startHeartbeat(manifest.stateRoot, manifest.eventsPath, manifest.runId);
	const stopInterruptGuard = startInterruptGuard(manifest, abortController, stopParentGuard);
	debugLog(`[background-runner] heartbeat+interrupt guard started`);
	// NOTE: Keep-alive interval is NOT unref'd (unlike heartbeat and interrupt
	// guard intervals which ARE unref'd). This is intentional — during jiti
	// compilation of team-runner.ts, the event loop must not drain prematurely.
	// The interval is always cleared in the finally block, so the delay is
	// bounded by the 5s interval. The event loop exit is deferred at most 5s.
	const keepAlive = setInterval(() => undefined, 5000);

	// WATCHDOG (anti-zombie): if the run exceeds MAX_BACKGROUND_RUN_MS without
	// completing, abort it and force-exit. Without this, a hung team run
	// (stuck child Pi, deadlocked lock, test that never cleans up) leaves the
	// background-runner alive forever because keepAlive holds the event loop.
	// The watchdog fires once; it is cleared in the finally block via runCleanup.
	const watchdogTimer = setTimeout(() => {
		console.error(`[background-runner] WATCHDOG: run ${runId} exceeded ${MAX_BACKGROUND_RUN_MS}ms — aborting (zombie prevention)`);
		try {
			appendEvent(manifest.eventsPath, {
				type: "async.watchdog_fired",
				runId,
				message: `Run exceeded ${MAX_BACKGROUND_RUN_MS}ms and was force-aborted to prevent a zombie background-runner process.`,
				data: { maxRunMs: MAX_BACKGROUND_RUN_MS },
			});
		} catch {
			/* best-effort event log */
		}
		// Signal the finally block to exit(1) after cleanup.
		exitDueToRejection = true;
		// Abort the in-flight team run via the shared signal (propagates to
		// executeTeamRun → child-pi → kills child processes).
		abortController.abort();
		// Hard-exit safety net: if the abort does not propagate within 15s
		// (e.g. a hung native call), force-kill so the process cannot linger.
		const forceExit = setTimeout(() => {
			console.error(`[background-runner] WATCHDOG: abort did not propagate within grace period — force-exiting`);
			stopParentGuard();
			try {
				terminateActiveChildPiProcesses();
			} catch {
				/* best-effort */
			}
			process.exit(1);
		}, 15_000);
		forceExit.unref();
	}, MAX_BACKGROUND_RUN_MS);

	try {
		debugLog(`[background-runner] about to call discoverAgents`);
		const agents = allAgents(discoverAgents(cwd));
		debugLog(`[background-runner] discoverAgents done, ${agents.length} agents`);
		// Round 27 (BUG 2): openSync returned an fd that was never closed → FD
		// leak per background runner startup. Close it in a finally (matches the
		// canonical pattern in checkpoint.ts:83 and event-log.ts:582).
		try {
			const fd = fs.openSync(manifest.eventsPath, "a");
			try {
				fs.fsyncSync(fd);
			} finally {
				try {
					fs.closeSync(fd);
				} catch {
					/* best-effort */
				}
			}
		} catch {
			/* best-effort */
		} // FORCE flush so we see this before death
		// Fix round-4 CRITICAL: goal-loop and dynamic-workflow manifests use SYNTHETIC
		// team/workflow names not in discoverTeams/discoverWorkflows. The team+workflow
		// lookup below would throw "Team not found" BEFORE the runKind switch, making the
		// goal feature unreachable from background. Short-circuit the new runKinds here.
		process.env.PI_CREW_BACKGROUND_MODE = "1";
		let earlyResult: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
		let result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
		if (manifest.runKind === "goal-loop" || manifest.runKind === "dynamic-workflow") {
			debugLog(`[background-runner] short-circuiting ${manifest.runKind} (synthetic team/workflow)`);
			if (manifest.runKind === "goal-loop") {
				// LAZY: defer dynamic import of ./goal-loop-runner.ts to its call site.
				const { runGoalLoop } = await import("./goal-workflow/goal-loop-runner.ts");
				// LAZY: defer dynamic import of ./goal-state-store.ts to its call site.
				const { GoalStore } = await import("./goal-workflow/goal-state-store.ts");
				// LAZY: defer dynamic import of ../agents/discover-agents.ts to its call site.
				const { discoverAgents, allAgents } = await import("../agents/discover-agents.ts");
				const store = new GoalStore(manifest.cwd);
				const goalState = store.load(manifest.runId);
				if (!goalState)
					throw new Error(`runKind="goal-loop" but GoalLoopState '${manifest.runId}' not found (cwd=${manifest.cwd})`);
				const goalResult = await runGoalLoop({
					goalState,
					manifest,
					signal: abortController.signal,
					deps: {
						discoverAgents: (c: string) => allAgents(discoverAgents(c)),
					},
				});
				// Fix P1-1 + round-6 #5: persist terminal status reflecting the goal's actual outcome,
				// not a blanket 'completed'. Map goal state → manifest status.
				const goalStatusToRunStatus: Record<string, TeamRunManifest["status"]> = {
					achieved: "completed",
					max_turns: "completed",
					budget_exceeded: "completed",
					blocked: "blocked",
					cancelled: "cancelled",
					paused: "blocked",
					running: "running",
				};
				const runStatus = goalStatusToRunStatus[goalResult.goalState.state] ?? "completed";
				const finalGoalManifest: TeamRunManifest = {
					...goalResult.manifest,
					status: runStatus,
					updatedAt: new Date().toISOString(),
				};
				await saveRunManifestAsync(finalGoalManifest);
				earlyResult = {
					manifest: finalGoalManifest,
					tasks: goalResult.tasks,
				};
			} else {
				// LAZY: defer dynamic import of ./dynamic-workflow-runner.ts to its call site.
				const { runDynamicWorkflow } = await import("./goal-workflow/dynamic-workflow-runner.ts");
				// LAZY: defer dynamic import of ../workflows/discover-workflows.ts to its call site.
				const { allWorkflows, discoverWorkflows } = await import("../workflows/discover-workflows.ts");
				const wf = allWorkflows(discoverWorkflows(manifest.cwd)).find((w) => w.name === manifest.workflow);
				if (wf?.runtime !== "dynamic" || !wf.dynamicScript)
					throw new Error(
						`runKind="dynamic-workflow" but workflow '${manifest.workflow}' is not dynamic (runId=${manifest.runId})`,
					);
				const dwfResult = await runDynamicWorkflow({
					manifest,
					workflow: wf as import("../workflows/workflow-config.ts").DynamicWorkflowConfig,
					signal: abortController.signal,
					tokenBudget: wf.maxTokenBudget,
				});
				await saveRunManifestAsync(dwfResult.manifest);
				earlyResult = dwfResult;
			}
			console.log(`[background-runner] ${manifest.runKind} returned, status=${earlyResult.manifest.status}`);
			result = earlyResult;
		}
		if (!earlyResult) {
			debugLog(`[background-runner] calling directTeamAndWorkflowFromRun`);
			const direct = directTeamAndWorkflowFromRun(manifest, tasks, agents);
			debugLog(`[background-runner] direct done, finding team`);
			const team = direct?.team ?? allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === manifest.team);
			if (!team) throw new Error(`Team '${manifest.team}' not found.`);
			debugLog(`[background-runner] team=${team.name}, finding workflow`);
			const baseWorkflow =
				direct?.workflow ?? allWorkflows(discoverWorkflows(cwd)).find((candidate) => candidate.name === manifest.workflow);
			if (!baseWorkflow) throw new Error(`Workflow '${manifest.workflow ?? ""}' not found.`);
			debugLog(`[background-runner] workflow=${baseWorkflow.name}`);
			const workflow = expandParallelResearchWorkflow(baseWorkflow, cwd);
			debugLog(`[background-runner] loading config`);
			const loadedConfig = loadConfig(cwd);
			const runConfig =
				manifest.runConfig && typeof manifest.runConfig === "object" && !Array.isArray(manifest.runConfig)
					? (manifest.runConfig as typeof loadedConfig.config)
					: loadedConfig.config;
			const runtime = manifest.runtimeResolution
				? {
						kind: manifest.runtimeResolution.kind,
						requestedMode: manifest.runtimeResolution.requestedMode,
						available: manifest.runtimeResolution.available,
						fallback: manifest.runtimeResolution.fallback,
						steer: manifest.runtimeResolution.kind === "live-session",
						resume: manifest.runtimeResolution.kind === "live-session",
						liveToolActivity: manifest.runtimeResolution.kind === "live-session",
						transcript: manifest.runtimeResolution.kind !== "scaffold",
						reason: manifest.runtimeResolution.reason,
						safety: manifest.runtimeResolution.safety,
					}
				: await resolveCrewRuntime(runConfig);
			const runtimeResolution = manifest.runtimeResolution ?? runtimeResolutionState(runtime);
			manifest = {
				...manifest,
				runtimeResolution,
				runConfig,
				updatedAt: new Date().toISOString(),
			};
			await saveRunManifestAsync(manifest);
			appendEvent(manifest.eventsPath, {
				type: "runtime.resolved",
				runId: manifest.runId,
				message: `Runtime resolved: ${runtime.kind} safety=${runtime.safety}`,
				data: { runtimeResolution, async: true },
			});
			if (runtime.safety === "blocked")
				throw new Error(runtime.reason ?? "Child worker execution is disabled; refusing to create no-op scaffold subagents.");
			const executeWorkers = runtime.kind !== "scaffold";
			// Use ownerSessionId for workspaceId to ensure agents are only visible to the session that spawned them.
			// manifest.cwd would cause cross-session visibility since all sessions share the same project directory.
			// Mark this as background mode so task-runner writes events to background.log for debugging.
			process.env.PI_CREW_BACKGROUND_MODE = "1";
			// BUG #17: Keep-alive interval (NOT unref'd) prevents event loop from exiting
			// during jiti compilation of team-runner.ts. Without this, the event loop
			// can drain when import() blocks, causing the process to exit prematurely.
			// NOTE: abortController is already created above (before heartbeat/interrupt guard start)
			// so it is available here and its signal is passed through to executeTeamRun → child-pi.

			debugLog(`[background-runner] dispatching runKind=${manifest.runKind ?? "team-run"}`);
			try {
				// Fix round-4: goal-loop/dynamic-workflow handled by the short-circuit above.
				// This switch now only carries the traditional team-run path.
				switch (manifest.runKind ?? "team-run") {
					default: {
						// Existing "team-run" path — unchanged behavior.
						// Forward budget fields from manifest (set by team-tool/run.ts
						// from params.budgetTotal/etc.) so the team-runner's
						// checkPerTaskBudget guard actually arms.
						result = await executeTeamRun({
							manifest,
							tasks,
							team,
							workflow,
							agents,
							executeWorkers,
							limits: runConfig.limits,
							runtime,
							runtimeConfig: runConfig.runtime,
							skillOverride: manifest.skillOverride,
							// Restore the caller's model routing inputs (see RunModelContext):
							// this process has no ExtensionContext, so without these the
							// `model=` override and the inherited session model are lost and
							// every worker falls back to the first models.json entry.
							...restoredModelRouting(manifest),
							reliability: runConfig.reliability,
							workspaceId: manifest.ownerSessionId ?? manifest.cwd,
							signal: abortController.signal,
							...(manifest.budgetTotal !== undefined ? { budgetTotal: manifest.budgetTotal } : {}),
							...(manifest.budgetWarning !== undefined ? { budgetWarning: manifest.budgetWarning } : {}),
							...(manifest.budgetAbort !== undefined ? { budgetAbort: manifest.budgetAbort } : {}),
							...(manifest.budgetUnlimited !== undefined ? { budgetUnlimited: manifest.budgetUnlimited } : {}),
						});
						break;
					}
				}
				console.log(`[background-runner] executeTeamRun returned, status=${result.manifest.status}`);
			} catch (execError) {
				console.log(`[background-runner] executeTeamRun THREW: ${errorMessage(execError)}`);
				console.log(`[background-runner] stack: ${execError instanceof Error ? execError.stack : "N/A"}`);
				throw execError;
			}
		} // close if (!earlyResult) — team-run setup+execute done; earlyResult path skips to here
		manifest = result!.manifest;
		tasks = result!.tasks;
		appendEvent(manifest.eventsPath, {
			type: "async.completed",
			runId: manifest.runId,
			data: { status: manifest.status, tasks: tasks.length },
		});
		console.log(`[background-runner] async.completed written, status=${manifest.status}`);
		if (manifest.status === "failed" || manifest.status === "cancelled" || manifest.status === "blocked") process.exitCode = 1;
	} catch (error) {
		// Terminate live agents on failure too — agents are done when the run fails
		try {
			const loaded = withRunLockSync(manifest, () => loadRunManifestById(cwd, runId), { staleMs: 30_000 }); // Use withRunLockSync to prevent race with concurrent writers (e.g., stale reconciler)
			// between the read and the subsequent save.
			const manifestToUse = loaded?.manifest ?? manifest;
			if (manifestToUse) {
				// LAZY: live-agent-manager only needed on failure cleanup path; avoid module load at hot path.
				const { terminateLiveAgentsForRun } = await import("./live-session/live-agent-manager.ts");
				void terminateLiveAgentsForRun(manifestToUse.runId, "failed", appendEvent, manifestToUse.eventsPath).catch((error) =>
					logInternalError("background-runner.terminate", error, `runId=${manifestToUse.runId}`),
				);
			}
		} catch {
			/* best-effort */
		}
		const message = errorMessage(error);
		manifest = updateRunStatus(manifest, "failed", message);
		appendEvent(manifest.eventsPath, {
			type: "async.failed",
			runId: manifest.runId,
			message,
		});
		process.exitCode = 1;
		console.log(`[background-runner] catch block, error=${errorMessage(error)}`);
	} finally {
		// FIX Issue #4: Use shared runCleanup() function for consistent cleanup
		// across all exit paths (normal, unhandled rejection, main() exception).
		// FIX Issue #1: Wrap runCleanup in try/catch to ensure process.exit(1)
		// is called even if runCleanup throws unexpectedly.
		try {
			runCleanup(
				stopInterruptGuard,
				stopParentGuard,
				stopHeartbeat,
				keepAlive,
				watchdogTimer,
				exitDueToRejection,
				manifest.eventsPath,
			);
		} catch (cleanupError) {
			console.error(`[background-runner] runCleanup threw: ${errorMessage(cleanupError)}`);
		}
		// NOTE: If exitDueToRejection was set, runCleanup() already called process.exit(1)
		// so this finally block never continues past that point.
	}
}

// FIX Issue #1: Restructure so the finally block (which calls runCleanup) ALWAYS
// runs and decides when to exit. The old pattern: await main().catch((err) =>
// { process.exit(1); }) bypassed the finally block because .catch() intercepted
// the rejection and called process.exit(1) directly. If exitDueToRejection was
// already true, the finally called process.exit(1) first and .catch() was never
// reached. If exitDueToRejection was false (main() threw but unhandled rejection
// guard didn't fire), .catch() ran instead of the finally block doing the exit.
// New pattern: move await main() inside main() itself, wrapped in try/catch that
// sets exitDueToRejection so the finally block exits with code 1 after cleanup.
try {
	await main();
} catch (err) {
	console.error(`[background-runner] DEBUG: main() uncaught: ${errorMessage(err)}`);
	// FIX Issue #1: Set the flag so the finally block's runCleanup() call
	// will trigger process.exit(1) after cleanup completes. Previously this
	// called process.exit(1) directly, bypassing the finally block and leaving
	// orphaned child processes.
	exitDueToRejection = true;
	// RT-3 FIX: Startup failures (lock-fail, missing manifest, pre-try throws)
	// previously wrote NO event and left exitCode at 0. The run stayed 'queued'
	// until the stale reconciler reaped it. Now write async.failed so the
	// notifier/foreground detects the failure immediately, and set exitCode=1
	// so the process exits non-zero.
	try {
		const mCwd = argValue("--cwd");
		const mRunId = argValue("--run-id");
		if (mCwd && mRunId) {
			const mEventsPath = createRunPaths(mCwd, mRunId).eventsPath;
			appendEvent(mEventsPath, {
				type: "async.failed",
				runId: mRunId,
				message: errorMessage(err),
				data: { stack: err instanceof Error ? err.stack : undefined },
			});
		}
	} catch {
		/* best-effort — don't let event-write failure mask the original error */
	}
	process.exitCode = 1;
	// FIX: Call stopParentGuard directly here as a safety net in case the
	// finally block (which calls runCleanup→stopParentGuard) does not complete.
	// This ensures the parent guard is stopped in ALL exit paths: normal
	// completion, unhandled rejection, and fatal errors.
	stopParentGuard();
}
