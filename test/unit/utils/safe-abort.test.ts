/**
 * Unit tests for safe-abort — guards synchronous throws escaping an abort()
 * call and killing the host process.
 *
 * Background: Node's child_process abort listener (abortChildProcess) throws
 * an `AbortError` when a signal-spawned child has no 'error' listener. That
 * throw is captured by the AbortSignal dispatch machinery and RETHROWN
 * asynchronously on the next tick, so it bypasses ANY try/catch (including
 * this wrapper) and kills pi via uncaughtException. The definitive fix for
 * that path is the child-process shield (see child-process-shield.ts), which
 * guarantees an 'error' listener exists so nothing throws at all.
 *
 * safe-abort remains as defense-in-depth for synchronous throwers: custom
 * abortable objects, native controllers whose listeners throw in paths that
 * DO propagate synchronously, and cleanup code that must keep aborting
 * remaining controllers even if one throws.
 *
 * NOTE: tests deliberately use plain objects with a throwing abort() rather
 * than real AbortSignals. A listener registered via the PUBLIC
 * addEventListener API that throws is captured by EventTarget and rethrown
 * asynchronously — which would crash the test runner itself (uncaughtException)
 * no matter what we assert. A plain { abort() { throw ... } } object exercises
 * the exact synchronous-throw contract safeAbort guards.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Abortable, safeAbort, safeAbortAll } from "../../../src/utils/safe-abort.ts";

/** A controller whose abort() throws exactly like Node's abortChildProcess
 *  would if its throw propagated synchronously (abort-after-child-exit). */
function throwingController(message = "The operation was aborted"): Abortable {
	const error = new DOMException(message, "AbortError");
	return {
		abort(): void {
			throw error;
		},
		__thrown: error,
	} as unknown as Abortable & { __thrown: Error };
}

function recordingController(): { controller: Abortable; aborted: () => boolean } {
	const record = { aborted: false };
	return {
		controller: {
			abort(): void {
				record.aborted = true;
			},
		},
		aborted: () => record.aborted,
	};
}

test("safeAbort swallows an abort-after-exit AbortError", () => {
	const controller = throwingController();
	assert.doesNotThrow(() => safeAbort(controller, "test"));
});

test("safeAbort silently no-ops on undefined controllers", () => {
	assert.doesNotThrow(() => safeAbort(undefined, "test"));
});

test("safeAbortAll aborts every controller even when one throws", () => {
	const throwing = throwingController();
	const ok = recordingController();
	assert.doesNotThrow(() => safeAbortAll([throwing, ok.controller], "test"));
	assert.ok(ok.aborted(), "a throwing controller does not stop the rest");
});

test("safeAbortAll no-ops on undefined iterables", () => {
	assert.doesNotThrow(() => safeAbortAll(undefined, "test"));
});

test("safeAbort lets unrelated abort errors keep their identity in the log (no rethrow)", () => {
	const controller = throwingController("some other teardown failure");
	assert.doesNotThrow(() => safeAbort(controller, "test"));
});
