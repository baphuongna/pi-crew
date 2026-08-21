/**
 * safe-abort.ts — abort helpers that cannot crash the host process.
 *
 * When a child process was spawned with `options.signal` and the signal fires
 * AFTER that child already exited (fast workers, cleanup-after-completion,
 * session switches mid-run), Node's child_process abort listener throws
 * `AbortError: The operation was aborted` SYNCHRONOUSLY from
 * `AbortController.abort()` (node:child_process abortChildProcess).
 *
 * In pi extension event handlers that throw propagates straight into pi's
 * `uncaughtException` handling and kills the whole terminal session — the
 * crash seen here: session_before_switch → stopSessionBoundSubagents → abort
 * → AbortError → "pi exiting due to uncaughtException".
 *
 * Abort-after-exit is a semantic no-op (the work is already gone), so every
 * controller abort that can be linked to a spawned child MUST go through
 * these helpers: swallow the throw, log it, carry on.
 */

import { logInternalError } from "./internal-error.ts";

/** Minimal controller shape — anything with an `abort()` method. */
export interface Abortable {
	abort(): void;
}

/**
 * Abort a controller, tolerating Node's abort-after-child-exit AbortError.
 * Never throws. `scope` names the call site for the internal error log.
 */
export function safeAbort(controller: Abortable | undefined, scope: string): void {
	if (!controller) return;
	try {
		controller.abort();
	} catch (error) {
		logInternalError(`safe-abort.${scope}`, error);
	}
}

/** Abort every controller in an iterable; a throwing controller does not
 *  prevent the remaining ones from being aborted. */
export function safeAbortAll(controllers: Iterable<Abortable> | undefined, scope: string): void {
	if (!controllers) return;
	for (const controller of controllers) safeAbort(controller, scope);
}
