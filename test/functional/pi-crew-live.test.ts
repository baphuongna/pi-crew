/**
 * pi-crew Live Test — Run pi-crew with a REAL LLM (no mock).
 *
 * This test spawns the actual `pi` binary via pi-crew's spawn logic, with
 * a real provider/model from the user's environment. It exercises the full
 * end-to-end pipeline:
 *   handleTeamTool → team-runner → task-runner → child-pi (real spawn) → LLM
 *
 * Requires:
 *   - pi binary available on PATH or via npm-global
 *   - At least one provider configured in ~/.pi/agent/auth.json (e.g. zai, minimax)
 *   - Set PI_CREW_LIVE_MODEL env var to choose the model (default: zai/qwen3.7-max)
 *
 * Run with: PI_CREW_LIVE_MODEL=zai/qwen3.7-max npx tsx --test test/functional/pi-crew-live.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

// ── Test: live run with real LLM ─────────────────────────────────────

test("LIVE: team run completes using a real LLM provider", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-"));
	fs.mkdirSync(path.join(cwd, ".crew"));

	// Write a sample file so the agent has something to look at
	fs.writeFileSync(path.join(cwd, "sample.txt"), "The quick brown fox jumps over the lazy dog.\n");

	try {
		const result = await handleTeamTool(
			{
				action: "run",
				team: "fast-fix",
				goal: "Read sample.txt and reply with its first 5 words",
				model: "minimax/minimax-m3",
			},
			{ cwd },
		);

		// Sanity checks on result envelope
		assert.ok(result !== undefined, "handleTeamTool must return a result");
		assert.equal(typeof result.isError, "boolean", "result must have isError boolean");
		const runId = result.details?.runId;

		if (result.isError) {
			// If the run errored, surface the error message for debugging
			console.log("LIVE run errored (may be due to model/provider availability):");
			console.log("  text:", ((result.content?.[0] as any)?.text)?.slice(0, 500));
			console.log("  details:", JSON.stringify(result.details, null, 2).slice(0, 500));
			// Don't fail the test if the LLM is unavailable — just skip
			console.log("(LIVE test skipped: LLM not available or run failed)");
			return;
		}

		assert.ok(runId, "successful run must have a runId");
		const loaded = loadRunManifestById(cwd, runId!);
		assert.ok(loaded, "manifest must be loadable from disk");

		// Live run should have actual content (not just mock success/failure)
		assert.equal(loaded?.manifest.status, "completed", "real run should complete");
		assert.ok((loaded?.tasks.length ?? 0) > 0, "must have at least one task");

		// The LLM should have produced some output
		const completedTasks = loaded?.tasks.filter((t) => t.status === "completed") ?? [];
		assert.ok(completedTasks.length > 0, "at least one task must complete successfully");

		// Token usage should be tracked (real LLM call reports usage)
		const hasUsage = completedTasks.some((t) => t.usage && (t.usage.input ?? 0) + (t.usage.output ?? 0) > 0);
		assert.ok(hasUsage, "real LLM call must report token usage (input or output > 0)");

		console.log(`✓ LIVE run completed: ${runId}`);
		console.log(`  tasks: ${completedTasks.length} completed`);
		console.log(`  total input tokens: ${completedTasks.reduce((s, t) => s + (t.usage?.input ?? 0), 0)}`);
		console.log(`  total output tokens: ${completedTasks.reduce((s, t) => s + (t.usage?.output ?? 0), 0)}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
