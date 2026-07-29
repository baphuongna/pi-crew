#!/usr/bin/env -S npx tsx
/**
 * Tier 7 smoke (real-test-pi-crew): drive a REAL fast-fix team run via
 * handleRun() directly — bypasses the `team` tool (which the agent context
 * can't emit action='run' for). Exercises the live orchestration path that the
 * perf-batch changes touched: team-runner dispatch (Promise.all hooks,
 * saveCrewAgentsCoalesced, tasks.find→Map), event-log append (fsync best-effort
 * + F3a + rotation counter), crew-agent-records (path memo), child-pi
 * (BoundedTail), manifest-cache/state-store (cache-hit + resolveRunStateRoot memo).
 *
 * Usage:
 *   npx tsx scripts/smoke-team-perf.ts                  # real model run
 *   PI_TEAMS_MOCK_CHILD_PI=adaptive-plan npx tsx scripts/smoke-team-perf.ts  # fast/free mock
 */
import { handleRun } from "../src/extension/team-tool/run.ts";

const goal =
	"Smoke test: write the text 'pi-crew perf-batch smoke OK' to /tmp/pi-crew-perf-smoke.txt, " +
	"confirm the file exists with that exact content, and report the file path. " +
	"Keep it under 90 seconds; do NOT run any test or build commands.";

const ctx = { cwd: process.cwd() };
console.log("[smoke-team-perf] Launching fast-fix team run (real orchestration path)...");
console.log("[smoke-team-perf] cwd:", ctx.cwd);
const t0 = Date.now();
let result;
try {
	result = await handleRun({ action: "run", team: "fast-fix", workflow: "fast-fix", goal }, ctx);
} catch (error) {
	const ms = Date.now() - t0;
	console.error(`[smoke-team-perf] handleRun THREW after ${ms}ms:`, error);
	process.exit(1);
}
const ms = Date.now() - t0;
console.log(`\n[smoke-team-perf] Completed in ${(ms / 1000).toFixed(1)}s. isError=${result.isError}`);
console.log("=== RESULT details ===");
console.log(JSON.stringify(result.details, null, 2));
const text = result.content?.[0];
if (text && "text" in text) {
	console.log("\n=== SUMMARY ===");
	console.log(text.text);
}
process.exit(result.isError ? 1 : 0);
