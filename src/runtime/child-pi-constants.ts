/**
 * child-pi-constants.ts — Shared timing and capture constants for child-pi runtime.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 3). Zero behavior change.
 *
 * These constants are shared between runChildPi (in child-pi.ts) and the kill
 * helpers (in child-pi-kill.ts). Centralizing them here avoids circular imports
 * and makes the timing budget configurable from one place.
 */

import { DEFAULT_CHILD_PI } from "../config/defaults.ts";

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
