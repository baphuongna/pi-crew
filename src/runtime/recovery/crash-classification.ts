/**
 * Crash Classification Taxonomy — pure function for categorizing worker exits.
 *
 * Distilled from gajae-code's `debug/crash-diagnostics.ts` (P0 item #1).
 * Unlike the original, this module is pure: it does NOT write crash reports or
 * touch the filesystem. The file-I/O layer is intentionally omitted; callers
 * that want durable crash logs can layer them on top of {@link classifyProcessCrash}.
 *
 * The classification precedence (most-significant first) mirrors the
 * reference implementation:
 *
 *   1. timeout          — process was terminated by the response-timeout guard
 *   2. cancelled        — cooperative cancellation (AbortSignal) triggered exit
 *   3. spawn_error      — child_process emitted an `error` event before `exit`
 *   4. native_panic     — stderr indicates a native crash (SIGSEGV / abort / panic)
 *   5. signal_exit      — the process was terminated by an OS signal
 *   6. clean_exit       — exit code 0
 *   7. non_zero_exit    — exit code != 0 (and != null)
 *   8. protocol_exit    — exit code is null with no signal (protocol/stream
 *                         ended before a normal exit was observed)
 *   9. unknown          — defensive fallback (should not occur in practice)
 *
 * NOTE on timeout-vs-cancel precedence: when BOTH `timedOut` and `cancelled`
 * are true, `timeout` wins (the timeout terminated the process). This matches
 * gajae-code and the existing child-pi.ts response-timeout guard, which fires
 * the hard kill and is the proximate cause.
 */

/**
 * Categorical classification of why a worker process ended.
 *
 * @see classifyProcessCrash
 */
export type CrashClass =
	| "clean_exit"
	| "non_zero_exit"
	| "signal_exit"
	| "timeout"
	| "cancelled"
	| "spawn_error"
	| "protocol_exit"
	| "native_panic"
	| "unknown";

/**
 * Inputs to {@link classifyProcessCrash}. All fields are optional/safe-defaulting
 * so callers can pass a partial view (e.g. just `{ exitCode: 0 }`).
 *
 * Field semantics:
 * - `exitCode`    — the OS exit code, or `null` when no code was observed.
 * - `signal`      — the terminating signal name (e.g. `"SIGTERM"`) or `null`.
 * - `cancelled`   — true when cooperative cancellation (AbortSignal) was requested.
 * - `timedOut`    — true when the response-timeout guard fired (and likely killed).
 * - `killed`      — true when the parent explicitly killed the child (best-effort).
 * - `spawnError`  — truthy when the child emitted a spawn/process `error` event.
 * - `stderrSnippet` — tail of captured stderr, used to detect native panics.
 */
export interface CrashClassificationInput {
	exitCode?: number | null;
	signal?: string | null;
	cancelled?: boolean;
	timedOut?: boolean;
	killed?: boolean;
	spawnError?: unknown;
	stderrSnippet?: string;
}

/**
 * Result of classifying an exit. `crashClass` is machine-readable;
 * `reason` is a human-friendly one-liner suitable for logs/diagnostics.
 */
export interface CrashClassification {
	crashClass: CrashClass;
	reason: string;
}

// ── native-panic detection ──────────────────────────────────────────────────
//
// We look for a small, well-known set of native-crash signatures in the stderr
// tail. This is deliberately conservative: false positives would mislabel
// ordinary non-zero exits as native panics. The patterns are anchored on
// substrings that do not appear in normal application output.

interface NativePanicSignature {
	/** Substring to search for (case-insensitive). */
	pattern: string;
	/** Human-readable class-specific reason suffix. */
	label: string;
}

const NATIVE_PANIC_SIGNATURES: readonly NativePanicSignature[] = [
	{ pattern: "sigsegv", label: "segmentation fault" },
	{ pattern: "segfault", label: "segmentation fault" },
	{ pattern: "segmentation fault", label: "segmentation fault" },
	{ pattern: "sigabrt", label: "abort signal" },
	{ pattern: "abort(", label: "abort" },
	{ pattern: "fatal error", label: "V8/node fatal error" },
	{ pattern: "panic:", label: "rust/go panic" },
	{ pattern: "thread '", label: "rust panic (thread context)" },
	{ pattern: "illegal instruction", label: "illegal instruction" },
	{ pattern: "double free", label: "heap corruption (double free)" },
];

/**
 * If the stderr tail contains a recognizable native-crash signature, return the
 * matching label; otherwise `null`. Case-insensitive.
 */
function detectNativePanic(stderrSnippet: string | undefined): string | null {
	if (!stderrSnippet) return null;
	const lower = stderrSnippet.toLowerCase();
	for (const sig of NATIVE_PANIC_SIGNATURES) {
		if (lower.includes(sig.pattern)) return sig.label;
	}
	return null;
}

/** Normalize an optional/signal-ish value to `string | null`. */
function normalizeSignal(signal: string | null | undefined): string | null {
	return signal ?? null;
}

/**
 * Classify a worker exit into a {@link CrashClass}.
 *
 * Pure: no I/O, no globals, no side effects. Deterministic given the same input.
 * Safe to call from any context (including signal handlers).
 *
 * @example
 * classifyProcessCrash({ exitCode: 0 })                       // → clean_exit
 * classifyProcessCrash({ exitCode: 1 })                       // → non_zero_exit
 * classifyProcessCrash({ signal: "SIGTERM" })                 // → signal_exit
 * classifyProcessCrash({ timedOut: true, exitCode: null })    // → timeout
 * classifyProcessCrash({ cancelled: true, exitCode: null })   // → cancelled
 * classifyProcessCrash({ spawnError: new Error("ENOENT") })   // → spawn_error
 * classifyProcessCrash({ exitCode: null })                    // → protocol_exit
 * classifyProcessCrash({ exitCode: 139, signal: "SIGSEGV" })  // → signal_exit
 * classifyProcessCrash({ exitCode: 134, stderrSnippet: "abort()" }) // → native_panic
 */
export function classifyProcessCrash(input: CrashClassificationInput): CrashClassification {
	const exitCode = input.exitCode ?? null;
	const signal = normalizeSignal(input.signal);

	// 1. Timeout takes precedence: the response-timeout guard is the proximate
	//    cause of death even if cancellation was also requested.
	if (input.timedOut) {
		return {
			crashClass: "timeout",
			reason: "process timed out (response timeout guard fired)",
		};
	}

	// 2. Cooperative cancellation.
	if (input.cancelled) {
		return {
			crashClass: "cancelled",
			reason: "process was cancelled (abort requested)",
		};
	}

	// 3. Spawn error: the child never started or emitted a process error.
	if (input.spawnError !== undefined && input.spawnError !== null) {
		return {
			crashClass: "spawn_error",
			reason: `spawn error: ${stringifyError(input.spawnError)}`,
		};
	}

	// 4. Native panic from stderr (only when we have a signal/abnormal exit —
	//    never reclassify a clean exit as a panic based on stderr noise).
	const abnormalExit = signal !== null || (exitCode !== null && exitCode !== 0);
	if (abnormalExit) {
		const panic = detectNativePanic(input.stderrSnippet);
		if (panic !== null) {
			return {
				crashClass: "native_panic",
				reason: `native panic detected: ${panic}`,
			};
		}
	}

	// 5. Signal exit.
	if (signal !== null) {
		return {
			crashClass: "signal_exit",
			reason: `process exited after signal ${signal}`,
		};
	}

	// 6. Clean exit.
	if (exitCode === 0) {
		return { crashClass: "clean_exit", reason: "process exited cleanly" };
	}

	// 7. Non-zero exit.
	if (exitCode !== null) {
		return {
			crashClass: "non_zero_exit",
			reason: `process exited with code ${exitCode}`,
		};
	}

	// 8. Protocol exit: exitCode is null with no signal — the process stream
	//    ended before a normal exit was observed (e.g. stdio closed unexpectedly).
	//    If `killed` is true but no signal was recorded, treat as protocol_exit
	//    (the kill may not have delivered a signal we could capture).
	if (input.killed) {
		return {
			crashClass: "protocol_exit",
			reason: "process was killed but no signal/exit code was captured",
		};
	}

	// 8b. Truly null exitCode with no other context — protocol/stream ended early.
	return {
		crashClass: "protocol_exit",
		reason: "process exited before protocol completion (exit code unknown)",
	};
}

/** Render an unknown error value to a short message string. */
function stringifyError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	try {
		return String(error);
	} catch {
		return "(unstringifiable error)";
	}
}
