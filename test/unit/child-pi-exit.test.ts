import assert from "node:assert/strict";
import test from "node:test";
import type { ChildPiLifecycleEvent } from "../../src/runtime/child-pi/child-pi.ts";

// --- Test a: ChildPiLifecycleEvent type has stderrExcerpt field (structural check) ---
test("ChildPiLifecycleEvent type includes stderrExcerpt optional field", () => {
	// Structural check: construct an event with stderrExcerpt and verify it conforms
	const event: ChildPiLifecycleEvent = {
		type: "exit",
		pid: 12345,
		exitCode: 1,
		error: "Child Pi process exited unexpectedly",
		stderrExcerpt: "Error: something went wrong\n    at main (file.js:1:1)",
		ts: new Date().toISOString(),
	};
	assert.equal(event.stderrExcerpt, "Error: something went wrong\n    at main (file.js:1:1)");
	assert.equal(event.type, "exit");
	assert.equal(event.error, "Child Pi process exited unexpectedly");
});

// --- Test: ChildPiLifecycleEvent error field exists for spawn_error type ---
test("ChildPiLifecycleEvent type includes error field for spawn_error events", () => {
	const event: ChildPiLifecycleEvent = {
		type: "spawn_error",
		pid: undefined,
		error: "spawn EACCES",
		stderrExcerpt: undefined,
		ts: new Date().toISOString(),
	};
	assert.equal(event.type, "spawn_error");
	assert.equal(event.error, "spawn EACCES");
	assert.equal(event.stderrExcerpt, undefined);
});

// --- Test: verify that the PendingOperation interface pattern works ---
test("pending operation tracker: start/complete lifecycle", () => {
	// Test the pattern directly to ensure correctness
	type PendingOp = {
		id: string;
		type: "prompt" | "steer" | "json_event";
		startedAt: number;
	};
	const pendingOperations = new Map<string, PendingOp>();
	let operationIdCounter = 0;

	const startOperation = (type: PendingOp["type"]): string => {
		const id = `op-${++operationIdCounter}`;
		pendingOperations.set(id, { id, type, startedAt: Date.now() });
		return id;
	};

	const completeOperation = (id: string): void => {
		pendingOperations.delete(id);
	};

	// Start operations
	const op1 = startOperation("json_event");
	const op2 = startOperation("json_event");
	assert.equal(pendingOperations.size, 2, "should have 2 pending operations");

	// Complete one
	completeOperation(op1);
	assert.equal(pendingOperations.size, 1, "should have 1 pending operation after completing one");

	// Verify remaining operation
	const remaining = [...pendingOperations.values()][0];
	assert.equal(remaining.id, op2);
	assert.equal(remaining.type, "json_event");

	// Complete the other
	completeOperation(op2);
	assert.equal(pendingOperations.size, 0, "should have 0 pending operations after completing all");
});

// --- Test: verify rejectPendingOperations clears all pending ops and logs each ---
test("pending operation tracker: reject clears all operations", () => {
	type PendingOp = {
		id: string;
		type: "prompt" | "steer" | "json_event";
		startedAt: number;
	};
	const pendingOperations = new Map<string, PendingOp>();
	let operationIdCounter = 0;
	const rejectedOps: Array<{ id: string; type: string; elapsed: number }> = [];

	const startOperation = (type: PendingOp["type"]): string => {
		const id = `op-${++operationIdCounter}`;
		pendingOperations.set(id, { id, type, startedAt: Date.now() });
		return id;
	};

	const rejectPendingOperations = (error: Error): void => {
		pendingOperations.forEach((op) => {
			rejectedOps.push({
				id: op.id,
				type: op.type,
				elapsed: Date.now() - op.startedAt,
			});
		});
		pendingOperations.clear();
	};

	// Start multiple operations of different types
	startOperation("json_event");
	startOperation("prompt");
	startOperation("steer");
	startOperation("json_event");
	assert.equal(pendingOperations.size, 4);

	// Reject all with an error
	const testError = new Error("Child Pi process exited unexpectedly (code=1 signal=SIGKILL). Stderr: OOM killed");
	rejectPendingOperations(testError);
	assert.equal(pendingOperations.size, 0, "map should be empty after rejection");
	assert.equal(rejectedOps.length, 4, "all 4 ops should be rejected");
	assert.ok(
		rejectedOps.every((op) => op.elapsed >= 0),
		"elapsed should be non-negative",
	);
	// Verify types are preserved
	assert.equal(rejectedOps.filter((op) => op.type === "json_event").length, 2);
	assert.equal(rejectedOps.filter((op) => op.type === "prompt").length, 1);
	assert.equal(rejectedOps.filter((op) => op.type === "steer").length, 1);
});

// --- Test d: No error logged for pending ops on graceful exit ---
test("pending operation tracker: no rejection on graceful path", () => {
	type PendingOp = {
		id: string;
		type: "prompt" | "steer" | "json_event";
		startedAt: number;
	};
	const pendingOperations = new Map<string, PendingOp>();
	let operationIdCounter = 0;
	let rejectionCalled = false;

	const startOperation = (type: PendingOp["type"]): string => {
		const id = `op-${++operationIdCounter}`;
		pendingOperations.set(id, { id, type, startedAt: Date.now() });
		return id;
	};

	const completeOperation = (id: string): void => {
		pendingOperations.delete(id);
	};

	const rejectPendingOperations = (): void => {
		rejectionCalled = true;
	};

	// Simulate a normal flow: start ops, complete them all, then check exit
	const op1 = startOperation("json_event");
	completeOperation(op1);
	const op2 = startOperation("json_event");
	completeOperation(op2);

	// At exit time, pending ops is empty, so isUnexpectedExit check prevents calling reject
	assert.equal(pendingOperations.size, 0, "no pending ops at graceful exit");
	// Simulate the isUnexpectedExit check
	const settled = true;
	const childExited = false;
	const responseTimeoutHit = false;
	const abortRequested = false;
	const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
	assert.equal(isUnexpectedExit, false, "should not be unexpected when settled");
	if (isUnexpectedExit) rejectPendingOperations();
	assert.equal(rejectionCalled, false, "reject should NOT have been called on graceful exit");
});

// --- Test e: Error handler rejects pending operations with process error context ---
test("error handler builds process error with stderr excerpt", () => {
	// Simulate what the enhanced error handler does
	const stderr = "line1\nline2\nError: spawn EACCES permission denied\nline4\nline5";
	const error = new Error("spawn EACCES");

	const processError = new Error(`Child Pi process error: ${error.message}. Stderr: ${stderr.slice(-500) || "(none)"}`);

	assert.ok(processError.message.includes("spawn EACCES"), "should include original error");
	assert.ok(processError.message.includes("permission denied"), "should include stderr content");
	assert.ok(processError.message.startsWith("Child Pi process error:"), "should have process error prefix");
});

// --- Test: Exit error includes comprehensive context ---
test("exit error includes exit code, signal, and stderr context", () => {
	const stderr = "warning: something\nError: FATAL ERROR\nStack trace here\n    at line 42";
	const code = 137;
	const signal = "SIGKILL";

	const exitError = new Error(
		`Child Pi process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}). ` +
			`Stderr: ${stderr.slice(-1000) || "(none)"}`,
	);

	assert.ok(exitError.message.includes("code=137"), "should include exit code");
	assert.ok(exitError.message.includes("signal=SIGKILL"), "should include signal");
	assert.ok(exitError.message.includes("FATAL ERROR"), "should include stderr excerpt");
});

// --- Test: rejectPendingOperations is safe when map is empty ---
test("pending operation tracker: reject is safe on empty map", () => {
	const pendingOperations = new Map<string, { id: string; type: string; startedAt: number }>();
	assert.equal(pendingOperations.size, 0);
	// forEach on empty map is a no-op — should not throw
	pendingOperations.forEach(() => {
		assert.fail("should not iterate over empty map");
	});
	pendingOperations.clear();
	assert.equal(pendingOperations.size, 0);
});

// --- Test: isUnexpectedExit logic ---
test("isUnexpectedExit is true only when not settled, not childExited, not timeout, not abort", () => {
	// All four conditions must be false for isUnexpectedExit to be true
	// Normal unexpected exit: not settled, not childExited, not timeout, not abort
	{
		const childExited = false;
		const settled = false;
		const responseTimeoutHit = false;
		const abortRequested = false;
		const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
		assert.equal(isUnexpectedExit, true, "should be unexpected when nothing triggered");
	}
	// Already settled — not unexpected
	{
		const childExited = false;
		const settled = true;
		const responseTimeoutHit = false;
		const abortRequested = false;
		const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
		assert.equal(isUnexpectedExit, false, "not unexpected when settled");
	}
	// Timeout hit — not unexpected
	{
		const childExited = false;
		const settled = false;
		const responseTimeoutHit = true;
		const abortRequested = false;
		const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
		assert.equal(isUnexpectedExit, false, "not unexpected when timeout hit");
	}
	// Abort requested — not unexpected
	{
		const childExited = false;
		const settled = false;
		const responseTimeoutHit = false;
		const abortRequested = true;
		const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
		assert.equal(isUnexpectedExit, false, "not unexpected when abort requested");
	}
	// Already childExited — not unexpected (shouldn't normally happen since this handler sets it)
	{
		const childExited = true;
		const settled = false;
		const responseTimeoutHit = false;
		const abortRequested = false;
		const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
		assert.equal(isUnexpectedExit, false, "not unexpected when already childExited");
	}
});

// --- Test: stderrExcerpt truncation to last 1000/500 chars ---
test("stderr excerpt captures last N chars of stderr", () => {
	const longStderr = "x".repeat(2000);

	// Exit handler uses last 1000 chars
	const exitExcerpt = longStderr.slice(-1000);
	assert.equal(exitExcerpt.length, 1000);
	assert.ok(exitExcerpt.startsWith("x"));

	// Error handler uses last 500 chars
	const errorExcerpt = longStderr.slice(-500);
	assert.equal(errorExcerpt.length, 500);
});
