/**
 * child-pi-rpc.ts — U14 (upgrade-spec 2026-10-09): child-pi protocol v2 —
 * `--mode rpc` transport.
 *
 * Replaces the `--mode json -p` stdio contract with pi's maintained RPC
 * channel (JSONL over stdio, 33 commands — PoC CONFIRMED round 8, live-verified
 * round 9/10 on 1.0.4 + 1.1.0). The WIRE is owned by the SDK's `RpcClient`
 * (imported from the package — never hand-rolled here); this module owns the
 * pi-crew integration concerns only:
 *
 *   - spawn: RpcClient spawns `node <absolute cliPath> --mode rpc <flags>`.
 *     cliPath MUST be the ABSOLUTE bundle entry (`dist/bundle/cli.js`,
 *     resolved via getPiSpawnCommand — the RpcClient default `dist/cli.js` is
 *     RELATIVE and cold-boots through jiti at ~11.7s, PoC nuance 2).
 *   - env: pi-crew's allowlist model (per-task key scoping + secret scrubbing
 *     via buildFinalChildPiSpawnOptions) is PRESERVED — RpcClient merges
 *     `{...process.env, ...options.env}` at spawn time, so the start helper
 *     splices `process.env` for the SYNCHRONOUS spawn prefix of start() and
 *     restores it before any other host code can run (single JS thread).
 *   - prompt: ALWAYS carries streamingBehavior ("followUp") — a prompt while
 *     streaming WITHOUT it is a live protocol error (verify round 9 P2);
 *     clear_queue runs BEFORE every prompt so a stale idle-steer receipt
 *     (steer on an idle agent QUEUES instead of erroring — PoC nuance 1)
 *     can never inject into the next run.
 *   - steer: the soft turn-limit advisory rides `client.steer()` (receipt
 *     `disposition: started|queued|handled`), GATED by isStreaming — same
 *     nuance 1 hazard as above. The hard turn-limit stays killProcessTree.
 *   - events: RpcClient.onEvent feeds the SAME ChildPiLineObserver pipeline
 *     as json stdout (observeEvent), minus `extension_ui_request` /
 *     `extension_ui_response` spam from host extensions (filtered by type at
 *     this consumer — PoC nuance 6). There is NO readiness signal: the first
 *     response can take ~3.4s (host extension load) and every timer here
 *     already tolerates that (response-timeout floor is minutes, RpcClient
 *     send timeout is 30s — PoC nuance 3).
 *   - lifecycle: the six watchdog timer constructs (child-pi-timers.ts),
 *     kill-tree (child-pi-kill.ts), active-child + cleanup registration, the
 *     settle/crash-classification contract, and session tail-recovery are the
 *     SAME constructs the json branch uses (bảng KHÔNG đổi §0). Completion
 *     maps `agent_settled` → graceful stdin-close (PoC: orderly dispose, exit
 *     0 in ~73ms) with the final-drain SIGTERM ceiling as backstop; abort
 *     fires the graceful `client.abort()` receipt AND the existing
 *     kill-tree escalation unchanged.
 *   - pool (PHASE 1, default OFF via PI_CREW_CHILD_PI_POOL): consecutive
 *     tasks of the same agent may REUSE a live idle rpc process (1 process =
 *     1 session, MANY prompts — PoC proven). Phase-1 limitation: per-run env
 *     control vars (broker token, steering file, scratchpad gates) are pinned
 *     at first spawn; argv flags apply only to the first task.
 *
 * Mode selection: PI_CREW_CHILD_PI_MODE=rpc opts a spawn into this transport
 * (json remains the default until the wave-2 full-suite gate flips it — the
 * flag is the "json fallback" regression lever for BOTH directions).
 *
 * Process-group note (→ U15): RpcClient spawns WITHOUT detached/setsid, so
 * killProcessPid's negative-pgid fast path falls back to a direct pid kill
 * (ESRCH on the missing group). Child-of-child tree reaping via process-group
 * ownership is U15's dedicated spec, not changed here.
 */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getCrewEnv, getCrewEnvBool } from "../../config/env-vars.ts";
import { registerChildProcess, unregisterChildProcess } from "../../extension/crew-cleanup.ts";
import type { WorkerExitStatus } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecretString } from "../../utils/redaction.ts";
import { BoundedTail } from "../compaction/compact-stages/bounded-tail.ts";
import { cleanupTempDir } from "../model/pi-args.ts";
import { getPiSpawnCommand } from "../pi-spawn.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../process/post-exit-stdio-guard.ts";
import { classifyProcessCrash } from "../recovery/crash-classification.ts";
import type { ChildPiRunInput, ChildPiRunResult } from "./child-pi.ts";
import { FINAL_DRAIN_MS, HARD_KILL_MS, POST_EXIT_STDIO_GUARD_MS, resolveResponseTimeoutMs } from "./child-pi-constants.ts";
import { clearHardKillTimer, killProcessTree, registerActiveChild, unregisterActiveChild } from "./child-pi-kill.ts";
import { buildFinalChildPiSpawnOptions, type SpawnContext } from "./child-pi-spawn.ts";
import { ChildPiSteeringController, STEER_WRAP_UP_MESSAGE } from "./child-pi-steering.ts";
import { ChildPiLineObserver, isFinalAssistantEvent } from "./child-pi-streams.ts";
import { createChildPiTimers } from "./child-pi-timers.ts";
import {
	type deriveSessionPaths,
	recoverLastAssistantFromSession,
	type SessionRecoveryInfo,
	shouldAttemptSessionRecovery,
} from "./session-recovery.ts";

/**
 * RpcClient surface used by this module. The runtime class arrives via a LAZY
 * dynamic import (SDK value-import house policy for src/runtime, see
 * session-recovery.ts). `process` is a PUBLIC field on the runtime class but
 * PRIVATE in the SDK .d.ts — PoC nuance 4 (stop() drops the exit code, so the
 * lifecycle must read client.process directly) is therefore exercised through
 * an explicit structural cast at the read site, not through this interface.
 */
type RpcClientInstance = {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	getStderr(): string;
	prompt(message: string, images?: unknown[], streamingBehavior?: "steer" | "followUp"): Promise<string>;
	steer(message: string, images?: unknown[]): Promise<{ success?: boolean; data?: { disposition?: string } }>;
	followUp(message: string, images?: unknown[]): Promise<{ success?: boolean; data?: { disposition?: string } }>;
	abort(): Promise<void>;
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
};

/**
 * U14 PoC nuance 6: host extensions emit `extension_ui_request` (×11 in the
 * PoC) and the `extension_ui_response` subprotocol echo that a headless
 * consumer can never answer — drop them BY TYPE here so they never reach the
 * observer/transcript. The ask-gate wiring (U14 change #3, spec acceptance)
 * re-opens this set deliberately when that lands.
 */
export const RPC_DROPPED_EVENT_TYPES: ReadonlySet<string> = new Set(["extension_ui_request", "extension_ui_response"]);

/** PI_CREW_CHILD_PI_MODE=rpc selects this transport (json default phase 1). */
export function resolveChildPiRpcMode(): boolean {
	return getCrewEnv("PI_CREW_CHILD_PI_MODE") === "rpc";
}

/** PI_CREW_CHILD_PI_POOL=1 opts into warm rpc process reuse (default OFF). */
export function resolveChildPiRpcPoolEnabled(): boolean {
	return getCrewEnvBool("PI_CREW_CHILD_PI_POOL") === true;
}

/**
 * Derive the RpcClient argv from the json-mode worker argv: strip the leading
 * `--mode json -p` cluster (RpcClient prepends `--mode rpc` itself) and the
 * trailing `@task.md` positional (the task text rides the `prompt` command —
 * stdin JSONL is not world-readable like argv, so the G3 spill rationale does
 * not apply). Every other flag (session identity, model, hermetic/extension
 * gates, trust pin, tool cuts) applies to rpc mode identically.
 */
export function buildRpcClientArgs(builtArgs: string[]): string[] {
	let args = builtArgs;
	if (args[0] === "--mode" && args[1] === "json") {
		args = args.slice(args[2] === "-p" ? 3 : 2);
	}
	const last = args[args.length - 1];
	if (typeof last === "string" && last.startsWith("@")) {
		args = args.slice(0, -1);
	}
	return args;
}

/**
 * Resolve the ABSOLUTE pi cli script for RpcClient's `cliPath` (PoC nuance 2:
 * the RpcClient default `dist/cli.js` is RELATIVE — jiti cold boot ~11.7s).
 * getPiSpawnCommand already resolves the installed package's bundle entry
 * (`dist/bundle/cli.js`, honoring PI_TEAMS_PI_BIN). When resolution falls back
 * to the bare `pi` PATH command there is no absolute script to hand over →
 * undefined → the caller stays on the json transport (fail-safe, logged).
 */
export function resolveRpcCliPath(): string | undefined {
	const spec = getPiSpawnCommand([]);
	if (spec.command === process.execPath && spec.args[0] && path.isAbsolute(spec.args[0])) {
		return spec.args[0];
	}
	return undefined;
}

// ── Worker process pool (phase 1, opt-in) ────────────────────────────────

interface RpcPoolEntry {
	client: RpcClientInstance;
	proc: ChildProcess;
	/** True while the pooled process is idle between runs (reusable). */
	idle: boolean;
}

const rpcPool = new Map<string, RpcPoolEntry>();

function poolKeyFor(input: ChildPiRunInput): string {
	return input.agentId ?? input.agent.name;
}

/**
 * Take a pooled client for reuse when it is alive AND idle. Dead/busy entries
 * are evicted (a busy process belongs to a run that never settled — the
 * watchdog owns it; a fresh spawn is safer than waiting on it).
 */
function acquirePooledRpcClient(key: string): RpcPoolEntry | undefined {
	const entry = rpcPool.get(key);
	if (!entry) return undefined;
	const stdin = entry.proc.stdin;
	const alive = entry.proc.exitCode === null && entry.proc.signalCode === null && !!stdin && !stdin.destroyed && entry.idle;
	if (!alive) {
		rpcPool.delete(key);
		void entry.client.stop().catch(() => {
			/* eviction best-effort — the kill-tree/watchdog owns the rest */
		});
		return undefined;
	}
	entry.idle = false;
	return entry;
}

/** Mark a pooled entry idle again after its run settled (process stays live). */
function releasePooledRpcClient(key: string, entry: RpcPoolEntry): void {
	if (rpcPool.get(key) === entry) entry.idle = true;
}

/** Drop every pooled entry and gracefully stop the processes (tests/shutdown). */
export function clearRpcPool(): void {
	for (const [, entry] of rpcPool) {
		void entry.client.stop().catch(() => {
			/* best-effort */
		});
	}
	rpcPool.clear();
}

// ── Run orchestrator ─────────────────────────────────────────────────────

export interface ChildPiRpcRunPlan {
	input: ChildPiRunInput;
	/** Task text after inherit-context prepend — delivered via the prompt command. */
	effectiveTask: string;
	/** Spawn context from prepareSpawnContext (args/env/tempDir). */
	ctx: SpawnContext;
	/** W2 session identity for crash-path tail recovery (already on argv). */
	workerSession: ReturnType<typeof deriveSessionPaths> | undefined;
	sessionRecoveryEnabled: boolean;
}

/**
 * RPC transport entry point. Returns a settled result, or null when rpc
 * cannot run here (no absolute cli script) so the caller keeps the json path.
 */
export async function tryChildPiRpcRun(plan: ChildPiRpcRunPlan): Promise<ChildPiRunResult | null> {
	const cliPath = resolveRpcCliPath();
	if (!cliPath) {
		logInternalError(
			"child-pi.rpc-cli-unresolved",
			new Error("no absolute pi cli script for RpcClient — staying on json transport"),
			`spawnCommand=${getPiSpawnCommand([]).command}`,
			"warn",
		);
		return null;
	}
	// SDK value import (src/runtime house policy — session-recovery.ts header).
	// The host process already has the module cached, so the dynamic import
	// resolves in ~0ms; only a cold standalone test pays module load.
	// LAZY: registered with scripts/check-lazy-imports.mjs (runtime dynamic import)
	const { RpcClient } = await import("@earendil-works/pi-coding-agent");
	const pooled = resolveChildPiRpcPoolEnabled() ? acquirePooledRpcClient(poolKeyFor(plan.input)) : undefined;
	const Ctor = RpcClient as unknown as new (options: unknown) => RpcClientInstance;
	return runRpcSession(Ctor, plan, cliPath, pooled);
}

/** Local SEC-1 twin of child-pi.ts redactStderrExcerpt (cycle-free import). */
function redactExcerpt(stderr: string, maxChars: number): string {
	return redactSecretString(stderr.slice(-maxChars));
}

async function runRpcSession(
	RpcClientCtor: new (options: unknown) => RpcClientInstance,
	plan: ChildPiRpcRunPlan,
	cliPath: string,
	pooled: RpcPoolEntry | undefined,
): Promise<ChildPiRunResult> {
	const { input, effectiveTask, ctx } = plan;
	const poolKey = poolKeyFor(input);
	const spawnOptions = buildFinalChildPiSpawnOptions(input.cwd, ctx.mergedEnv, ctx.builtEnv, input.model);
	// RpcClient types env as Record<string,string> — drop undefined entries.
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(spawnOptions.env ?? {})) {
		if (v !== undefined) childEnv[k] = v;
	}

	let client: RpcClientInstance;
	if (pooled) {
		client = pooled.client;
	} else {
		client = new RpcClientCtor({
			cliPath,
			cwd: spawnOptions.cwd,
			env: childEnv,
			args: buildRpcClientArgs(ctx.builtArgs),
		});
	}

	// ── start (fresh spawns only) ─────────────────────────────────────────
	if (!pooled) {
		// Env-splice: RpcClient spawns with `{...process.env, ...options.env}`
		// (rpc-client.js start()) — WITHOUT this splice the child would inherit
		// the FULL parent env, silently regressing the allowlist/per-task key
		// scoping model. The spawn happens in the SYNCHRONOUS prefix of
		// start(), before its first await, so restoring before awaiting keeps
		// the splice invisible to every other reader of process.env (single
		// JS thread — no interleaving is possible inside this sync block).
		const savedEnv = process.env;
		let startPromise: Promise<void>;
		process.env = childEnv as unknown as NodeJS.ProcessEnv;
		try {
			startPromise = client.start();
		} finally {
			process.env = savedEnv;
		}
		try {
			await startPromise;
		} catch (error) {
			const stderr = client.getStderr?.() ?? "";
			const message = `RPC child Pi failed to start: ${error instanceof Error ? error.message : String(error)}. Stderr: ${redactExcerpt(stderr, 500) || "(none)"}`;
			try {
				input.onLifecycleEvent?.({
					type: "spawn_error",
					error: message,
					ts: new Date().toISOString(),
					stderrExcerpt: redactExcerpt(stderr, 500) || undefined,
				});
			} catch {
				/* listener errors never mask the start failure */
			}
			return {
				exitCode: null,
				stdout: "",
				stderr: redactExcerpt(stderr, 10_000),
				error: message,
				exitStatus: {
					exitCode: null,
					cancelled: false,
					timedOut: false,
					killed: false,
					cleanupErrors: [],
					finalDrainMs: input.finalDrainMs ?? FINAL_DRAIN_MS,
					crashClass: classifyProcessCrash({
						exitCode: null,
						cancelled: false,
						timedOut: false,
						spawnError: error instanceof Error ? error : new Error(String(error)),
						stderrSnippet: stderr ? redactExcerpt(stderr, 1000) : undefined,
					}).crashClass,
				},
			};
		}
	}
	// PoC nuance 4: read client.process DIRECTLY (RpcClient.stop() drops the
	// exit code — unusable for lifecycle). Private in the .d.ts, public at
	// runtime (rpc-client.js field) — hence the structural cast.
	const child = (client as unknown as { process: ChildProcess | null }).process;
	if (!child) {
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: "RPC child Pi start returned no process",
			exitStatus: {
				exitCode: null,
				cancelled: false,
				timedOut: false,
				killed: false,
				cleanupErrors: [],
				finalDrainMs: input.finalDrainMs ?? FINAL_DRAIN_MS,
			},
		};
	}

	// ── registration (same bookkeeping as the json branch) ────────────────
	if (!pooled) {
		if (child.pid) {
			registerActiveChild(child.pid, child);
			registerChildProcess(child.pid, input.runId ?? `untracked-run-${child.pid}`, input.agentId ?? `untracked-agent-${child.pid}`);
		}
	}
	if (child.pid) input.onSpawn?.(child.pid);
	input.onLifecycleEvent?.({ type: "spawned", pid: child.pid, ts: new Date().toISOString() });
	// Pool eviction hook: the entry dies with the process, whoever killed it.
	if (pooled) {
		child.once("exit", () => {
			const entry = rpcPool.get(poolKey);
			if (entry?.proc === child) rpcPool.delete(poolKey);
		});
	}

	// The run's pool entry: the ACQUIRED reuse target, or — on a fresh spawn
	// that finishes cleanly with the pool enabled — an entry REGISTERED at
	// agent_settled so the next same-agent task can reuse this process.
	let poolEntry: RpcPoolEntry | undefined = pooled;
	try {
		return await new Promise<ChildPiRunResult>((resolve) => {
			const stdoutTail = new BoundedTail();
			const stderrTail = new BoundedTail();
			let settled = false;
			let childExited = false;
			let postExitGuardCleanup: (() => void) | undefined;
			let stdinEnded = false;
			let isStreaming = false;
			let sawFinalAssistant = false;
			const finalDrainMs = input.finalDrainMs ?? FINAL_DRAIN_MS;
			const hardKillMs = input.hardKillMs ?? HARD_KILL_MS;
			let finalDrainArmed = false;
			let lastStdoutActivityMonotonicMs = performance.now();
			let finalDrainFiredMonotonicMs: number | undefined;
			const spawnMonotonicMs = performance.now();
			let finalAssistantEventMonotonicMs: number | undefined;
			const responseTimeoutMs = resolveResponseTimeoutMs(input);
			let responseTimeoutHit = false;
			let forcedFinalDrain = false;
			let abortRequested = input.signal?.aborted === true;
			let hardKilled = false;
			const cleanupErrors: string[] = [];
			const steeringController = new ChildPiSteeringController(input.maxTurns, input.graceTurns);
			let abortDueToParentSignal = false;
			const onParentAbort = (): void => {
				abortDueToParentSignal = true;
			};
			input.signal?.addEventListener("abort", onParentAbort, { once: true });

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
				redactStderrExcerpt: redactExcerpt,
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
					input.onStdoutLine?.(line);
				},
				onJsonEvent: (event) => {
					input.onJsonEvent?.(event);
				},
			});

			const endStdinGracefully = (): void => {
				if (stdinEnded) return;
				stdinEnded = true;
				try {
					child.stdin?.end();
				} catch (error) {
					logInternalError("child-pi.rpc-stdin-end", error, `pid=${child.pid}`);
				}
			};

			const clearPostExitGuard = (): void => {
				if (postExitGuardCleanup) {
					postExitGuardCleanup();
					postExitGuardCleanup = undefined;
				}
			};

			const recoverForSettle = async (settleResult: ChildPiRunResult): Promise<SessionRecoveryInfo | undefined> => {
				if (!plan.workerSession || !plan.sessionRecoveryEnabled) return undefined;
				if (!shouldAttemptSessionRecovery(settleResult, hardKilled)) return undefined;
				try {
					return (
						(await recoverLastAssistantFromSession(plan.workerSession.sessionDir, plan.workerSession.sessionId)) ?? undefined
					);
				} catch {
					return undefined;
				}
			};

			const buildExitStatus = (result: { exitCode: number | null }): WorkerExitStatus => ({
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
			});

			const settle = (result: ChildPiRunResult): Promise<void> => {
				if (settled) return Promise.resolve();
				settled = true;
				clearAll();
				clearPostExitGuard();
				if (poolEntry) releasePooledRpcClient(poolKey, poolEntry);
				return lineObserver
					.flush()
					.then(async () => {
						input.signal?.removeEventListener("abort", abort);
						input.signal?.removeEventListener("abort", onParentAbort);
						try {
							cleanupTempDir(ctx.tempDir);
						} catch (error) {
							cleanupErrors.push(error instanceof Error ? error.message : String(error));
						}
						const recoveredFromSession = await recoverForSettle(result);
						try {
							resolve({
								...result,
								rawFinalText: lineObserver.getRawFinalText(),
								intermediateFindings: lineObserver.getIntermediateFindings(),
								...(recoveredFromSession ? { recoveredFromSession } : {}),
								exitStatus: result.exitStatus ?? buildExitStatus(result),
							});
						} catch (resolveError) {
							logInternalError(
								"child-pi.rpc-settle-resolve",
								resolveError,
								`result=${JSON.stringify({ exitCode: result.exitCode })}`,
							);
						}
					})
					.catch(async (flushError) => {
						logInternalError(
							"child-pi.rpc-settle-flush-failed",
							flushError,
							`result=${JSON.stringify({ exitCode: result.exitCode })}`,
						);
						input.signal?.removeEventListener("abort", abort);
						input.signal?.removeEventListener("abort", onParentAbort);
						try {
							cleanupTempDir(ctx.tempDir);
						} catch (error) {
							cleanupErrors.push(error instanceof Error ? error.message : String(error));
						}
						const recoveredFromSession = await recoverForSettle(result);
						try {
							resolve({
								...result,
								rawFinalText: lineObserver.getRawFinalText(),
								intermediateFindings: lineObserver.getIntermediateFindings(),
								...(recoveredFromSession ? { recoveredFromSession } : {}),
								exitStatus: result.exitStatus ?? buildExitStatus(result),
							});
						} catch (resolveError) {
							logInternalError(
								"child-pi.rpc-settle-resolve",
								resolveError,
								`result=${JSON.stringify({ exitCode: result.exitCode })}`,
							);
						}
					});
			};

			const abort = (): void => {
				abortRequested = true;
				clearNoResponseTimer();
				// Graceful hint first: the abort receipt is settle-gated on the
				// agent side (verify round 9 P1) — fire-and-forget, because the
				// watchdog below (kill-tree + 200ms fast-escalate) is the real
				// enforcement and its timing must NOT change (bảng KHÔNG đổi §0).
				void client.abort().catch((error) => {
					logInternalError(
						"child-pi.rpc-abort-receipt-failed",
						error instanceof Error ? error : new Error(String(error)),
						`pid=${child.pid}`,
					);
				});
				killProcessTree(child.pid, child);
				if (process.platform !== "win32") {
					trySignalChild(child, "SIGTERM");
				}
				try {
					child.kill(process.platform === "win32" ? undefined : "SIGTERM");
				} catch {
					// Ignore kill races.
				}
				armCancelHardKill();
			};

			const onAgentSettled = (): void => {
				isStreaming = false;
				if (settled || childExited) return;
				// Pool registration (phase 1, opt-in): a fresh process that finished
				// its run cleanly and is still live becomes the agent's reuse
				// candidate — and a pool-enabled run NEVER closes stdin (the warm
				// process must survive for the next task). The exit listener evicts
				// dead entries on the acquire side's behalf.
				if (!poolEntry && resolveChildPiRpcPoolEnabled() && child.exitCode === null && child.stdin && !child.stdin.destroyed) {
					poolEntry = { client, proc: child, idle: false };
					rpcPool.set(poolKey, poolEntry);
					child.once("exit", () => {
						const entry = rpcPool.get(poolKey);
						if (entry?.proc === child) rpcPool.delete(poolKey);
					});
				}
				if (poolEntry) {
					// Warm path (acquired OR just registered): the process STAYS alive
					// — settle the run here (exit 0 — the run itself completed; empty
					// output keeps json parity: no final assistant event ≠ transport
					// failure). The no-response timer is the hung-settle backstop.
					void settle({
						exitCode: 0,
						stdout: "",
						stderr: stderrTail.value(),
						steered: steeringController.isSoftLimitReached(),
						exitStatus: buildExitStatus({ exitCode: 0 }),
					});
				} else {
					// PoC shutdown contract: stdin-close → orderly dispose → exit 0
					// (~73ms). The final-drain SIGTERM ceiling stays armed (if it was)
					// as the backstop for a process that refuses to exit.
					endStdinGracefully();
				}
			};

			const unsubscribeEvents = client.onEvent((event) => {
				try {
					if (!event || typeof event !== "object") return;
					const record = event as Record<string, unknown>;
					if (typeof record.type !== "string") return;
					if (RPC_DROPPED_EVENT_TYPES.has(record.type)) return; // PoC nuance 6
					if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
					lastStdoutActivityMonotonicMs = performance.now();
					if (record.type === "turn_end") {
						// steeringFile is deliberately undefined in rpc mode — the
						// advisory rides client.steer() below instead of the polled
						// JSONL file.
						const action = steeringController.onTurnEnd(child.pid, child, undefined);
						if (action.kind === "hardAbort") {
							killProcessTree(action.pid, action.child);
						} else if (action.kind === "steer" && isStreaming) {
							// U14 PoC nuance 1: steer while IDLE queues into the
							// NEXT run — only steer a live run (isStreaming gate).
							void client
								.steer(STEER_WRAP_UP_MESSAGE)
								.then((receipt) => {
									logInternalError(
										"child-pi.rpc-steer-receipt",
										new Error(`disposition=${receipt?.data?.disposition ?? "unknown"}`),
										`pid=${child.pid}`,
										"debug",
									);
								})
								.catch((error) => {
									logInternalError(
										"child-pi.rpc-steer-failed",
										error instanceof Error ? error : new Error(String(error)),
										`pid=${child.pid}`,
									);
								});
						}
					} else if (record.type === "agent_settled") {
						onAgentSettled();
					}
					lineObserver.observeEvent(event);
					if (!isFinalAssistantEvent(event) || childExited || settled || hasFinalDrainTimer()) return;
					finalAssistantEventMonotonicMs = performance.now();
					sawFinalAssistant = true;
					finalDrainArmed = true;
					// Pooled processes must NOT be SIGTERM'd by the drain ceiling —
					// their completion signal is agent_settled (noResponse backstop).
					if (!pooled) armFinalDrain();
				} catch (error) {
					logInternalError("child-pi.rpc-event", error instanceof Error ? error : new Error(String(error)), `pid=${child.pid}`);
				}
			});

			// stderr is owned by RpcClient (its buffer feeds our excerpts); a
			// second listener only mirrors into the bounded tail — additive.
			child.stderr?.on("data", (chunk: Buffer) => {
				if (!steeringController.isHardAbortInitiated()) restartNoResponseTimer();
				stderrTail.push(chunk.toString("utf-8"));
			});

			child.on("error", (error) => {
				const stderr = stderrTail.value();
				const processError = new Error(
					`RPC child Pi process error: ${error.message}. Stderr: ${redactExcerpt(stderr, 500) || "(none)"}`,
				);
				try {
					input.onLifecycleEvent?.({
						type: "spawn_error",
						pid: child.pid,
						error: processError.message,
						ts: new Date().toISOString(),
						stderrExcerpt: redactExcerpt(stderr, 500) || undefined,
					});
				} catch (err) {
					logInternalError("child-pi.on-lifecycle-event", err, `event=error, pid=${child.pid}`);
				}
				void settle({
					exitCode: null,
					stdout: "",
					stderr,
					error: processError.message,
					exitStatus: {
						...buildExitStatus({ exitCode: null }),
						crashClass: classifyProcessCrash({
							exitCode: null,
							cancelled: abortRequested,
							timedOut: responseTimeoutHit,
							spawnError: error,
							stderrSnippet: stderr ? redactExcerpt(stderr, 1000) : undefined,
						}).crashClass,
					},
				});
			});

			child.on("exit", (code, signal) => {
				const stderr = stderrTail.value();
				if (child.pid) {
					unregisterActiveChild(child.pid);
					clearHardKillTimer(child.pid);
					unregisterChildProcess(child.pid);
				}
				const abnormalExit = code !== 0 && code !== null;
				const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested && abnormalExit;
				const exitError = isUnexpectedExit
					? new Error(
							`RPC child Pi exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}). Stderr: ${redactExcerpt(stderr, 1000) || "(none)"}`,
						)
					: null;
				try {
					input.onLifecycleEvent?.({
						type: "exit",
						pid: child.pid,
						exitCode: code,
						ts: new Date().toISOString(),
						error: exitError?.message,
						stderrExcerpt: isUnexpectedExit ? redactExcerpt(stderr, 1000) || undefined : undefined,
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
				const stderr = stderrTail.value();
				if (child.pid) {
					unregisterActiveChild(child.pid);
					clearHardKillTimer(child.pid);
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
								error: `RPC child Pi produced no new output for ${responseTimeoutMs}ms; process was terminated as unresponsive.`,
							}
						: responseTimeoutHit && stderr.trim()
							? { error: `RPC child Pi timed out after ${responseTimeoutMs}ms with stderr: ${redactExcerpt(stderr, 500)}` }
							: undefined;
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
				const crashClassification = classifyProcessCrash({
					exitCode: finalExitCode,
					signal: child.signalCode ?? undefined,
					cancelled: abortRequested,
					timedOut: responseTimeoutHit,
					killed: hardKilled,
					spawnError: undefined,
					stderrSnippet: stderr ? redactExcerpt(stderr, 1000) : undefined,
				});
				void settle({
					exitCode: finalExitCode,
					stdout: stdoutTail.value(),
					stderr,
					...(timeoutError ? { error: timeoutError.error } : {}),
					aborted: wasGraceAborted || wasParentAborted,
					steered: steeringController.isSoftLimitReached() && !wasGraceAborted,
					exitStatus: {
						...buildExitStatus({ exitCode: finalExitCode }),
						crashClass: crashClassification.crashClass,
					},
				});
			});

			input.signal?.addEventListener("abort", abort, { once: true });

			// ── prompt delivery ────────────────────────────────────────────
			void (async () => {
				try {
					// PoC nuance 1: clear_queue BEFORE every prompt — a steer that
					// arrived while idle was QUEUED (not errored) and would inject
					// into THIS run otherwise. Round-trip is tolerated by the
					// no-response timer (no readiness signal — nuance 3).
					const cleared = await client.clearQueue();
					if (cleared.steering.length > 0 || cleared.followUp.length > 0) {
						logInternalError(
							"child-pi.rpc-stale-queue-cleared",
							new Error(`steering=${cleared.steering.length} followUp=${cleared.followUp.length}`),
							`pid=${child.pid}`,
							"warn",
						);
					}
					// ALWAYS pass streamingBehavior (P2 LIVE): a prompt while
					// streaming without it is a protocol error. "followUp" never
					// interrupts a live run — the watchdog owns hard enforcement.
					const disposition = await client.prompt(effectiveTask, undefined, "followUp");
					if (disposition === "handled") {
						// An extension consumed the prompt; no agent run started and
						// no agent_settled will arrive (SDK contract) — fail the run
						// instead of waiting on the watchdog.
						void settle({
							exitCode: 1,
							stdout: "",
							stderr: stderrTail.value(),
							error: "RPC prompt was handled by an extension (no agent run started)",
							exitStatus: buildExitStatus({ exitCode: 1 }),
						});
						return;
					}
					isStreaming = true;
				} catch (error) {
					// rpcAgentStarted mirrors the stdio-transport DR5 guard: if any
					// session event was already observed the turn HAD begun, so the
					// failure is non-retryable from the caller's perspective.
					const started = sawFinalAssistant || finalAssistantEventMonotonicMs !== undefined;
					void settle({
						exitCode: null,
						stdout: "",
						stderr: stderrTail.value(),
						error: `RPC prompt delivery failed: ${error instanceof Error ? error.message : String(error)}`,
						...(started ? { rpcAgentStarted: true } : {}),
						exitStatus: buildExitStatus({ exitCode: null }),
					});
				}
			})();
		});
	} finally {
		// ctx.tempDir is cleaned inside settle(); guard against settle() never
		// being reached (start() threw before the Promise body — handled above,
		// but keep the json-branch finally shape for symmetry).
		if (ctx.tempDir && fs.existsSync(ctx.tempDir)) {
			cleanupTempDir(ctx.tempDir);
		}
	}
}
