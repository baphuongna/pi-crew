import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	registerHook,
	clearHooks,
	getHooks,
	executeHook,
} from "../../src/hooks/registry.ts";
import type { HookDefinition, HookContext } from "../../src/hooks/types.ts";

function makeCtx(overrides?: Partial<HookContext>): HookContext {
	return {
		runId: "test-run",
		cwd: "/tmp",
		...overrides,
	};
}

describe("registerHook / getHooks", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("registers and retrieves hooks by name", () => {
		const def: HookDefinition = {
			name: "before_run_start",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		};
		registerHook(def);
		const hooks = getHooks("before_run_start");
		assert.equal(hooks.length, 1);
		assert.equal(hooks[0]!.name, "before_run_start");
	});

	it("returns empty array for unregistered hook name", () => {
		assert.deepEqual(getHooks("before_task_start"), []);
	});

	it("registers multiple hooks for the same name", () => {
		registerHook({
			name: "before_run_start",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		});
		registerHook({
			name: "before_run_start",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		});
		assert.equal(getHooks("before_run_start").length, 2);
	});
});

describe("clearHooks", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("removes all registered hooks", () => {
		registerHook({
			name: "before_run_start",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		});
		registerHook({
			name: "after_run_complete",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		});
		clearHooks();
		assert.equal(getHooks("before_run_start").length, 0);
		assert.equal(getHooks("after_run_complete").length, 0);
	});
});

describe("executeHook", () => {
	beforeEach(() => {
		clearHooks();
	});

	it("returns allow when no hooks registered", async () => {
		const report = await executeHook("before_run_start", makeCtx());
		assert.equal(report.outcome, "allow");
		assert.equal(report.hookName, "before_run_start");
		assert.equal(report.durationMs, 0);
	});

	it("executes non-blocking hook and returns allow", async () => {
		registerHook({
			name: "before_task_start",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		});
		const report = await executeHook("before_task_start", makeCtx());
		assert.equal(report.outcome, "allow");
	});

	it("returns block when blocking hook returns block outcome", async () => {
		registerHook({
			name: "before_cancel",
			mode: "blocking",
			handler: () => ({ outcome: "block", reason: "not allowed" }),
		});
		const report = await executeHook("before_cancel", makeCtx());
		assert.equal(report.outcome, "block");
		assert.equal(report.reason, "not allowed");
	});

	it("captures durationMs > 0 for hooks", async () => {
		registerHook({
			name: "after_run_complete",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
		});
		const report = await executeHook("after_run_complete", makeCtx());
		assert.ok(typeof report.durationMs === "number");
		assert.ok(report.durationMs >= 0);
	});

	it("returns block when blocking hook handler throws", async () => {
		registerHook({
			name: "before_retry",
			mode: "blocking",
			handler: () => {
				throw new Error("hook crash");
			},
		});
		const report = await executeHook("before_retry", makeCtx());
		assert.equal(report.outcome, "block");
		assert.ok(report.reason?.includes("hook crash"));
	});

	it("returns diagnostic when non-blocking hook throws", async () => {
		registerHook({
			name: "after_task_complete",
			mode: "non_blocking",
			handler: () => {
				throw new Error("soft fail");
			},
		});
		const report = await executeHook("after_task_complete", makeCtx());
		assert.equal(report.outcome, "diagnostic");
		assert.ok(report.reason?.includes("soft fail"));
	});

	it("supports async hook handlers", async () => {
		registerHook({
			name: "before_run_start",
			mode: "non_blocking",
			handler: async () => {
				await new Promise((r) => setTimeout(r, 1));
				return { outcome: "allow" };
			},
		});
		const report = await executeHook("before_run_start", makeCtx());
		assert.equal(report.outcome, "allow");
	});

	it("filters hooks by workspaceId when ctx has workspaceId", async () => {
		registerHook({
			name: "before_run_start",
			mode: "non_blocking",
			handler: () => ({ outcome: "allow" }),
			workspaceId: "ws-A",
		});
		// Different workspace — should skip the hook
		const ctxB = makeCtx({ workspaceId: "ws-B" });
		const reportB = await executeHook("before_run_start", ctxB);
		assert.equal(reportB.outcome, "allow");
		assert.equal(reportB.durationMs, 0, "no hooks executed for mismatched workspace");

		// Same workspace — should execute the hook
		const ctxA = makeCtx({ workspaceId: "ws-A" });
		const reportA = await executeHook("before_run_start", ctxA);
		assert.equal(reportA.outcome, "allow");
		assert.ok(reportA.durationMs >= 0, "hook executed for matching workspace");
	});

	it("M-8: strips NFKC-confusable prototype-pollution keys from ctx", async () => {
		// Fullwidth 'o' (U+FF4F) NFKC-normalizes to ASCII 'o', so "__ｐroto__" must be
		// treated as "__proto__" and stripped. (Cyrillic o does NOT fold under NFKC —
		// only fullwidth/compatibility characters do. Regression for the missing
		// .normalize in the POLLUTED_KEYS lookup.)
		const maliciousKey = "__pr\uFF4Fto__";
		assert.notEqual(maliciousKey, "__proto__", "sanity: the confusable key is not ASCII __proto__");
		const ctx = { ...makeCtx(), [maliciousKey]: "evil" } as HookContext;
		let capturedKeys: string[] = [];
		registerHook({
			name: "before_run_start",
			mode: "non_blocking",
			handler: (c) => { capturedKeys = Object.keys(c); return { outcome: "allow" }; },
		});
		await executeHook("before_run_start", ctx);
		assert.ok(!capturedKeys.includes(maliciousKey), "NFKC-confusable __proto__ key must be stripped from ctx");
		assert.ok(!capturedKeys.includes("__proto__"), "ASCII __proto__ must also be stripped");
	});
});
