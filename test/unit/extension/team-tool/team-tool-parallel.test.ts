/**
 * Unit tests for team-tool parallel dispatch handler.
 * @see src/extension/team-tool/parallel-dispatch.ts
 *
 * NOTE: handleParallel is async and depends on discovery/config/state subsystems.
 * We test argument validation which runs before external deps are accessed.
 * Full integration testing requires file-system setup of teams/workflows.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleParallel } from "../../../../src/extension/team-tool/parallel-dispatch.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

// ─── handleParallel ───────────────────────────────────────────────────────────

describe("handleParallel", () => {
	// PROCESS-LEAK PREVENTION: the "defaults team to fast-fix" test below
	// passes validation (valid config.tasks + the fast-fix builtin team exists)
	// and actually spawns a REAL background-runner via spawnBackgroundTeamRun.
	// Without this, the spawned runner is daemonized (double-forked → parented by
	// init/systemd), so neither the test's `finally` cleanup nor the process
	// exit reaches it — it lingers until the 2h background-runner watchdog fires.
	// Setting PI_CREW_PARENT_PID makes the runner's startParentGuard() poll the
	// test process and self-terminate within 500ms of it exiting. Restored in
	// `after` so later test files in the same process are unaffected.
	const savedParentPid = process.env.PI_CREW_PARENT_PID;
	before(() => {
		process.env.PI_CREW_PARENT_PID = String(process.pid);
	});
	after(() => {
		if (savedParentPid === undefined) delete process.env.PI_CREW_PARENT_PID;
		else process.env.PI_CREW_PARENT_PID = savedParentPid;
	});

	it("returns error when config.tasks is missing", async () => {
		const tmp = createTrackedTempDir("parallel-test-");
		try {
			const res = await handleParallel(makeParams(), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("config.tasks"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error when config.tasks is empty array", async () => {
		const tmp = createTrackedTempDir("parallel-test-");
		try {
			const res = await handleParallel(makeParams({ config: { tasks: [] } }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("config.tasks"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error when config.tasks is not an array", async () => {
		const tmp = createTrackedTempDir("parallel-test-");
		try {
			const res = await handleParallel(makeParams({ config: { tasks: "not-array" } }), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("config.tasks"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns error for non-existent team", async () => {
		const tmp = createTrackedTempDir("parallel-test-");
		try {
			const res = await handleParallel(
				makeParams({
					config: {
						tasks: [{ goal: "do something" }],
						team: "nonexistent-team-xyz",
					},
				}),
				makeCtx(tmp),
			);

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("not found"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("defaults team to 'fast-fix' and surfaces per-task agent errors (no spawn)", async () => {
		const tmp = createTrackedTempDir("parallel-test-");
		try {
			// No `config.team` → defaults to the `fast-fix` builtin. A non-existent
			// agent makes spawnSingleTask return an error BEFORE reaching
			// spawnBackgroundTeamRun, so this exercises team-defaulting + discovery
			// + agent-validation WITHOUT spawning a real background-runner (the
			// process leak the previous version of this test caused).
			const res = await handleParallel(
				makeParams({
					config: {
						tasks: [
							{
								goal: "test goal",
								agent: "nonexistent-agent-xyz",
							},
						],
					},
				}),
				makeCtx(tmp),
			);

			const text = textFromToolResult(res);
			assert.ok(typeof text === "string");
			assert.ok(text.includes("nonexistent-agent-xyz"), `expected agent-not-found in result: ${text}`);
			assert.ok(text.includes("not found"), `expected "not found" marker: ${text}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
