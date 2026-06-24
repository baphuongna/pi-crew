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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
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

test("HB-003a source contract: steer-backpressure branch does NOT call killProcessTree", () => {
	// The fix removed `killProcessTree(child.pid, child)` from both the
	// `!writeSucceeded` (backpressure) and the `else` (not-writable) branches.
	// A regression that reintroduces either call must fail this test.
	const steerBlock = sliceBetween(
		childPiSource,
		"// Inject steer via stdin to tell child to wrap up.",
		"// Hard abort",
	);
	assert.ok(steerBlock.length > 0, "steer-injection block must be locatable in child-pi.ts");

	// The block must STILL log the conditions (we kept the diagnostics)...
	assert.match(steerBlock, /steer-backpressure/, "backpressure log must remain");
	assert.match(steerBlock, /steer-not-writable/, "not-writable log must remain");

	// ...but must NOT kill the worker on either branch.
	const killCalls = steerBlock.match(/killProcessTree\(/g) ?? [];
	assert.equal(
		killCalls.length,
		0,
		`steer-injection block must NOT call killProcessTree (regression: HB-003a would recur). Found ${killCalls.length} call(s).`,
	);

	// And the rationale comment must be present so a future edit understands why.
	assert.match(
		steerBlock,
		/ADVISORY/i,
		"steer-injection block must document that steer is advisory (rationale for not killing)",
	);
});

test("HB-003a source contract: hard-abort at maxTurns + graceTurns still enforces the limit", () => {
	// The safety net for genuinely runaway workers is the hard-abort branch. It must
	// remain intact (it uses child.kill, not killProcessTree, which is fine).
	const hardAbortBlock = sliceBetween(
		childPiSource,
		"} else if (maxTurns !== undefined && softLimitReached",
		"// Hard abort",
	);
	assert.match(hardAbortBlock, /maxTurns\s*\+\s*\(graceTurns/, "hard-abort must key off maxTurns + graceTurns");
	// The hard-abort block ends at the comment; the child.kill call is on the
	// next line. Verify it follows. Use a window after the anchor that doesn't
	// depend on the em-dash (Windows encoding can mangle non-ASCII in source reads).
	const hardAbortIdx = childPiSource.indexOf("// Hard abort");
	const afterBlock = childPiSource.slice(hardAbortIdx, hardAbortIdx + 200);
	assert.match(afterBlock, /child\.kill/, "hard-abort must still terminate the worker");
});

// --- Optional real-binary smoke check (opt-in via PI_CREW_SMOKE=1) -----------------
// Skipped by default to avoid token cost in CI. Run manually with:
//   PI_CREW_SMOKE=1 npx tsx --test test/unit/child-pi-steer-backpressure.test.ts
test("HB-003a real-binary smoke: maxTurns:1 + disableTools returns exit 0 (5x)", { skip: process.env.PI_CREW_SMOKE !== "1" }, async () => {
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
