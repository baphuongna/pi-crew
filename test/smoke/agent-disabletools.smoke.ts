/**
 * HB-004 smoke #4: ctx.agent({disableTools, maxTurns:1}) returns exit 0.
 *
 * Regression guard for HB-003a (commit cb0fac4): the steer-injection path
 * killed the worker on normal stdin backpressure, so single-turn
 * disableTools agents returned exit null ~60% of the time. Runs 5× because
 * the bug was flaky (OS-buffer-dependent).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runChildPi } from "../../src/runtime/child-pi.ts";
import { fakeExecutorAgent, makeTmpCwd, SKIP_REASON, SMOKE_ENABLED } from "./_helpers.ts";

test("smoke: ctx.agent({disableTools:true, maxTurns:1}) returns exit 0 (5x, HB-003a regression)", {
	skip: SMOKE_ENABLED ? false : SKIP_REASON,
}, async () => {
	let pass = 0;
	const failures: string[] = [];
	for (let i = 0; i < 5; i++) {
		const { cwd, cleanup } = makeTmpCwd(`agent-dt-${i}`);
		try {
			const ac = new AbortController();
			const r = await runChildPi({
				cwd,
				task: `Reply with exactly: DT-OK-${i}`,
				agent: fakeExecutorAgent({ disableTools: true }),
				maxTurns: 1, // ← the trigger for HB-003a
				signal: ac.signal,
				artifactsRoot: `${cwd}/art`,
				runId: `smoke-dt-${i}`,
				role: "executor",
			});
			if (r.exitCode === 0 && r.stdout.includes(`DT-OK-${i}`)) {
				pass++;
			} else {
				failures.push(`run ${i}: exit=${r.exitCode} hasAnswer=${r.stdout.includes(`DT-OK-${i}`)}`);
			}
		} finally {
			cleanup();
		}
	}
	assert.equal(pass, 5, `HB-003a regression: expected 5/5 exit=0 with answer; failures: ${failures.join("; ") || "(none)"}`);
});
