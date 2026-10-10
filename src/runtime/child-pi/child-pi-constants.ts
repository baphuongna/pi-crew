/**
 * child-pi-constants.ts — Shared timing and capture constants for child-pi runtime.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 3). Zero behavior change.
 *
 * These constants are shared between runChildPi (in child-pi.ts) and the kill
 * helpers (in child-pi-kill.ts). Centralizing them here avoids circular imports
 * and makes the timing budget configurable from one place.
 */

import { DEFAULT_CHILD_PI } from "../../config/defaults.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import type { ChildPiRunInput } from "./child-pi.ts";

/** Post-exit window during which stdio is guarded against late writes. */
export const POST_EXIT_STDIO_GUARD_MS = DEFAULT_CHILD_PI.postExitStdioGuardMs;

/** Maximum time to wait for a final assistant event after the last stdout byte. */
export const FINAL_DRAIN_MS = DEFAULT_CHILD_PI.finalDrainMs;

/** Time after SIGTERM to escalate to SIGKILL. */
export const HARD_KILL_MS = DEFAULT_CHILD_PI.hardKillMs;

/** Maximum time with no output before the child is considered unresponsive. */
export const RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs;

/**
 * Maximum size (bytes) for the ChildPiLineObserver's line accumulation buffer.
 * When exceeded, the buffer is force-flushed to prevent unbounded memory growth
 * from chatty child processes that produce output without newlines.
 */
export const MAX_LINE_BUFFER_BYTES = 1024 * 1024; // 1 MB

/** Maximum characters for assistant text fragments in compacted events. */
export const MAX_ASSISTANT_TEXT_CHARS = DEFAULT_CHILD_PI.maxAssistantTextChars;

/**
 * Maximum characters for reasoning (`thinking`) fragments in compacted events,
 * and the size cap for the thinking parts in the agent view pane / view
 * session. Reasoning is display-only (never folded into results or artifacts),
 * so it gets a tighter cap than full assistant text.
 */
export const MAX_THINKING_CHARS = 8 * 1024;

/** Maximum characters for tool-result fragments in compacted events. */
export const MAX_TOOL_RESULT_CHARS = DEFAULT_CHILD_PI.maxToolResultChars;

/** Maximum characters for tool-input fragments in compacted events. */
export const MAX_TOOL_INPUT_CHARS = DEFAULT_CHILD_PI.maxToolInputChars;

/** Maximum characters for general compactable content (used by TruncationStage). */
export const MAX_COMPACT_CONTENT_CHARS = DEFAULT_CHILD_PI.maxCompactContentChars;

/**
 * Effective no-response timeout for a child run: env
 * PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS (bounded to [1s, 1h] — FIX Round 14: a
 * hostile/accidental value like 1 or 999_999_999 must neither disable the
 * timeout nor cause instant kills) beats ChildPiRunInput.responseTimeoutMs
 * beats the DEFAULT_CHILD_PI default.
 *
 * U14: extracted from the json branch's inline copy so the rpc transport
 * (child-pi-rpc.ts) resolves the EXACT same budget — the watchdog timing is
 * part of the bảng KHÔNG ĐỔI contract and must not drift between transports.
 */
export function resolveResponseTimeoutMs(input: Pick<ChildPiRunInput, "responseTimeoutMs">): number {
	const RESPONSE_TIMEOUT_MIN_MS = 1_000;
	const RESPONSE_TIMEOUT_MAX_MS = 3_600_000;
	const responseTimeoutEnv = Number.parseInt(getCrewEnv("PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS") ?? "", 10);
	const envInRange =
		Number.isFinite(responseTimeoutEnv) &&
		responseTimeoutEnv >= RESPONSE_TIMEOUT_MIN_MS &&
		responseTimeoutEnv <= RESPONSE_TIMEOUT_MAX_MS;
	return envInRange ? responseTimeoutEnv : (input.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS);
}
