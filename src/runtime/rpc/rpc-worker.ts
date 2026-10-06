/**
 * rpc-worker.ts — W7 (P2-3): EXPERIMENTAL RPC worker transport.
 *
 * STATUS — WIRED at the run-worker seam behind PI_CREW_WORKER_TRANSPORT=rpc
 * (integration phase, 2026-10-04), after a LIVE-FIRE probe against a real
 * `pi --mode rpc` process came back GREEN on all four probe items:
 *   (a) extension_ui_request drain: 24 drained (setStatus×20, setWidget×3,
 *       notify×1 — pi-crew extension widgets visible in the raw frames);
 *   (b) prompt round-trip: ack 24ms, agent_settled 4.2s, rawFinalText="OK";
 *   (c) dialog (confirm) auto-answered by the "cancel" policy
 *       (extension_ui_response cancelled:true → ui.confirm resolved false →
 *       the model literally echoed "false"), NO deadlock (settled 1.7s);
 *   (d) steer mid-turn: disposition "queued", RTT 53ms, final text honored
 *       ("STOP"); all runs exited 0 with orderly stdin-end shutdown.
 * Raw probe artifacts: /tmp/rpc-lf/probe1{,b}.{log,stdout.txt,stderr.txt},
 * probe2.*, probe3.* (2026-10-04, lane D6).
 *
 * runRpcWorker: prompt → collect session events until `agent_settled` →
 * orderly stop → map to ChildPiRunResult. Abort/steer signals send the RPC
 * `abort` command before stopping. If the transport fails BEFORE any agent
 * output (early spawn/handshake failure), runWorker falls back to the stdio
 * transport (structured warn, no double-execution of a consumed task).
 *
 * LIFECYCLE HARDENING (DR1/DR5, deep-review 2026-10-05 §2):
 * - DR1 settle-hang: the settle wait is RACED against `client.exited()` and
 *   a belt-and-suspenders turn timeout — a child that crashes after the
 *   prompt was accepted (or stays live-but-silent) can no longer hold the
 *   await open forever (and with it the global worker-cap slot). Both
 *   losers map to the early-failure result shape so the stdio fallback
 *   engages and the slot is released.
 * - DR5 double-execution: `SettleTracking.agentStarted` records that a
 *   session event was observed after the prompt was sent; a failure in that
 *   state is NEVER retried (surfaced via result.rpcAgentStarted — see
 *   isEarlyRpcTransportFailure), closing the started-but-no-text window.
 */

import { getCrewEnv, getCrewEnvInt } from "../../config/env-vars.ts";
import type { ChildPiRunResult } from "../child-pi/child-pi.ts";
import { createRpcFrameClient, type RpcFrameClientOptions } from "./frame-client.ts";
import type { DialogAnswerPolicy } from "./ui-request-policy.ts";

/** Env knob selecting the transport at the run-worker seam. */
export const WORKER_TRANSPORT_ENV = "PI_CREW_WORKER_TRANSPORT";
/** Env knob for the dialog auto-answer policy (GATE 2). */
export const RPC_DIALOG_ANSWER_ENV = "PI_CREW_RPC_DIALOG_ANSWER";
/** Env knob for the DR1 turn timeout (ms) — env-only, RPC stays experimental. */
export const RPC_TURN_TIMEOUT_ENV = "PI_CREW_RPC_TURN_TIMEOUT_MS";
/** Default DR1 turn bound: 10 minutes (registry default mirrors this literal). */
export const DEFAULT_RPC_TURN_TIMEOUT_MS = 600_000;

export type WorkerTransport = "stdio" | "rpc";

/** Minimal surface of runWorker's input the RPC path consumes. */
export interface RpcWorkerInput {
	cwd?: string;
	task: string;
	model?: string;
	signal?: AbortSignal;
	/** Optional client overrides (tests inject a fake spawner + tiny timeouts). */
	rpc?: Pick<RpcFrameClientOptions, "spawnFn" | "argv" | "commandTimeoutMs" | "stopTimeoutMs" | "dialogPolicy">;
}

/**
 * Live-fire argv for the RPC transport (probe-verified 2026-10-04).
 *
 * `--no-session` is the SAFE prototype default: a worker spawned without
 * deterministic session identity (`--session-id`/`--session-dir` — stdio-only
 * today, see pi-args.ts W2) would otherwise attach to the cwd project's
 * DEFAULT session and pollute the user's live session. Ephemeral workers are
 * correct worker semantics until rpc-mode session identity is designed.
 *
 * Limitation vs the stdio argv (documented, deliberate): the model string is
 * passed RAW — no applyThinkingSuffix composition, no agent/system-prompt
 * files, no hermetic flags. Those remain stdio-only until each is probed.
 */
export function buildRpcWorkerArgv(model?: string): string[] {
	const argv = ["--mode", "rpc", "--no-session"];
	if (model) argv.push("--model", model);
	return argv;
}

/**
 * Resolve the worker transport. Precedence: env > config > default stdio
 * (the repo's established order — the env var stays the live experimental
 * gate and WINS over config whenever it is set, even when its value is
 * invalid: an operator who sets PI_CREW_WORKER_TRANSPORT is driving via env,
 * so the config value is not consulted behind their back). The config value
 * (runtime.workerTransport, threaded to the seam via WorkerSpawnInput by the
 * callers that carry runtimeConfig — D1/DR2) applies only when env is unset.
 * FAILSAFE: anything other than exactly "rpc" (after trim) resolves to the
 * default stdio transport.
 */
export function resolveWorkerTransport(
	configValue?: WorkerTransport,
	read: (name: string) => string | undefined = getCrewEnv,
): WorkerTransport {
	const raw = read(WORKER_TRANSPORT_ENV)?.trim();
	if (raw === "rpc") return "rpc";
	if (raw === "stdio") return "stdio";
	if (raw !== undefined) return "stdio"; // env set but invalid → failsafe stdio
	return configValue === "rpc" ? "rpc" : "stdio";
}

/**
 * Resolve the dialog auto-answer policy (GATE 2). "cancel" (default) is the
 * universal safe answer; "block" leaves the server promise pending on purpose
 * (debugging). Auto-confirm is deliberately NOT a policy (security gate — see
 * ui-request-policy.ts). Invalid values fail safe to "cancel".
 */
export function resolveDialogAnswerPolicy(read: (name: string) => string | undefined = getCrewEnv): DialogAnswerPolicy {
	return read(RPC_DIALOG_ANSWER_ENV)?.trim() === "block" ? "block" : "cancel";
}

/**
 * Resolve the DR1 turn timeout (ms). Belt-and-suspenders bound for a
 * live-but-silent child: the settle wait also races this timeout, so even a
 * child that never exits cannot hold the worker-cap slot forever. Read via
 * the env registry (getCrewEnvInt — the registry default "600000" applies
 * when unset/unparseable); a parsed value ≤ 0 falls back to the default —
 * there is deliberately NO disable value while RPC stays experimental.
 */
export function resolveRpcTurnTimeoutMs(read: (name: string) => number | undefined = getCrewEnvInt): number {
	const value = read(RPC_TURN_TIMEOUT_ENV);
	return typeof value === "number" && value > 0 ? value : DEFAULT_RPC_TURN_TIMEOUT_MS;
}

interface SettleTracking {
	lastAssistantText: string | undefined;
	settled: boolean;
	/**
	 * DR5 double-execution guard: true once ANY session event other than
	 * `agent_settled` (message_start / message_end / extension_error / …)
	 * was observed after the prompt command was WRITTEN. "Written" rather
	 * than strictly "after the prompt ACK": the frame client processes a
	 * stdout chunk's lines synchronously while the sendCommand promise only
	 * resolves in a later microtask — an event coalesced into the same chunk
	 * as the ACK would slip past a strict ACK gate, reopening the exact
	 * window this guard exists to close. `agent_settled` itself does NOT
	 * count (it ends the turn; a settled-with-no-other-event turn is an
	 * empty turn, not a started one — keeps prompt-preflight rejections
	 * retry-safe).
	 */
	agentStarted: boolean;
}

function extractAssistantText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const role = (message as { role?: unknown }).role;
	if (role !== "assistant") return undefined;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Run one worker turn over the RPC frame transport (EXPERIMENTAL — see module
 * header for live-fire status). Spawn failure surfaces as a structured result
 * (error field), never a throw from the transport itself.
 */
export async function runRpcWorker(input: RpcWorkerInput): Promise<ChildPiRunResult> {
	const tracking: SettleTracking = { lastAssistantText: undefined, settled: false, agentStarted: false };
	let settleResolve: (() => void) | undefined;
	const settledPromise = new Promise<void>((resolve) => {
		settleResolve = resolve;
	});
	let abortError: Error | undefined;
	// DR5: set synchronously right before the prompt command is written (see
	// SettleTracking.agentStarted for why "written", not "ACKed").
	let promptSent = false;

	const overrides = input.rpc ?? {};
	const client = createRpcFrameClient({
		...overrides,
		// Live-fire argv unless the caller (tests) overrides wholesale.
		argv: overrides.argv ?? buildRpcWorkerArgv(input.model),
		dialogPolicy: overrides.dialogPolicy ?? resolveDialogAnswerPolicy(),
		onEvent: (event) => {
			const record = event as { type?: unknown; message?: unknown };
			if (record?.type === "message_end") {
				const text = extractAssistantText(record.message);
				if (text !== undefined) tracking.lastAssistantText = text;
			} else if (record?.type === "agent_settled") {
				tracking.settled = true;
				settleResolve?.();
			}
			// DR5: any other session event after the prompt was sent marks the
			// agent turn as begun (see SettleTracking.agentStarted docstring).
			if (promptSent && !tracking.settled) tracking.agentStarted = true;
		},
	});

	const onAbort = () => {
		// Ask the server to abort the current run, then stop orderly. The
		// command may race the shutdown — a rejection is expected and logged.
		client
			.sendCommand({ type: "abort" })
			.catch((error: Error) => {
				abortError = error;
			})
			.finally(() => {
				// biome-ignore lint/suspicious/noEmptyBlockStatements: stop() never rejects by design — void-append .catch per lane rules.
				void client.stop().catch(() => {});
				settleResolve?.();
			});
	};
	input.signal?.addEventListener("abort", onAbort, { once: true });

	let runError: string | undefined;
	// DR1: belt-and-suspenders turn timeout — even a child that never exits
	// must not hold the settle wait (and the worker-cap slot around it) open.
	const turnTimeoutMs = resolveRpcTurnTimeoutMs();
	let turnTimeoutReject: ((error: Error) => void) | undefined;
	const turnTimeoutPromise = new Promise<never>((_resolve, reject) => {
		turnTimeoutReject = reject;
	});
	const turnTimer = setTimeout(() => {
		turnTimeoutReject?.(new Error(`rpc transport: turn timeout after ${turnTimeoutMs}ms without agent_settled`));
	}, turnTimeoutMs);
	turnTimer.unref?.();
	try {
		promptSent = true;
		await client.sendCommand({ type: "prompt", message: input.task });
		// DR1: race the settle against process exit and the turn timeout. Both
		// losers carry the early-failure shape (error set, no rawFinalText —
		// unless assistant text was already captured, which correctly blocks
		// retry via the existing predicate); the settled-check inside the exit
		// branch keeps a settle frame that lands in the same tick as the exit
		// from being misread as a crash. Promise.race attaches handlers to all
		// participants, so the losers' later rejections are absorbed (no
		// unhandled-rejection), and the abort branch still resolves
		// settledPromise first (abort is never swallowed).
		await Promise.race([
			settledPromise,
			client.exited().then((code) => {
				if (!tracking.settled) throw new Error("rpc transport: exited before agent_settled");
				return code;
			}),
			turnTimeoutPromise,
		]);
	} catch (error) {
		runError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(turnTimer);
		input.signal?.removeEventListener("abort", onAbort);
		// biome-ignore lint/suspicious/noEmptyBlockStatements: stop() never rejects by design — void-append .catch per lane rules.
		await client.stop().catch(() => {});
	}

	const exitCode = await client.exited();
	const result: ChildPiRunResult = {
		exitCode,
		stdout: client.stdoutText(),
		stderr: client.stderrText(),
	};
	if (runError) result.error = runError;
	else if (abortError && !tracking.settled) result.error = `rpc abort failed: ${abortError.message}`;
	if (tracking.lastAssistantText !== undefined) result.rawFinalText = tracking.lastAssistantText;
	// DR5 bridge: explicit result field (NOT an error-string marker) so the
	// non-retryable contract is testable and greppable — isEarlyRpcTransportFailure
	// consults it (run-worker.ts). Set whenever the agent turn had begun.
	if (tracking.agentStarted) result.rpcAgentStarted = true;
	if (input.signal?.aborted) result.aborted = true;
	return result;
}
