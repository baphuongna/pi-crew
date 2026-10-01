/**
 * SDD-3 W-C WI-4 (G14): content-based budget reserve — red-first tests.
 *
 * Verified gap (upgrade plan 2026-09-29 §2 G14): dynamic-workflow-context.ts
 * reserved a FLAT `ESTIMATE = 4096` tokens per ctx.agent() call regardless of
 * the call's content. Consequences: short calls over-reserved (starving
 * concurrent siblings of budget headroom) and very long prompts under-reserved
 * (N concurrent calls could each blow far past the budget between reserve and
 * the post-run adjust).
 *
 * WI-4 replaces the flat constant with the real `estimateTokens(chars)`
 * heuristic exported from src/runtime/task-runner/prompt-builder.ts (:304,
 * chars/4 — the same in-tree estimator pre-execution.ts already uses), applied
 * to the call's prompt + systemPrompt, floored at 512 tokens for the fixed
 * per-call overhead not present in the prompt string. All BDG-2
 * reserve-then-adjust sites use the SAME computed value, so refund/adjust
 * stay consistent with what was reserved.
 *
 * Red-first: this file was written BEFORE the fix and failed on HEAD dc71198c
 * (test 1: a 40k-char prompt against an 8000-token budget was ALLOWED because
 * 4096 < 8000; test 2: a tiny prompt against a 2000-token budget was REFUSED
 * because 4096 > 2000). Evidence: sdd3-wc-x2/wi4-red-evidence.txt.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { makeWorkflowCtx } from "../../../../src/runtime/goal-workflow/dynamic-workflow-context.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function tmpCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-est-"));
}

function fakeManifest(cwd: string): TeamRunManifest {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		runId: "team_dwf_est_test",
		team: "dwf-est-test",
		goal: "test estimate",
		status: "running",
		workspaceMode: "single",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot: `${cwd}/.crew/state/runs/team_dwf_est_test`,
		artifactsRoot: `${cwd}/.crew/artifacts/team_dwf_est_test`,
		tasksPath: `${cwd}/.crew/state/runs/team_dwf_est_test/tasks.json`,
		eventsPath: `${cwd}/.crew/state/runs/team_dwf_est_test/events.jsonl`,
		artifacts: [],
	};
}

function withMockEnv<T>(fn: () => Promise<T> | T): Promise<T> | T {
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	return Promise.resolve(fn()).finally(() => {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
	});
}

/** ~40k-char prompt → estimateTokens(40000) = 10000 tokens (well past 4096). */
function longPrompt(): string {
	return `Analyze the following corpus thoroughly. ${"x".repeat(40_000)}`;
}

test("G14: long prompt reserves proportionally — an 8000-token budget refuses a 40k-char prompt before spawn", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		// estimateTokens(40k chars) = 10 000 > remaining 8 000 → must refuse.
		// On unfixed HEAD the flat ESTIMATE=4096 < 8000 let this call spawn.
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			tokenBudget: 8000,
		});
		await withMockEnv(async () => {
			const res = await ctx.agent({ role: "executor", prompt: longPrompt(), maxTurns: 1 });
			assert.equal(res.ok, false, "a prompt estimating ~10k tokens must not spawn against an 8000 budget");
			assert.match(res.error ?? "", /budget exhausted/);
			assert.equal(res.durationMs, 0, "refusal happens before any spawn");
			assert.equal(ctx.budget.spent(), 0, "a refused call must not touch spent");
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("G14: short prompt no longer over-reserves — a 2000-token budget allows a tiny prompt", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		// estimateTokens("hi") ≈ 1 → floored at 512 ≤ remaining 2000 → allowed.
		// On unfixed HEAD the flat ESTIMATE=4096 > 2000 refused this call even
		// though the real usage (mock reports input 10 + output 5) is tiny.
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			tokenBudget: 2000,
		});
		await withMockEnv(async () => {
			const res = await ctx.agent({ role: "executor", prompt: "hi", maxTurns: 1 });
			assert.equal(res.ok, true, `a tiny prompt must fit a 2000-token budget (error=${res.error ?? "none"})`);
			assert.equal(ctx.budget.spent(), 15, "post-adjust spent is the real usage (10+5), not the reserve");
			assert.equal(ctx.budget.remaining(), 2000 - 15);
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("G14: long vs short estimates differ by content (the flat 4096 is gone)", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		// Same 6000-token budget: the long prompt (~10k estimate) is refused,
		// the short one (~512 floor) is allowed. Under the flat ESTIMATE=4096
		// BOTH were allowed — content had no effect on the reserve.
		const ctxLong = makeWorkflowCtx(fakeManifest(cwd), {
			signal: new AbortController().signal,
			concurrency: 1,
			tokenBudget: 6000,
		});
		const ctxShort = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			tokenBudget: 6000,
		});
		await withMockEnv(async () => {
			const long = await ctxLong.agent({ role: "executor", prompt: longPrompt(), maxTurns: 1 });
			assert.equal(long.ok, false, "long prompt: ~10k estimate > 6000 budget → refuse");
			const short = await ctxShort.agent({ role: "executor", prompt: "hi", maxTurns: 1 });
			assert.equal(short.ok, true, `short prompt: ~512 estimate ≤ 6000 budget → allow (error=${short.error ?? "none"})`);
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("G14: reserve/refund consistency — a failed spawn un-reserves exactly the content-based estimate", async () => {
	const cwd = tmpCwd();
	try {
		const manifest = fakeManifest(cwd);
		const ctx = makeWorkflowCtx(manifest, {
			signal: new AbortController().signal,
			concurrency: 1,
			tokenBudget: 100_000,
		});
		// Long prompt (est ~10k) + mock WITHOUT PI_CREW_ALLOW_MOCK → exit 1.
		const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
		const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		delete process.env.PI_CREW_ALLOW_MOCK;
		try {
			const res = await ctx.agent({ role: "executor", prompt: longPrompt(), maxTurns: 1 });
			assert.equal(res.ok, false, "mock without PI_CREW_ALLOW_MOCK fails the spawn");
			assert.equal(ctx.budget.spent(), 0, "spawn failure must refund the WHOLE content-based reserve (no drift)");
		} finally {
			if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
			else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
			if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		}
		// And the success path on the SAME ctx: reserve/adjust nets to real usage.
		await withMockEnv(async () => {
			const res = await ctx.agent({ role: "executor", prompt: "short follow-up", maxTurns: 1 });
			assert.equal(res.ok, true, `follow-up success (error=${res.error ?? "none"})`);
			assert.equal(ctx.budget.spent(), 15, "success adjust nets reserve back out to real usage");
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
