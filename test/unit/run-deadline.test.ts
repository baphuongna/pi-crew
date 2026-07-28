import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { PiTeamsConfig } from "../../src/config/config.ts";
import { DEFAULT_RUN_DEADLINE_MS, resolveRunDeadline } from "../../src/extension/team-tool/run-deadline.ts";

const realTmp = fs.realpathSync(os.tmpdir());

/** Minimal ctx satisfying `Pick<TeamContext, "cwd" | "signal">`. */
function makeCtx(cwd: string, signal?: AbortSignal): { cwd: string; signal?: AbortSignal } {
	return { cwd, signal };
}

test("resolveRunDeadline: params.timeoutMs takes highest priority over config and default", () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-params-"));
	const ctx = makeCtx(dir);
	const config: PiTeamsConfig = { limits: { maxRunMinutes: 60 } };
	const { deadlineMs } = resolveRunDeadline(ctx, { timeoutMs: 5000 }, config);
	assert.equal(deadlineMs, 5000);
});

test("resolveRunDeadline: config limits.maxRunMinutes used when no params.timeoutMs", () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-config-"));
	const ctx = makeCtx(dir);
	const config: PiTeamsConfig = { limits: { maxRunMinutes: 30 } };
	const { deadlineMs } = resolveRunDeadline(ctx, {}, config);
	assert.equal(deadlineMs, 30 * 60_000);
});

test("resolveRunDeadline: falls back to DEFAULT_RUN_DEADLINE_MS when config has no maxRunMinutes", () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-default-"));
	const ctx = makeCtx(dir);
	const config: PiTeamsConfig = {};
	const { deadlineMs } = resolveRunDeadline(ctx, {}, config);
	assert.equal(deadlineMs, DEFAULT_RUN_DEADLINE_MS);
	assert.equal(deadlineMs, 3_600_000);
});

test("resolveRunDeadline: abort signal fires after deadlineMs timeout", async () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-timeout-"));
	const ctx = makeCtx(dir);
	const { signal } = resolveRunDeadline(ctx, { timeoutMs: 50 }, { limits: { maxRunMinutes: 9999 } });
	assert.equal(signal.aborted, false);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(signal.aborted, true);
});

test("resolveRunDeadline: ctx.signal abort propagates to deadline signal", () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-propagate-"));
	const callerController = new AbortController();
	const ctx = makeCtx(dir, callerController.signal);
	const { signal } = resolveRunDeadline(ctx, { timeoutMs: 3_600_000 }, {});
	assert.equal(signal.aborted, false);
	callerController.abort();
	assert.equal(signal.aborted, true);
});

test("resolveRunDeadline: pre-aborted ctx.signal immediately aborts deadline signal", () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-pre-abort-"));
	const callerController = new AbortController();
	callerController.abort();
	const ctx = makeCtx(dir, callerController.signal);
	const { signal } = resolveRunDeadline(ctx, { timeoutMs: 3_600_000 }, {});
	assert.equal(signal.aborted, true);
});

test("resolveRunDeadline: returned controller allows linking additional parent signals", async () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-link-"));
	const ctx = makeCtx(dir);
	const { signal, controller } = resolveRunDeadline(ctx, { timeoutMs: 3_600_000 }, {});
	const parentController = new AbortController();
	// Simulate how the foreground-async path links a callback signal.
	if (parentController.signal.aborted) controller.abort();
	else parentController.signal.addEventListener("abort", () => controller.abort(), { once: true });
	assert.equal(signal.aborted, false);
	parentController.abort();
	assert.equal(signal.aborted, true);
});

test("resolveRunDeadline: no ctx.signal — deadline timer still works", async () => {
	const dir = fs.mkdtempSync(path.join(realTmp, "rd-no-ctx-signal-"));
	const ctx = makeCtx(dir); // no signal property
	const { signal } = resolveRunDeadline(ctx, { timeoutMs: 40 }, {});
	assert.equal(signal.aborted, false);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(signal.aborted, true);
});
