import test from "node:test";
import assert from "node:assert/strict";
import { registerHook, clearHooks, executeHook, getHooks } from "../../src/hooks/registry.ts";
import type { HookDefinition, HookResult } from "../../src/hooks/types.ts";

test("blocking hook can allow execution", async () => {
	try {
		registerHook({
			name: "before_run_start",
			mode: "blocking",
			handler: () => ({ outcome: "allow" } as HookResult),
		});
		const report = await executeHook("before_run_start", { runId: "test-1", cwd: "/tmp" });
		assert.equal(report.outcome, "allow");
	} finally {
		clearHooks();
	}
});

test("blocking hook can block execution", async () => {
	try {
		registerHook({
			name: "before_run_start",
			mode: "blocking",
			handler: () => ({ outcome: "block", reason: "test block" } as HookResult),
		});
		const report = await executeHook("before_run_start", { runId: "test-2", cwd: "/tmp" });
		assert.equal(report.outcome, "block");
		assert.equal(report.reason, "test block");
	} finally {
		clearHooks();
	}
});

test("non-blocking hook error records diagnostic and does not crash", async () => {
	try {
		registerHook({
			name: "before_task_start",
			mode: "non_blocking",
			handler: () => { throw new Error("hook crash"); },
		});
		const report = await executeHook("before_task_start", { runId: "test-3", taskId: "01_explore", cwd: "/tmp" });
		assert.equal(report.outcome, "diagnostic");
		assert.ok(report.reason?.includes("hook crash"));
	} finally {
		clearHooks();
	}
});

test("blocking hook error blocks the run", async () => {
	try {
		registerHook({
			name: "before_run_start",
			mode: "blocking",
			handler: () => { throw new Error("blocking hook crash"); },
		});
		const report = await executeHook("before_run_start", { runId: "test-4", cwd: "/tmp" });
		assert.equal(report.outcome, "block");
		assert.ok(report.reason?.includes("blocking hook crash"));
	} finally {
		clearHooks();
	}
});

test("modify hook updates context", async () => {
	try {
		registerHook({
			name: "before_task_start",
			mode: "non_blocking",
			handler: (ctx) => ({ outcome: "modify", data: { extraKey: "extra" } } as HookResult),
		});
		const ctx = { runId: "test-5", taskId: "01_explore", cwd: "/tmp" };
		const report = await executeHook("before_task_start", ctx);
		assert.equal(report.outcome, "allow");
		assert.equal((ctx as Record<string, unknown>).extraKey, "extra");
		assert.deepEqual(report.modifiedData, { extraKey: "extra" });
	} finally {
		clearHooks();
	}
});

test("no registered hooks returns allow", async () => {
	clearHooks();
	const report = await executeHook("before_run_start", { runId: "test-6", cwd: "/tmp" });
	assert.equal(report.outcome, "allow");
	assert.equal(report.durationMs, 0);
});

test("getHooks returns registered hooks by name", () => {
	try {
		const hook: HookDefinition = {
			name: "before_cancel",
			mode: "blocking",
			handler: () => ({ outcome: "allow" } as HookResult),
		};
		registerHook(hook);
		assert.equal(getHooks("before_cancel").length, 1);
		assert.equal(getHooks("before_run_start").length, 0);
	} finally {
		clearHooks();
	}
});
test("multiple non-blocking hooks all execute even when first throws", async () => {
	try {
		let secondHookRan = false;
		registerHook({
			name: "before_task_start",
			mode: "non_blocking",
			handler: () => { throw new Error("first hook crash"); },
		});
		registerHook({
			name: "before_task_start",
			mode: "non_blocking",
			handler: () => { secondHookRan = true; return { outcome: "allow" } as HookResult; },
		});
		const report = await executeHook("before_task_start", { runId: "test-7", taskId: "01_explore", cwd: "/tmp" });
		assert.equal(secondHookRan, true, "second hook should still execute after first hook throws");
		assert.equal(report.outcome, "diagnostic");
		assert.ok(report.reason?.includes("first hook crash"), "diagnostic reason should include first hook error");
	} finally {
		clearHooks();
	}
});

test("blocking hook in chain stops subsequent hooks", async () => {
	try {
		let secondHookRan = false;
		registerHook({
			name: "before_run_start",
			mode: "blocking",
			handler: () => ({ outcome: "block", reason: "first hook blocks" } as HookResult),
		});
		registerHook({
			name: "before_run_start",
			mode: "blocking",
			handler: () => { secondHookRan = true; return { outcome: "allow" } as HookResult; },
		});
		const report = await executeHook("before_run_start", { runId: "test-8", cwd: "/tmp" });
		assert.equal(secondHookRan, false, "second hook should not execute after blocking hook");
		assert.equal(report.outcome, "block");
		assert.equal(report.reason, "first hook blocks");
	} finally {
		clearHooks();
	}
});

test("no registered hooks report has no modifiedData", async () => {
	clearHooks();
	const report = await executeHook("before_run_start", { runId: "test-9", cwd: "/tmp" });
	assert.equal(report.outcome, "allow");
	assert.equal(report.modifiedData, undefined);
});
