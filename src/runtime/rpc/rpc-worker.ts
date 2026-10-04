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
 */

import { getCrewEnv } from "../../config/env-vars.ts";
import type { ChildPiRunResult } from "../child-pi/child-pi.ts";
import { createRpcFrameClient, type RpcFrameClientOptions } from "./frame-client.ts";
import type { DialogAnswerPolicy } from "./ui-request-policy.ts";

/** Env knob selecting the transport at the run-worker seam. */
export const WORKER_TRANSPORT_ENV = "PI_CREW_WORKER_TRANSPORT";
/** Env knob for the dialog auto-answer policy (GATE 2). */
export const RPC_DIALOG_ANSWER_ENV = "PI_CREW_RPC_DIALOG_ANSWER";

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
 * Resolve the worker transport. The env var is the live prototype gate
 * (runWorker has no config access — packet §A); the `runtime.workerTransport`
 * config key is declared in config-schema.ts/types.ts and reaches this seam
 * in the integration phase. FAILSAFE: anything other than exactly "rpc"
 * (after trim) resolves to the default stdio transport.
 */
export function resolveWorkerTransport(read: (name: string) => string | undefined = getCrewEnv): WorkerTransport {
	const raw = read(WORKER_TRANSPORT_ENV);
	return raw?.trim() === "rpc" ? "rpc" : "stdio";
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

interface SettleTracking {
	lastAssistantText: string | undefined;
	settled: boolean;
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
	const tracking: SettleTracking = { lastAssistantText: undefined, settled: false };
	let settleResolve: (() => void) | undefined;
	const settledPromise = new Promise<void>((resolve) => {
		settleResolve = resolve;
	});
	let abortError: Error | undefined;

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
	try {
		await client.sendCommand({ type: "prompt", message: input.task });
		await settledPromise;
	} catch (error) {
		runError = error instanceof Error ? error.message : String(error);
	} finally {
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
	if (input.signal?.aborted) result.aborted = true;
	return result;
}
