import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CrashClass,
	type CrashClassificationInput,
	classifyProcessCrash,
} from "../../../../src/runtime/recovery/crash-classification.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function classify(partial: Partial<CrashClassificationInput>): CrashClass {
	return classifyProcessCrash(partial).crashClass;
}

// ─── all 9 classes ────────────────────────────────────────────────────────────

test("clean_exit: exit code 0", () => {
	const result = classifyProcessCrash({ exitCode: 0 });
	assert.equal(result.crashClass, "clean_exit");
	assert.match(result.reason, /cleanly/i);
});

test("non_zero_exit: exit code 1", () => {
	const result = classifyProcessCrash({ exitCode: 1 });
	assert.equal(result.crashClass, "non_zero_exit");
	assert.match(result.reason, /code 1/);
});

test("non_zero_exit: exit code 42", () => {
	assert.equal(classify({ exitCode: 42 }), "non_zero_exit");
});

test("signal_exit: SIGTERM", () => {
	const result = classifyProcessCrash({ signal: "SIGTERM", exitCode: null });
	assert.equal(result.crashClass, "signal_exit");
	assert.match(result.reason, /SIGTERM/);
});

test("signal_exit: SIGKILL", () => {
	assert.equal(classify({ signal: "SIGKILL", exitCode: null }), "signal_exit");
});

test("timeout: timedOut true", () => {
	const result = classifyProcessCrash({ timedOut: true, exitCode: null });
	assert.equal(result.crashClass, "timeout");
	assert.match(result.reason, /timed out/i);
});

test("cancelled: cancelled true", () => {
	const result = classifyProcessCrash({ cancelled: true, exitCode: null });
	assert.equal(result.crashClass, "cancelled");
	assert.match(result.reason, /cancel/i);
});

test("spawn_error: spawnError is an Error", () => {
	const result = classifyProcessCrash({ spawnError: new Error("ENOENT") });
	assert.equal(result.crashClass, "spawn_error");
	assert.match(result.reason, /ENOENT/);
});

test("spawn_error: spawnError is a string", () => {
	const result = classifyProcessCrash({ spawnError: "spawn failed" });
	assert.equal(result.crashClass, "spawn_error");
	assert.match(result.reason, /spawn failed/);
});

test("protocol_exit: exitCode null, no signal", () => {
	const result = classifyProcessCrash({ exitCode: null });
	assert.equal(result.crashClass, "protocol_exit");
	assert.match(result.reason, /protocol/);
});

test("native_panic: SIGSEGV in stderr with abnormal exit", () => {
	const result = classifyProcessCrash({
		exitCode: 139,
		signal: "SIGSEGV",
		stderrSnippet: "Segmentation fault (core dumped)",
	});
	assert.equal(result.crashClass, "native_panic");
	assert.match(result.reason, /segmentation fault/i);
});

test("native_panic: abort() in stderr", () => {
	const result = classifyProcessCrash({
		exitCode: 134,
		stderrSnippet: "pure virtual method called\nabort()",
	});
	assert.equal(result.crashClass, "native_panic");
	assert.match(result.reason, /abort/i);
});

test("native_panic: rust panic", () => {
	const result = classifyProcessCrash({
		exitCode: 101,
		stderrSnippet: "thread 'main' panicked at src/main.rs:42",
	});
	assert.equal(result.crashClass, "native_panic");
	assert.match(result.reason, /panic/i);
});

// ─── precedence / edge cases ─────────────────────────────────────────────────

test("precedence: timeout beats cancelled", () => {
	// When both are true, timeout wins (the timeout guard is the proximate cause).
	const result = classifyProcessCrash({
		timedOut: true,
		cancelled: true,
		exitCode: null,
	});
	assert.equal(result.crashClass, "timeout");
});

test("precedence: timeout beats spawn_error", () => {
	assert.equal(
		classify({
			timedOut: true,
			spawnError: new Error("x"),
			exitCode: null,
		}),
		"timeout",
	);
});

test("precedence: cancelled beats spawn_error", () => {
	assert.equal(
		classify({
			cancelled: true,
			spawnError: new Error("x"),
			exitCode: null,
		}),
		"cancelled",
	);
});

test("precedence: spawn_error beats native_panic", () => {
	assert.equal(
		classify({
			spawnError: new Error("EACCES"),
			exitCode: 1,
			stderrSnippet: "SIGSEGV",
		}),
		"spawn_error",
	);
});

test("precedence: native_panic beats plain signal_exit", () => {
	// With SIGSEGV in stderr AND signal set, native_panic wins over signal_exit.
	assert.equal(
		classify({
			exitCode: 139,
			signal: "SIGSEGV",
			stderrSnippet: "SIGSEGV",
		}),
		"native_panic",
	);
});

test("edge: null exitCode with killed flag → protocol_exit", () => {
	const result = classifyProcessCrash({ exitCode: null, killed: true });
	assert.equal(result.crashClass, "protocol_exit");
});

test("edge: clean exit (code 0) is never reclassified as native_panic even if stderr has SIGSEGV", () => {
	// A clean exit with stderr noise must stay clean_exit.
	assert.equal(classify({ exitCode: 0, stderrSnippet: "SIGSEGV somewhere" }), "clean_exit");
});

test("edge: signal present but exitCode is 0 → signal_exit (signal takes precedence)", () => {
	// gajae-code logic: signal is checked before exitCode===0.
	assert.equal(classify({ signal: "SIGTERM", exitCode: 0 }), "signal_exit");
});

test("edge: empty input object", () => {
	const result = classifyProcessCrash({});
	assert.equal(result.crashClass, "protocol_exit");
});

test("edge: undefined spawnError (not set) does not trigger spawn_error", () => {
	assert.equal(classify({ spawnError: undefined, exitCode: 0 }), "clean_exit");
});

test("edge: null spawnError does not trigger spawn_error", () => {
	assert.equal(classify({ spawnError: null, exitCode: 0 }), "clean_exit");
});

test("purity: same input yields same output (deterministic)", () => {
	const input: CrashClassificationInput = {
		exitCode: 1,
		signal: null,
		cancelled: false,
		timedOut: false,
	};
	const a = classifyProcessCrash(input);
	const b = classifyProcessCrash(input);
	assert.deepEqual(a, b);
});

test("purity: does not mutate input", () => {
	const input: CrashClassificationInput = {
		exitCode: 1,
		stderrSnippet: "abort()",
	};
	const snapshot = JSON.stringify(input);
	classifyProcessCrash(input);
	assert.equal(JSON.stringify(input), snapshot);
});

test("reason is always a non-empty string", () => {
	const inputs: Partial<CrashClassificationInput>[] = [
		{},
		{ exitCode: 0 },
		{ exitCode: 1 },
		{ signal: "SIGKILL" },
		{ timedOut: true },
		{ cancelled: true },
		{ spawnError: new Error("e") },
		{ exitCode: 134, stderrSnippet: "abort()" },
		{ exitCode: null },
	];
	for (const input of inputs) {
		const result = classifyProcessCrash(input);
		assert.ok(typeof result.reason === "string" && result.reason.length > 0, `empty reason for ${JSON.stringify(input)}`);
	}
});

test("native_panic detection is case-insensitive", () => {
	assert.equal(
		classify({
			exitCode: 139,
			stderrSnippet: "Fatal error: Segmentation Fault",
		}),
		"native_panic",
	);
});

test("double free detection", () => {
	assert.equal(
		classify({
			exitCode: 6,
			stderrSnippet: "free(): double free detected",
		}),
		"native_panic",
	);
});

test("no false positive native_panic from normal stderr with clean exit", () => {
	assert.equal(
		classify({
			exitCode: 0,
			stderrSnippet: "some warning about panic: handler not found",
		}),
		"clean_exit",
	);
});
