/**
 * HB-004 smoke #2: ctx.agent() baseline — plain spawn returns the answer.
 *
 * This is the floor of the smoke harness: if this fails, every other agent
 * smoke test is meaningless. It also catches regressions where the spawn path
 * itself breaks (e.g. an argv/env change that makes pi exit non-zero before
 * producing output).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runChildPi } from "../../src/runtime/child-pi.ts";
import { SMOKE_ENABLED, SKIP_REASON, makeTmpCwd, fakeExecutorAgent, assertHasAnswer } from "./_helpers.ts";

test("smoke: ctx.agent() plain returns exit 0 + answer", { skip: SMOKE_ENABLED ? false : SKIP_REASON }, async () => {
	const { cwd, cleanup } = makeTmpCwd("agent-plain");
	try {
		const ac = new AbortController();
		const r = await runChildPi({
			cwd,
			task: "Reply with exactly: PLAIN-OK",
			agent: fakeExecutorAgent(),
			maxTurns: 2,
			signal: ac.signal,
			artifactsRoot: `${cwd}/art`,
			runId: "smoke-plain",
			role: "executor",
		});
		assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}. stderr: ${r.stderr.slice(-300)}`);
		assertHasAnswer(r.stdout, "PLAIN-OK", "plain agent");
	} finally {
		cleanup();
	}
});
