/**
 * Regression test for HB-003a: ctx.agent({disableTools:true, maxTurns:1}) → exit null.
 *
 * Root cause (Phase-0): when maxTurns was reached on a turn_end event, the steer-
 * injection code treated a normal Node backpressure `stdin.write() === false` as a
 * fatal failure and called `killProcessTree(child.pid, child)` → SIGTERM. The worker
 * was killed mid-answer even though stdout already contained a valid answer.
 *
 * Phase-1 fix: steer injection is ADVISORY. On `write() === false` (backpressure)
 * OR a non-writable stdin, we log + let the hard-abort at maxTurns + graceTurns
 * handle genuinely runaway workers. No `killProcessTree` on the steer path.
 *
 * This test has two parts:
 *   1. Source-contract check: the steer-backpressure and steer-not-writable branches
 *      must NOT contain a `killProcessTree(` call. (Cheap, deterministic, catches
 *      regressions even without a real pi binary.)
 *   2. Real-binary smoke check (opt-in via PI_CREW_SMOKE=1): spawn a real pi with
 *      maxTurns:1 + disableTools and assert exit=0 + answer present, run 5×. Skipped
 *      in normal CI to avoid token cost.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const childPiSource = fs.readFileSync(path.join(repoRoot, "src/runtime/child-pi.ts"), "utf-8");

/** Slice the source between two anchor strings (inclusive of anchors). */
function sliceBetween(src: string, startAnchor: string, endAnchor: string): string {
	const start = src.indexOf(startAnchor);
	if (start < 0) throw new Error(`start anchor not found: ${startAnchor}`);
	const end = src.indexOf(endAnchor, start);
	if (end < 0) throw new Error(`end anchor not found: ${endAnchor}`);
	return src.slice(start, end + endAnchor.length);
}

test("HB-003a source contract: steer-injection does NOT call killProcessTree", () => {
	// C8: the soft-limit "wrap up" steer is now delivered by appending to the
	// steering JSONL file the child polls (PI_CREW_STEERING_FILE), not via stdin
	// (the child is spawned with stdio:["ignore",...], so child.stdin was null and
	// the old stdin branch was dead code that only spammed logs). The HB-003a
	// invariant still holds: the steer path must NOT kill the worker — the
	// hard-abort below (maxTurns + graceTurns) is the real enforcement.
	const steerBlock = sliceBetween(childPiSource, '// C8: deliver the "wrap up" advisory', "// Hard abort");
	assert.ok(steerBlock.length > 0, "steer-injection block must be locatable in child-pi.ts");

	// Delivered via the steering file, not stdin.
	assert.match(steerBlock, /input\.steeringFile/, "steer must be delivered via the steering file");
	assert.match(steerBlock, /appendFileSync/, "steer must append to the steering file");

	// Must NOT kill the worker on the steer path (regression guard for HB-003a).
	const killCalls = steerBlock.match(/killProcessTree\(/g) ?? [];
	assert.equal(
		killCalls.length,
		0,
		`steer-injection block must NOT call killProcessTree (regression: HB-003a would recur). Found ${killCalls.length} call(s).`,
	);

	// And the rationale comment must be present so a future edit understands why.
	assert.match(steerBlock, /Advisory only/i, "steer-injection block must document that steer is advisory (rationale for not killing)");
});

test("HB-003a source contract: hard-abort at maxTurns + graceTurns still enforces the limit", () => {
	// The safety net for genuinely runaway workers is the hard-abort branch. It must
	// remain intact. CP-1: the hard-abort now uses killProcessTree (same as the
	// abort/noResponseTimer paths) for SIGKILL escalation + process-group kill, and
	// sets a hardAbortInitiated flag so onJsonEvent stops restarting the no-response
	// timer (otherwise a SIGTERM-ignoring child that keeps emitting events never
	// times out). This is safe here because the hard-abort only fires after
	// maxTurns + graceTurns are fully exhausted — the worker is genuinely runaway,
	// unlike the steer-backpressure path (test above) where the worker may still
	// have a valid answer.
	const hardAbortBlock = sliceBetween(childPiSource, "} else if (maxTurns !== undefined && softLimitReached", "// Hard abort");
	assert.match(hardAbortBlock, /maxTurns\s*\+\s*\(graceTurns/, "hard-abort must key off maxTurns + graceTurns");
	// The hard-abort block ends at the comment; the killProcessTree call + flag
	// are on the following lines. Verify them in a window after the anchor.
	const hardAbortIdx = childPiSource.indexOf("// Hard abort");
	const afterBlock = childPiSource.slice(hardAbortIdx, hardAbortIdx + 300);
	assert.match(
		afterBlock,
		/killProcessTree/,
		"hard-abort must terminate the worker via killProcessTree (SIGKILL escalation + process-group kill)",
	);
	assert.match(afterBlock, /hardAbortInitiated/, "hard-abort must set the hardAbortInitiated flag to stop noResponseTimer restarts");
	// Verify the guard is applied at the event-handler sites.
	assert.match(
		childPiSource,
		/if \(!hardAbortInitiated\) restartNoResponseTimer\(\)/,
		"onJsonEvent/onStdoutLine must guard restartNoResponseTimer with hardAbortInitiated",
	);
});

// --- Optional real-binary smoke check (opt-in via PI_CREW_SMOKE=1) -----------------
// Skipped by default to avoid token cost in CI. Run manually with:
//   PI_CREW_SMOKE=1 npx tsx --test test/unit/child-pi-steer-backpressure.test.ts
test("HB-003a real-binary smoke: maxTurns:1 + disableTools returns exit 0 (5x)", {
	skip: process.env.PI_CREW_SMOKE !== "1",
}, async () => {
	const { runChildPi } = await import("../../src/runtime/child-pi.ts");
	const os = await import("node:os");
	let pass = 0;
	const fail = [] as string[];
	for (let i = 0; i < 5; i++) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `hb003a-smoke-`));
		try {
			const ac = new AbortController();
			const agent = {
				name: "executor",
				description: "t",
				source: "user" as const,
				filePath: "<t>",
				systemPrompt: "You are a test agent.",
				systemPromptMode: "replace" as const,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read", "bash"],
				disableTools: true,
			} as AgentConfig;
			const r = await runChildPi({
				cwd,
				task: `Reply with exactly: SMOKE-${i}`,
				agent,
				maxTurns: 1,
				signal: ac.signal,
				artifactsRoot: path.join(cwd, "art"),
				runId: `smoke-${i}`,
				role: "executor",
			});
			const ok = r.exitCode === 0 && (r.stdout ?? "").includes(`SMOKE-${i}`);
			if (ok) pass++;
			else fail.push(`run ${i}: exit=${r.exitCode} hasAnswer=${(r.stdout ?? "").includes(`SMOKE-${i}`)}`);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	}
	assert.equal(pass, 5, `Expected 5/5 pass; failures: ${fail.join("; ") || "(none)"}`);
});
